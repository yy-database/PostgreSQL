/**
 * The protocol-v3 server: one native engine over a data directory.
 *
 * SQL parsing, planning, execution, the wire gateway, the data directory
 * layout and the `postmaster.pid` policy are all owned upstream by the
 * `postgres` facade. This module only validates options, maps them onto the
 * native `LocalEngine` and maps failures back into the family envelope.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadNative } from '../native.ts';
import { nativeCapabilityMissing, transportFailure } from '../errors.ts';

/**
 * Authentication the server offers.
 *
 * Only `trust` is available: the native gateway has no authentication or TLS
 * primitive yet, so a password or SCRAM request fails with
 * `native_capability_missing` instead of falling back to a local verifier.
 */
export type ServerAuth = 'trust' | { password: string } | { scram: true };

export interface PostgresServerOptions {
    /** Address to listen on. Defaults to `127.0.0.1`. Loopback only. */
    host?: string;
    /** Port to listen on. `0` picks a free port. Defaults to `0`. */
    port?: number;
    /** Database this engine reports. Defaults to `postgres`. */
    database?: string;
    /** Defaults to `trust`. */
    auth?: ServerAuth;
    /**
     * Directory that owns `local-0.yyds`, `local-0.yykv` and `postmaster.pid`.
     *
     * A second server started on the same directory fails its startup, and a
     * fresh temporary directory is used when this is omitted.
     */
    dataDir?: string;
}

export interface PostgresServerHandle {
    host: string;
    port: number;
    /** Directory the server locked for this run. */
    dataDir: string;
    /** Stops listening and releases the lock. */
    close(): Promise<void>;
}

/** Whether `host` names the loopback interface the native gateway accepts. */
export function isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Starts a protocol-v3 server that accepts real `psql` and `pg` clients. */
export async function startPostgresServer(options: PostgresServerOptions = {}): Promise<PostgresServerHandle> {
    const auth = options.auth ?? 'trust';
    if (auth !== 'trust') {
        throw nativeCapabilityMissing(
            'postgres.server.authentication',
            'the native gateway has no authentication primitive, pass auth "trust" or terminate authentication ahead of the engine',
        );
    }
    const host = options.host ?? '127.0.0.1';
    if (!isLoopbackHost(host)) {
        throw nativeCapabilityMissing(
            'postgres.server.remote_bind',
            'the native gateway accepts loopback listeners only until authentication and TLS land upstream',
        );
    }

    const ephemeral = options.dataDir === undefined;
    const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-data-'));
    const native = loadNative();
    let engine;
    try {
        engine = new native.LocalEngine({ dataDir, database: options.database ?? 'postgres' });
    } catch (error) {
        if (ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
        throw transportFailure(error, 'open');
    }

    try {
        const listener = engine.listen(host, options.port ?? 0);
        return {
            host: listener.host,
            port: listener.port,
            dataDir,
            close: async () => {
                engine.close();
                if (ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
            },
        };
    } catch (error) {
        engine.close();
        if (ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
        throw transportFailure(error, 'open');
    }
}
