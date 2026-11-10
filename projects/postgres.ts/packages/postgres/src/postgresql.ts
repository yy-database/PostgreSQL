/** The `PostgreSQL` constructor: a local engine owner over the `.yyds`/`.yykv` storage. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { loadNative } from './native.ts';
import type { PostgresServerOptions, ServerAuth } from './server/server.ts';
import { PostgreSQLError, stateFailure, transportFailure } from './errors.ts';
import { resolveLocalOptions, type PostgreSQLListenOptions, type PostgreSQLOptions, type PostgreSQLQueryOptions, type PostgreSQLTransactionOptions } from './options.ts';
import {
    PostgreSQLOperations,
    type LocalState,
    type PostgreSQLCommandResult,
    type PostgreSQLResult,
    type PostgreSQLRow,
    type PostgreSQLSession,
    type PostgreSQLTransaction,
    type PostgreSQLValue,
} from './session.ts';

/** One application-network endpoint owned by a local instance. */
export interface PostgreSQLListener {
    /** The address the operating system bound, with the resolved port. */
    readonly endpoint: { host: string; port: number };
    /** Stops accepting connections and drains this listener's sessions. The engine stays open. */
    close(): Promise<void>;
}

/** One request awaiting its worker reply. */
interface PendingRequest {
    resolve: (value: { host: string; port: number }) => void;
    reject: (error: unknown) => void;
}

/**
 * Controls the engine assembly on its worker thread. The synchronous native
 * client blocks the main thread, so the engine's protocol loop must live on
 * another thread; this handle owns that thread and its endpoints.
 */
class EngineWorker {
    private readonly worker: Worker;
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 1;
    private dead: Error | null = null;

    constructor() {
        this.worker = new Worker(new URL('./engine-worker.js', import.meta.url));
        this.worker.on('message', (reply: { id: number; ok: boolean; host?: string; port?: number; message?: string }) => {
            const waiter = this.pending.get(reply.id);
            if (waiter === undefined) return;
            this.pending.delete(reply.id);
            if (reply.ok) waiter.resolve({ host: reply.host ?? '127.0.0.1', port: reply.port ?? 0 });
            else waiter.reject(new Error(reply.message ?? 'the engine worker refused the request'));
        });
        this.worker.on('error', (error) => {
            this.dead = error;
            for (const waiter of this.pending.values()) waiter.reject(error);
            this.pending.clear();
        });
    }

    open(dataDir: string, options: PostgresServerOptions): Promise<{ host: string; port: number }> {
        return this.request({ op: 'open', dataDir, options });
    }

    serve(key: string, options: PostgresServerOptions): Promise<{ host: string; port: number }> {
        return this.request({ op: 'serve', key, options });
    }

    closeEndpoint(key: string): Promise<void> {
        return this.request({ op: 'closeEndpoint', key }).then(() => undefined);
    }

    /** Releases the assembly and its lock, then ends the thread. */
    async close(): Promise<void> {
        if (this.dead === null) {
            try {
                await this.request({ op: 'close' });
            } catch {
                // A dead worker cannot release anything; termination still runs.
            }
        }
        await this.worker.terminate();
    }

    private request(payload: Record<string, unknown>): Promise<{ host: string; port: number }> {
        if (this.dead !== null) return Promise.reject(this.dead);
        const id = (this.nextId += 1);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, ...payload });
        });
    }
}

/**
 * A local PostgreSQL-semantics engine. Construction validates options only;
 * `open` locks the storage directory and starts the engine on its own thread.
 * Queries drive the engine through the protocol primitives of the platform
 * binding, exactly as a remote client would.
 */
export class PostgreSQL {
    private readonly config: { dataDir: string | undefined; database: string; user: string };
    private readonly ephemeral: boolean;
    private stateValue: LocalState = 'new';
    private opening: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private engine: EngineWorker | null = null;
    private internalPort = 0;
    private operations: PostgreSQLOperations | null = null;
    private listeners = new Map<string, { host: string; port: number; key: string }>();
    private listenerCounter = 0;
    private dataDir: string | null = null;

    constructor(options: PostgreSQLOptions = {}) {
        this.config = resolveLocalOptions(options);
        this.ephemeral = this.config.dataDir === undefined;
    }

    get state(): LocalState {
        return this.stateValue;
    }

    /** The database this instance opens. Defaults to `postgres`. */
    get database(): string {
        return this.config.database;
    }

    /** Locks the data directory and brings the engine up. Concurrent calls join one open. */
    async open(): Promise<void> {
        if (this.stateValue === 'open') return;
        if (this.opening !== null) return this.opening;
        if (this.stateValue !== 'new') throw stateFailure(`open is not available from state "${this.stateValue}"`);
        this.stateValue = 'opening';
        this.opening = this.doOpen().then(
            () => {
                this.stateValue = 'open';
                this.opening = null;
            },
            (error: unknown) => {
                this.stateValue = 'failed';
                this.opening = null;
                throw error;
            },
        );
        return this.opening;
    }

    async query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>> {
        return (await this.active()).query<R>(sql, params, options);
    }

    async execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult> {
        return (await this.active()).execute(sql, params);
    }

    async withSession<T>(fn: (session: PostgreSQLSession) => Promise<T>): Promise<T> {
        return (await this.active()).withSession(fn);
    }

    async transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>, options?: PostgreSQLTransactionOptions): Promise<T> {
        return (await this.active()).transaction(fn, options);
    }

    /** Opens the application network for remote clients against this same engine. */
    async listen(options: PostgreSQLListenOptions = {}): Promise<PostgreSQLListener> {
        const engine = this.engineForCall();
        const host = options.endpoint?.host ?? '127.0.0.1';
        const port = options.endpoint?.port ?? 0;
        if (port !== 0 && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
            throw new PostgreSQLError({
                code: '22023',
                message: 'listen endpoint.port must be an integer from 1 to 65535',
                phase: 'open',
                execution: 'not-sent',
                retry: 'never',
            });
        }
        const auth: ServerAuth = options.authentication ?? 'trust';
        const key = `listener-${(this.listenerCounter += 1)}`;
        let bound: { host: string; port: number };
        try {
            bound = await engine.serve(key, { host, port, auth, user: this.config.user, database: this.config.database });
        } catch (error) {
            throw transportFailure(error, 'open');
        }
        const record = { host: bound.host, port: bound.port, key };
        this.listeners.set(key, record);
        return {
            endpoint: { host: bound.host, port: bound.port },
            close: async () => {
                if (!this.listeners.has(key)) return;
                this.listeners.delete(key);
                if (this.engine === null) return;
                await this.engine.closeEndpoint(key);
            },
        };
    }

    /** Cascades: sessions, listeners, the internal endpoint, the engine and its lock. */
    close(): Promise<void> {
        if (this.stateValue === 'closed') return Promise.resolve();
        if (this.closing !== null) return this.closing;
        if (this.stateValue === 'new') {
            this.stateValue = 'closed';
            return Promise.resolve();
        }
        this.closing = this.doClose();
        return this.closing;
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    private async doOpen(): Promise<void> {
        const dataDir = this.config.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-engine-'));
        this.dataDir = dataDir;
        const engine = new EngineWorker();
        this.engine = engine;
        try {
            const internal = await engine.open(dataDir, {
                host: '127.0.0.1',
                port: 0,
                auth: 'trust',
                user: this.config.user,
                database: this.config.database,
            });
            this.internalPort = internal.port;
        } catch (error) {
            await engine.close();
            this.engine = null;
            if (this.ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
            throw transportFailure(error, 'open');
        }
        this.operations = new PostgreSQLOperations(
            loadNative(),
            { host: '127.0.0.1', port: this.internalPort, user: this.config.user, database: this.config.database },
            undefined,
        );
    }

    private async doClose(): Promise<void> {
        this.stateValue = 'closing';
        const failures: unknown[] = [];
        if (this.operations !== null) {
            try {
                await this.operations.close();
            } catch (error) {
                failures.push(error);
            }
            this.operations = null;
        }
        this.listeners = new Map();
        if (this.engine !== null) {
            try {
                await this.engine.close();
            } catch (error) {
                failures.push(error);
            }
            this.engine = null;
        }
        if (this.ephemeral && this.dataDir !== null) fs.rmSync(this.dataDir, { recursive: true, force: true });
        this.stateValue = 'closed';
        if (failures.length > 0) throw transportFailure(failures[0], 'close');
    }

    private async active(): Promise<PostgreSQLOperations> {
        if (this.stateValue !== 'open' || this.operations === null) {
            throw stateFailure(`the engine is not open (state "${this.stateValue}")`);
        }
        return this.operations;
    }

    private engineForCall(): EngineWorker {
        if (this.stateValue !== 'open' || this.engine === null) {
            throw stateFailure(`listen requires an open engine (state "${this.stateValue}")`);
        }
        return this.engine;
    }
}
