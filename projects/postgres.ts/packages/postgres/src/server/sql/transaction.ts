/** Row locks, snapshots and deadlock detection shared by every session. */

import { ServerError } from '../errors.ts';

/** Isolation levels PostgreSQL accepts on input. `read uncommitted` behaves like `read committed`. */
export type IsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';

/** Behaviour of an isolation level, ignoring the two spellings that mean the same thing. */
export function snapshotIsolation(level: IsolationLevel): 'read committed' | 'repeatable read' | 'serializable' {
    return level === 'read uncommitted' ? 'read committed' : level;
}

export interface TransactionHandle {
    readonly id: number;
    readonly pid: number;
    readonly isolation: IsolationLevel;
    /** Commit counter frozen when the snapshot level runs its first statement. */
    snapshot: number;
}

/** Thrown when a statement must wait for a row another transaction holds locked. */
export class LockWait extends Error {
    readonly handle: TransactionHandle;
    readonly relOid: number;
    readonly key: string;

    constructor(handle: TransactionHandle, relOid: number, key: string) {
        super('lock wait');
        this.handle = handle;
        this.relOid = relOid;
        this.key = key;
    }
}

export interface WrittenRow {
    relOid: number;
    key: string;
}

interface RowLock {
    owner: number;
    waiters: number[];
}

function lockName(relOid: number, key: string): string {
    return `${relOid}:${key}`;
}

/**
 * The single writer-visible concurrency state of one server.
 *
 * Rows are locked when an `UPDATE`/`DELETE` touches an existing row and stay
 * locked until the owning transaction ends. A session that cannot get the lock
 * is parked through [`LockWait`] and resumed once the owner releases it.
 * Snapshot levels additionally reject writes to rows committed after their
 * snapshot with the same `40001` PostgreSQL uses.
 */
export class TransactionManager {
    private nextId = 1;
    private clock = 0;
    private readonly locks = new Map<string, RowLock>();
    private readonly held = new Map<number, Set<string>>();
    private readonly versions = new Map<string, number>();
    private readonly waitingFor = new Map<number, number>();
    private readonly resume = new Map<number, () => void>();
    private readonly pids = new Map<number, number>();

    begin(pid: number, isolation: IsolationLevel): TransactionHandle {
        const id = this.nextId;
        this.nextId += 1;
        this.held.set(id, new Set());
        this.pids.set(id, pid);
        return { id, pid, isolation, snapshot: this.clock };
    }

    /**
     * Freezes a snapshot level's view at its first statement.
     *
     * PostgreSQL does not take the snapshot at `BEGIN`: a commit that lands
     * between `BEGIN` and the first statement is visible to `REPEATABLE READ`.
     */
    takeSnapshot(handle: TransactionHandle): void {
        handle.snapshot = this.clock;
    }

    /**
     * Acquires the write lock of one existing row, parking the caller when another
     * transaction holds it. A wait that closes a cycle fails immediately with
     * `40P01`, like PostgreSQL's deadlock detector.
     */
    acquire(handle: TransactionHandle, relOid: number, key: string, relation: string, operation: 'update' | 'delete'): void {
        const name = lockName(relOid, key);
        if (snapshotIsolation(handle.isolation) !== 'read committed') {
            const version = this.versions.get(name) ?? 0;
            if (version > handle.snapshot) {
                throw new ServerError('40001', 'could not serialize access due to concurrent update');
            }
        }
        const lock = this.locks.get(name);
        if (lock === undefined) {
            this.locks.set(name, { owner: handle.id, waiters: [] });
            this.held.get(handle.id)?.add(name);
            return;
        }
        if (lock.owner === handle.id) return;
        if (lock.waiters.includes(handle.id)) throw new LockWait(handle, relOid, key);
        lock.waiters.push(handle.id);
        this.waitingFor.set(handle.id, lock.owner);
        if (this.closesCycle(handle.id)) {
            const error = this.deadlock(handle, relOid, key, relation, operation);
            this.unwait(handle.id, name);
            throw error;
        }
        throw new LockWait(handle, relOid, key);
    }

    /** Registers how a parked session resumes once its lock is handed over. */
    park(handle: TransactionHandle, resume: () => void): void {
        this.resume.set(handle.id, resume);
    }

    /** Publishes the row versions of one committing transaction and releases its locks. */
    commit(handle: TransactionHandle, written: WrittenRow[]): void {
        if (written.length > 0) {
            this.clock += 1;
            for (const row of written) this.versions.set(lockName(row.relOid, row.key), this.clock);
        }
        this.release(handle);
    }

    rollback(handle: TransactionHandle): void {
        this.release(handle);
    }

    /** Drops a parked session that will never resume and releases what it held. */
    forget(handle: TransactionHandle): void {
        for (const lock of this.locks.values()) lock.waiters = lock.waiters.filter((waiter) => waiter !== handle.id);
        this.waitingFor.delete(handle.id);
        this.resume.delete(handle.id);
        this.release(handle);
    }

    /** Releases every lock of a transaction and hands each one to its oldest waiter. */
    private release(handle: TransactionHandle): void {
        const keys = this.held.get(handle.id);
        this.held.delete(handle.id);
        this.pids.delete(handle.id);
        const waiting = this.resume.get(handle.id);
        if (waiting !== undefined) {
            this.resume.delete(handle.id);
            this.waitingFor.delete(handle.id);
        }
        if (keys === undefined) return;
        for (const name of keys) {
            const lock = this.locks.get(name);
            if (lock === undefined || lock.owner !== handle.id) continue;
            const waiter = lock.waiters.shift();
            if (waiter === undefined) {
                this.locks.delete(name);
                continue;
            }
            lock.owner = waiter;
            this.waitingFor.delete(waiter);
            this.held.get(waiter)?.add(name);
            const resume = this.resume.get(waiter);
            if (resume !== undefined) {
                this.resume.delete(waiter);
                setImmediate(resume);
            }
        }
    }

    /** Removes one parked request, used when the wait is abandoned or fails. */
    private unwait(id: number, name: string): void {
        const lock = this.locks.get(name);
        if (lock !== undefined) lock.waiters = lock.waiters.filter((waiter) => waiter !== id);
        this.waitingFor.delete(id);
        this.resume.delete(id);
    }

    /** Follows the `waits-for` chain from the owner back to the requester. */
    private closesCycle(requester: number): boolean {
        let cursor = this.waitingFor.get(requester);
        let guard = 0;
        while (cursor !== undefined && guard < 1024) {
            if (cursor === requester) return true;
            cursor = this.waitingFor.get(cursor);
            guard += 1;
        }
        return false;
    }

    /** Builds PostgreSQL's deadlock report, one line per waiting transaction in the cycle. */
    private deadlock(handle: TransactionHandle, relOid: number, key: string, relation: string, operation: 'update' | 'delete'): ServerError {
        const lines: string[] = [];
        let cursor: number | undefined = handle.id;
        let guard = 0;
        while (cursor !== undefined && guard < 1024) {
            const owner = this.waitingFor.get(cursor);
            if (owner === undefined) break;
            lines.push(
                `Process ${this.pids.get(cursor) ?? cursor} waits for ShareLock on transaction ${owner}; blocked by process ${this.pids.get(owner) ?? owner}.`,
            );
            if (owner === handle.id) break;
            cursor = owner;
            guard += 1;
        }
        const verb = operation === 'delete' ? 'deleting' : 'updating';
        return new ServerError(
            '40P01',
            'deadlock detected',
            lines.join('\n'),
            undefined,
            'See server log for query details.',
            `while ${verb} tuple (0,${Number(key) || 0}) in relation "${relation}"`,
        );
    }
}
