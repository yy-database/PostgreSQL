/** The `PostgreSQL` constructor: a local engine owner over the `.yyds`/`.yykv` storage. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadNative, type ListenerInfo, type LocalEngine } from './native.ts';
import type { ServerAuth } from './server/server.ts';
import { isLoopbackHost } from './server/server.ts';
import { PostgreSQLError, nativeCapabilityMissing, stateFailure, transportFailure } from './errors.ts';
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

/**
 * A local PostgreSQL-semantics engine. Construction validates options only;
 * `open` locks the storage directory and brings the native engine up. Queries
 * drive the engine through the protocol primitives of the platform binding,
 * exactly as a remote client would.
 */
export class PostgreSQL {
    private readonly config: { dataDir: string | undefined; database: string; user: string };
    private readonly ephemeral: boolean;
    private stateValue: LocalState = 'new';
    private opening: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private engine: LocalEngine | null = null;
    private internalPort = 0;
    private operations: PostgreSQLOperations | null = null;
    private listeners = new Map<number, ListenerInfo>();
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
        if (auth !== 'trust') {
            throw nativeCapabilityMissing(
                'postgres.server.authentication',
                'the native gateway has no authentication primitive, pass authentication "trust" or terminate authentication ahead of the engine',
            );
        }
        if (!isLoopbackHost(host)) {
            throw nativeCapabilityMissing(
                'postgres.server.remote_bind',
                'the native gateway accepts loopback listeners only until authentication and TLS land upstream',
            );
        }
        let bound: ListenerInfo;
        try {
            bound = engine.listen(host, port);
        } catch (error) {
            throw transportFailure(error, 'open');
        }
        this.listeners.set(bound.id, bound);
        return {
            endpoint: { host: bound.host, port: bound.port },
            close: async () => {
                if (!this.listeners.has(bound.id)) return;
                this.listeners.delete(bound.id);
                this.engine?.closeListener(bound.id);
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
        const native = loadNative();
        let engine: LocalEngine;
        try {
            engine = new native.LocalEngine({ dataDir, database: this.config.database });
        } catch (error) {
            if (this.ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
            throw transportFailure(error, 'open');
        }
        this.engine = engine;
        try {
            const internal = engine.listen('127.0.0.1', 0);
            this.internalPort = internal.port;
        } catch (error) {
            engine.close();
            this.engine = null;
            if (this.ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
            throw transportFailure(error, 'open');
        }
        this.operations = new PostgreSQLOperations(
            native,
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
                this.engine.close();
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

    private engineForCall(): LocalEngine {
        if (this.stateValue !== 'open' || this.engine === null) {
            throw stateFailure(`listen requires an open engine (state "${this.stateValue}")`);
        }
        return this.engine;
    }
}
