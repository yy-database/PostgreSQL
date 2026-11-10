/** Shared execution core for the `PostgreSQL` and `PostgreSQLClient` authoring surfaces. */

import type {
    Connection,
    ParamInfo,
    PostgresNative,
    PreparedStatement as NativePreparedStatement,
    TypedExecutionReport,
    TypedStatementResult,
} from './native.ts';
import { PostgreSQLError, serverFailure, stateFailure, transportFailure, type DatabasePhase } from './errors.ts';
import type { PostgreSQLQueryOptions, PostgreSQLTransactionOptions, PoolOptions } from './options.ts';

/** Lifecycle of a local engine owner. */
export type LocalState = 'new' | 'opening' | 'open' | 'closing' | 'closed' | 'failed';

/** Lifecycle of a remote connection owner. */
export type ClientState = 'new' | 'connecting' | 'ready' | 'reconnecting' | 'closing' | 'closed' | 'failed';

/** A bindable parameter cell. `Date`, objects and arrays are deliberately not accepted. */
export type PostgreSQLValue = null | string | number | bigint | boolean | Uint8Array;

/** One result column. `typeOid` is absent on portal paths that cannot observe it yet. */
export interface PostgreSQLColumn {
    name: string;
    typeOid?: number;
}

export type PostgreSQLRow = Record<string, unknown>;

/** One decoded row in positional form, for statements with repeated column labels. */
export type PostgreSQLArrayRow = unknown[];

/** Outcome of one statement that returns a row set. */
export interface PostgreSQLResult<R = PostgreSQLRow> {
    rows: readonly R[];
    columns: readonly PostgreSQLColumn[];
    /** First word of the `CommandComplete` tag, such as `SELECT` or `INSERT`. */
    command: string;
    /** Rows reported by the tag, or `null` when the tag carries no count. */
    rowCount: bigint | null;
}

/** Outcome of one command. PostgreSQL has no generic last-insert id; `RETURNING` goes through `query`. */
export interface PostgreSQLCommandResult {
    command: string;
    rowCount: bigint | null;
}

/** Options for one `iterate` cursor. */
export interface PostgreSQLIterateOptions {
    /** Rows requested per `Execute` round trip. Defaults to `100`. */
    batchSize?: number;
    rowMode?: 'object' | 'array';
}

/** A lazily pulled row cursor. Early `break` closes the underlying portal. */
export interface AsyncRowCursor<R> extends AsyncIterable<R> {
    next(): Promise<IteratorResult<R>>;
    return(): Promise<IteratorResult<R>>;
    close(): Promise<void>;
}

/** A native prepared statement bound to one session. Invalid when the session ends. */
export interface PostgreSQLPrepared {
    readonly statementName: string;
    columns(): readonly PostgreSQLColumn[];
    iterate(params?: readonly PostgreSQLValue[], options?: PostgreSQLIterateOptions): AsyncRowCursor<PostgreSQLRow | PostgreSQLArrayRow>;
    close(): Promise<void>;
}

/** One fixed session: temp tables, GUCs, prepared statements and transaction identity live here. */
export interface PostgreSQLSession {
    query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>>;
    execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult>;
    prepare(sql: string): Promise<PostgreSQLPrepared>;
    transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>, options?: PostgreSQLTransactionOptions): Promise<T>;
}

/** One open transaction. The callback runs exactly once; nested calls map to savepoints. */
export interface PostgreSQLTransaction {
    query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>>;
    execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult>;
    transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>): Promise<T>;
}

const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_BYTEA = 17;
const OID_FLOAT8 = 701;
const OID_BOOL = 16;
const DEFAULT_BATCH_SIZE = 100;
const ISOLATION_LEVELS = new Set(['read committed', 'repeatable read', 'serializable']);

let handleCounter = 0;

/** Encodes one authoring value into the extended protocol's text format plus a declared type OID. */
function encodeParameter(native: PostgresNative, value: PostgreSQLValue): { text: string | null; typeOid: number } {
    if (value === null || value === undefined) return { text: null, typeOid: 0 };
    if (typeof value === 'string') return { text: value, typeOid: 0 };
    if (typeof value === 'bigint') return { text: value.toString(), typeOid: OID_INT8 };
    if (typeof value === 'boolean') return { text: value ? 'true' : 'false', typeOid: OID_BOOL };
    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647) return { text: String(value), typeOid: OID_INT4 };
        if (Number.isInteger(value)) return { text: String(value), typeOid: OID_INT8 };
        return { text: String(value), typeOid: OID_FLOAT8 };
    }
    if (value instanceof Uint8Array) return { text: native.encodeBytea(Buffer.from(value)), typeOid: OID_BYTEA };
    throw new PostgreSQLError({
        code: '22023',
        message: `unsupported parameter value of type ${typeof value}`,
        phase: 'execute',
        execution: 'not-sent',
        retry: 'never',
    });
}

function encodeParams(native: PostgresNative, params: readonly PostgreSQLValue[] | undefined): { values: (string | null)[]; types: number[] } {
    const encoded = (params ?? []).map((parameter) => encodeParameter(native, parameter));
    return { values: encoded.map((parameter) => parameter.text), types: encoded.map((parameter) => parameter.typeOid) };
}

/** Decodes one text cell by the column's `RowDescription` type OID. */
function decodeCell(typeOid: number | undefined, value: string | null): unknown {
    if (value === null) return null;
    switch (typeOid) {
        case OID_INT8:
            return /^-?\d+$/.test(value) ? BigInt(value) : value;
        case OID_INT2:
        case OID_INT4:
            return /^-?\d+$/.test(value) ? Number(value) : value;
        case OID_BYTEA:
            return byteaFromText(value);
        case OID_NUMERIC:
            return value;
        default:
            return value;
    }
}

/** Reads the wire `bytea` hex format; anything else keeps its bytes verbatim. */
function byteaFromText(value: string): Uint8Array {
    if (/^\\x[0-9A-Fa-f]*$/.test(value)) {
        const hex = value.slice(2);
        const bytes = new Uint8Array(hex.length / 2);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        return bytes;
    }
    return new Uint8Array(Buffer.from(value, 'utf8'));
}

/** Splits a `CommandComplete` tag into its verb and row count. */
function parseTag(tag: string): { command: string; rowCount: bigint | null } {
    const parts = tag.trim().split(/\s+/).filter((part) => part !== '');
    const command = parts[0] ?? '';
    if (command === '') return { command: '', rowCount: null };
    if (command === 'INSERT') {
        const count = parts[2];
        return { command, rowCount: count !== undefined && /^\d+$/.test(count) ? BigInt(count) : null };
    }
    const last = parts[parts.length - 1];
    if (last !== undefined && /^\d+$/.test(last)) return { command, rowCount: BigInt(last) };
    return { command, rowCount: null };
}

/** Turns one typed extended result into rows and columns under the object/array rules. */
function buildRows(
    result: TypedStatementResult | undefined,
    rowMode: 'object' | 'array',
): { rows: unknown[]; columns: PostgreSQLColumn[] } {
    if (result === undefined) return { rows: [], columns: [] };
    const columns: PostgreSQLColumn[] = result.columns.map((column) => ({ name: column.name, typeOid: column.typeOid }));
    if (rowMode === 'array') {
        return { rows: result.rows.map((row) => row.values.map((value, index) => decodeCell(columns[index]?.typeOid, value))), columns };
    }
    const seen = new Set<string>();
    for (const column of columns) {
        if (seen.has(column.name)) {
            throw new PostgreSQLError({
                code: '42701',
                message: `duplicate column name "${column.name}"; alias the column or read rows with rowMode "array"`,
                phase: 'execute',
                execution: 'replied',
                retry: 'never',
            });
        }
        seen.add(column.name);
    }
    return {
        rows: result.rows.map((row) => {
            const record: Record<string, unknown> = {};
            row.values.forEach((value, index) => {
                const column = columns[index];
                record[column?.name ?? String(index)] = decodeCell(column?.typeOid, value);
            });
            return record;
        }),
        columns,
    };
}

function toResult<R>(report: TypedExecutionReport, rowMode: 'object' | 'array'): PostgreSQLResult<R> {
    const first = report.results[0];
    const { rows, columns } = buildRows(first, rowMode);
    const tag = parseTag(first?.tag ?? '');
    return { rows: rows as R[], columns, command: tag.command, rowCount: tag.rowCount };
}

function toCommandResult(report: TypedExecutionReport): PostgreSQLCommandResult {
    return parseTag(report.results[0]?.tag ?? '');
}

/** One native connection checked out of the pool, with the two ways to hand it back. */
interface Lease {
    connection: Connection;
    /** Returns a still-healthy connection to the pool. */
    release(): void;
    /** Closes a connection whose state is no longer trustworthy and frees its slot. */
    discard(): void;
}

interface Waiter {
    resolve: (lease: Lease) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout | null;
}

/** A small pool over the synchronous native connections. */
class ConnectionPool {
    private readonly native: PostgresNative;
    private readonly target: { host: string; port: number; user: string; database: string; password?: string };
    private readonly max: number;
    private readonly maxPending: number;
    private readonly acquireTimeoutMs: number;
    private readonly idle: Connection[] = [];
    private readonly waiters: Waiter[] = [];
    private inUse = 0;
    private closed = false;
    private draining: (() => void) | null = null;

    constructor(
        native: PostgresNative,
        target: { host: string; port: number; user: string; database: string; password?: string },
        pool: PoolOptions | undefined,
    ) {
        this.native = native;
        this.target = target;
        this.max = pool?.max ?? 10;
        this.maxPending = pool?.maxPending ?? 100;
        this.acquireTimeoutMs = pool?.acquireTimeoutMs ?? 10_000;
    }

    acquire(): Promise<Lease> {
        if (this.closed) return Promise.reject(stateFailure('the connection pool is closed'));
        const existing = this.idle.pop();
        if (existing !== undefined) {
            this.inUse += 1;
            return Promise.resolve(this.leaseFor(existing));
        }
        if (this.inUse < this.max) {
            this.inUse += 1;
            try {
                return Promise.resolve(this.leaseFor(this.native.connect(this.target)));
            } catch (error) {
                this.inUse -= 1;
                this.pumpDrain();
                return Promise.reject(error);
            }
        }
        if (this.waiters.length >= this.maxPending) {
            return Promise.reject(
                new PostgreSQLError({
                    code: '53400',
                    message: 'the connection pool is saturated',
                    phase: 'execute',
                    execution: 'not-sent',
                    retry: 'application-decision',
                }),
            );
        }
        return new Promise<Lease>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, timer: null };
            if (this.acquireTimeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(
                        new PostgreSQLError({
                            code: '53200',
                            message: 'timed out waiting for a pooled connection',
                            phase: 'execute',
                            execution: 'not-sent',
                            retry: 'application-decision',
                        }),
                    );
                }, this.acquireTimeoutMs);
                waiter.timer.unref();
            }
            this.waiters.push(waiter);
        });
    }

    close(): Promise<void> {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            if (waiter.timer !== null) clearTimeout(waiter.timer);
            waiter.reject(stateFailure('the connection pool is closed'));
        }
        for (const connection of this.idle.splice(0)) this.closeQuietly(connection);
        if (this.inUse === 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.draining = resolve;
        });
    }

    private leaseFor(connection: Connection): Lease {
        let handed = false;
        return {
            connection,
            release: () => {
                if (handed) return;
                handed = true;
                this.handBack(connection);
            },
            discard: () => {
                if (handed) return;
                handed = true;
                this.closeQuietly(connection);
                this.inUse -= 1;
                this.pumpDrain();
            },
        };
    }

    private handBack(connection: Connection): void {
        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
            if (waiter.timer !== null) clearTimeout(waiter.timer);
            waiter.resolve(this.leaseFor(connection));
            return;
        }
        if (this.closed) {
            this.closeQuietly(connection);
            this.inUse -= 1;
            this.pumpDrain();
            return;
        }
        this.idle.push(connection);
        this.inUse -= 1;
        this.pumpDrain();
    }

    private pumpDrain(): void {
        if (this.inUse === 0 && this.draining !== null) {
            const resolve = this.draining;
            this.draining = null;
            resolve();
        }
    }

    private closeQuietly(connection: Connection): void {
        try {
            connection.close();
        } catch {
            // A socket that is already gone needs no second goodbye.
        }
    }
}

/** One session pinned to a single connection, owned by `withSession` or by `transaction`. */
class PinnedSession implements PostgreSQLSession {
    readonly native: PostgresNative;
    private readonly lease: Lease;
    private active = true;
    private broken = false;
    private inTransaction = false;
    private openCursors = 0;

    constructor(native: PostgresNative, lease: Lease) {
        this.native = native;
        this.lease = lease;
    }

    async query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>> {
        return toResult(this.run(sql, params, 'execute'), options?.rowMode ?? 'object');
    }

    async execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult> {
        return toCommandResult(this.run(sql, params, 'execute'));
    }

    async prepare(sql: string): Promise<PostgreSQLPrepared> {
        this.assertActive();
        let statement: NativePreparedStatement;
        try {
            statement = this.connection().prepare(sql, []);
        } catch (error) {
            throw this.wrap(error);
        }
        return new NativePrepared(this, statement);
    }

    /** Runs one callback exactly once inside `BEGIN` … `COMMIT`; nested calls map to savepoints. */
    async transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>, options?: PostgreSQLTransactionOptions): Promise<T> {
        this.assertActive();
        if (this.inTransaction) {
            if (options?.isolation !== undefined || options?.readOnly !== undefined) {
                throw new PostgreSQLError({
                    code: '25001',
                    message: 'a nested transaction cannot restate isolation or read-only options; use the root transaction',
                    phase: 'execute',
                    execution: 'not-sent',
                    retry: 'never',
                });
            }
            return this.savepoint(fn);
        }
        this.run(beginStatement(options), [], 'execute');
        this.inTransaction = true;
        const tx = new TransactionView(this);
        try {
            const result = await fn(tx);
            tx.assertOpen();
            this.run('COMMIT', [], 'commit');
            return result;
        } catch (error) {
            this.rollbackQuietly();
            throw error;
        } finally {
            this.inTransaction = false;
            tx.close();
        }
    }

    /** Runs one statement on the pinned connection, mapping every failure into the envelope. */
    run(sql: string, params: readonly PostgreSQLValue[] | undefined, phase: DatabasePhase): TypedExecutionReport {
        this.assertActive();
        const encoded = encodeParams(this.native, params);
        let report: TypedExecutionReport;
        try {
            report = this.connection().executeWithParamsTyped(sql, encoded.values, encoded.types);
        } catch (error) {
            throw this.wrap(error);
        }
        if (report.error !== undefined && report.error !== null) throw serverFailure(report.error, phase);
        return report;
    }

    /** The live connection, only while the session scope is open. */
    connection(): Connection {
        this.assertActive();
        return this.lease.connection;
    }

    /** Maps a thrown binding failure and retires the connection when the outcome is unknown. */
    wrap(error: unknown): PostgreSQLError {
        const wrapped = error instanceof PostgreSQLError ? error : transportFailure(error, 'execute');
        if (wrapped.execution === 'unknown') this.broken = true;
        return wrapped;
    }

    assertActive(): void {
        if (!this.active) throw stateFailure('the session that owns this handle has ended');
    }

    /**
     * PostgreSQL drops named portals created outside a transaction block at
     * `Sync`, so a batched cursor runs inside one transaction for its lifetime.
     */
    beginCursorTransaction(): void {
        if (this.openCursors === 0) this.run('BEGIN', [], 'execute');
        this.openCursors += 1;
    }

    endCursorTransaction(): void {
        if (this.openCursors === 0) return;
        this.openCursors -= 1;
        if (this.openCursors === 0) {
            try {
                this.run('ROLLBACK', [], 'execute');
            } catch {
                // The portal's own failure outranks the goodbye.
            }
        }
    }

    /** Ends the scope: healthy connections return to the pool, broken ones are closed. */
    end(): void {
        if (!this.active) return;
        this.active = false;
        if (this.inTransaction || this.openCursors > 0) {
            this.openCursors = 0;
            this.rollbackQuietly();
            this.inTransaction = false;
        }
        if (this.broken) this.lease.discard();
        else this.lease.release();
    }

    private async savepoint<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>): Promise<T> {
        const name = `pgts_sp_${(handleCounter += 1)}`;
        this.run(`SAVEPOINT ${name}`, [], 'execute');
        const tx = new TransactionView(this);
        try {
            const result = await fn(tx);
            tx.assertOpen();
            this.run(`RELEASE SAVEPOINT ${name}`, [], 'commit');
            return result;
        } catch (error) {
            try {
                this.run(`ROLLBACK TO SAVEPOINT ${name}`, [], 'commit');
            } catch {
                // The caller's original failure is the one worth seeing.
            }
            throw error;
        } finally {
            tx.close();
        }
    }

    private rollbackQuietly(): void {
        if (this.broken) return;
        try {
            this.run('ROLLBACK', [], 'commit');
        } catch {
            this.broken = true;
        }
    }
}

/** A transaction view over one session; handles kept after the scope ends are inert. */
class TransactionView implements PostgreSQLTransaction {
    private readonly session: PinnedSession;
    private open = true;

    constructor(session: PinnedSession) {
        this.session = session;
    }

    async query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>> {
        this.assertOpen();
        return this.session.query<R>(sql, params, options);
    }

    async execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult> {
        this.assertOpen();
        return this.session.execute(sql, params);
    }

    async transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>): Promise<T> {
        this.assertOpen();
        return this.session.transaction(fn);
    }

    assertOpen(): void {
        if (!this.open) throw stateFailure('this transaction has already ended');
        this.session.assertActive();
    }

    close(): void {
        this.open = false;
    }
}

/** A native prepared statement wrapper with a lazily pulled portal cursor. */
class NativePrepared implements PostgreSQLPrepared {
    private readonly session: PinnedSession;
    private readonly statement: NativePreparedStatement;
    private closed = false;

    constructor(session: PinnedSession, statement: NativePreparedStatement) {
        this.session = session;
        this.statement = statement;
    }

    get statementName(): string {
        return this.statement.name();
    }

    columns(): readonly PostgreSQLColumn[] {
        this.assertUsable();
        return this.statement.columns().map((column) => ({ name: column.name }));
    }

    iterate(params?: readonly PostgreSQLValue[], options?: PostgreSQLIterateOptions): AsyncRowCursor<PostgreSQLRow | PostgreSQLArrayRow> {
        this.assertUsable();
        const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
        if (!Number.isInteger(batchSize) || batchSize < 1) {
            throw new PostgreSQLError({
                code: '22023',
                message: 'batchSize must be a positive integer',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
            });
        }
        return new PortalCursor(this.session, this.statement.name(), params ?? [], batchSize, options?.rowMode ?? 'object');
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            this.statement.close();
        } catch (error) {
            throw this.session.wrap(error);
        }
    }

    private assertUsable(): void {
        if (this.closed) throw stateFailure('this prepared statement is closed');
        this.session.assertActive();
    }
}

/**
 * A lazily pulled portal cursor: one `Execute` round trip fetches at most
 * `batchSize` rows and the portal stays open while the server suspends it.
 * The portal path cannot observe column type OIDs yet, so cells stay in
 * wire text form; `columns()` names come from the bound `Describe`.
 */
class PortalCursor implements AsyncRowCursor<PostgreSQLRow | PostgreSQLArrayRow> {
    private readonly session: PinnedSession;
    private readonly statementName: string;
    private readonly params: readonly PostgreSQLValue[];
    private readonly batchSize: number;
    private readonly rowMode: 'object' | 'array';
    private portal: string | null = null;
    private columns: string[] = [];
    private queue: (string | null)[][] = [];
    private done = false;
    private txHeld = false;

    constructor(session: PinnedSession, statementName: string, params: readonly PostgreSQLValue[], batchSize: number, rowMode: 'object' | 'array') {
        this.session = session;
        this.statementName = statementName;
        this.params = params;
        this.batchSize = batchSize;
        this.rowMode = rowMode;
    }

    async next(): Promise<IteratorResult<PostgreSQLRow | PostgreSQLArrayRow>> {
        if (this.done && this.queue.length === 0) return { done: true, value: undefined as never };
        while (this.queue.length === 0 && !this.done) await this.pull();
        const values = this.queue.shift();
        if (values === undefined) return { done: true, value: undefined as never };
        if (this.rowMode === 'array') return { done: false, value: [...values] };
        const record: Record<string, unknown> = {};
        values.forEach((value, index) => {
            record[this.columns[index] ?? String(index)] = value;
        });
        return { done: false, value: record };
    }

    async close(): Promise<void> {
        this.dropPortal();
        this.done = true;
        this.queue = [];
    }

    /** `for await … break` lands here: the portal closes instead of outliving the loop. */
    async return(): Promise<IteratorResult<PostgreSQLRow | PostgreSQLArrayRow>> {
        await this.close();
        return { done: true, value: undefined as never };
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    [Symbol.asyncIterator](): AsyncIterator<PostgreSQLRow | PostgreSQLArrayRow> {
        return this;
    }

    /** Fetches the next batch, binding a fresh named portal on first use. */
    private async pull(): Promise<void> {
        const encoded = encodeParams(this.session.native, this.params);
        const paramInfos: ParamInfo[] = encoded.values.map((value) => ({
            format: 0,
            ...(value === null ? {} : { value: Buffer.from(value, 'utf8') }),
        }));
        try {
            if (this.portal === null) {
                this.session.beginCursorTransaction();
                this.txHeld = true;
                this.portal = `pgts_cursor_${(handleCounter += 1)}`;
                const info = this.session.connection().bindPortal(this.statementName, this.portal, paramInfos, []);
                this.columns = info.columns.map((column) => column.name);
            }
            const report = this.session.connection().executePortal(this.portal, this.batchSize);
            for (const result of report.results) for (const row of result.rows) this.queue.push(row.values);
            if (!report.suspended) {
                this.dropPortal();
                this.done = true;
            }
        } catch (error) {
            this.dropPortal();
            this.done = true;
            throw this.session.wrap(error);
        }
    }

    private dropPortal(): void {
        if (this.portal !== null) {
            const name = this.portal;
            this.portal = null;
            try {
                this.session.connection().closePortal(name);
            } catch {
                // The portal dies with the session; a failed goodbye is not the caller's error.
            }
        }
        if (this.txHeld) {
            this.txHeld = false;
            this.session.endCursorTransaction();
        }
    }
}

function beginStatement(options: PostgreSQLTransactionOptions | undefined): string {
    const parts = ['BEGIN'];
    if (options?.isolation !== undefined) {
        if (!ISOLATION_LEVELS.has(options.isolation)) {
            throw new PostgreSQLError({
                code: '22023',
                message: `unsupported isolation level "${options.isolation}"`,
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
            });
        }
        parts.push(`ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
    }
    if (options?.readOnly !== undefined) parts.push(options.readOnly ? 'READ ONLY' : 'READ WRITE');
    return parts.join(' ');
}

/** The pooled operations shared by the local root object and the remote client. */
export class PostgreSQLOperations {
    private readonly native: PostgresNative;
    private readonly pool: ConnectionPool;

    constructor(native: PostgresNative, target: { host: string; port: number; user: string; database: string; password?: string }, pool: PoolOptions | undefined) {
        this.native = native;
        this.pool = new ConnectionPool(native, target, pool);
    }

    async query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>> {
        this.assertRequestOptions(options);
        const session = await this.pin('execute');
        try {
            return await session.query<R>(sql, params, options);
        } finally {
            session.end();
        }
    }

    async execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult> {
        const session = await this.pin('execute');
        try {
            return await session.execute(sql, params);
        } finally {
            session.end();
        }
    }

    async withSession<T>(fn: (session: PostgreSQLSession) => Promise<T>): Promise<T> {
        const session = await this.pin('execute');
        try {
            return await fn(session);
        } finally {
            session.end();
        }
    }

    async transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>, options?: PostgreSQLTransactionOptions): Promise<T> {
        const session = await this.pin('execute');
        try {
            return await session.transaction(fn, options);
        } finally {
            session.end();
        }
    }

    /** One `SELECT 1` round trip that proves the pool can serve requests. */
    async probe(): Promise<void> {
        const session = await this.pin('connect');
        try {
            session.run('SELECT 1', [], 'connect');
        } finally {
            session.end();
        }
    }

    async close(): Promise<void> {
        await this.pool.close();
    }

    private async pin(phase: DatabasePhase): Promise<PinnedSession> {
        let lease: Lease;
        try {
            lease = await this.pool.acquire();
        } catch (error) {
            throw error instanceof PostgreSQLError ? error : transportFailure(error, phase);
        }
        return new PinnedSession(this.native, lease);
    }

    private assertRequestOptions(options: PostgreSQLQueryOptions | undefined): void {
        if (options?.signal !== undefined || options?.timeoutMs !== undefined) {
            throw new PostgreSQLError({
                code: '0A000',
                message: 'per-request cancellation and timeouts are not enforced by the synchronous native binding yet',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
            });
        }
    }
}
