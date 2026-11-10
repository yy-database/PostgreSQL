/** Options shapes for the `PostgreSQL` and `PostgreSQLClient` constructors. */

import type { ServerAuth } from './server/server.ts';
import { configurationFailure } from './errors.ts';

/** The directory that owns one local engine's `.yyds`/`.yykv` files. */
export interface LocalStorage {
    directory: string;
}

export interface TcpEndpoint {
    host: string;
    port: number;
}

export interface PasswordAuth {
    username: string;
    password: string;
}

/** TLS settings are accepted in shape but rejected until the binding carries them. */
export interface TlsOptions {
    ca?: readonly Uint8Array[];
    serverName?: string;
    identity?: { certificate: Uint8Array; privateKey: Uint8Array };
}

export interface PoolOptions {
    min?: number;
    max?: number;
    maxPending?: number;
    acquireTimeoutMs?: number;
    idleTimeoutMs?: number;
}

export interface RequestOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Query options. `rowMode` "array" avoids the duplicate-label rule with positional rows. */
export interface PostgreSQLQueryOptions extends RequestOptions {
    rowMode?: 'object' | 'array';
}

export type PostgreSQLIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Transaction entry options, validated against the PostgreSQL-legal set. */
export interface PostgreSQLTransactionOptions {
    isolation?: PostgreSQLIsolationLevel;
    readOnly?: boolean;
}

/** Options for the local engine owner. Construction only validates; `open` acquires resources. */
export interface PostgreSQLOptions {
    /** Omitted means one private temporary directory removed on `close`. */
    storage?: LocalStorage;
    /** Database the instance opens. Defaults to `postgres`. */
    database?: string;
    /** Role the instance presents. Defaults to `postgres`. */
    user?: string;
}

/** `url` and `endpoint` are mutually exclusive; exactly one addresses the server. */
export type PostgreSQLClientOptions = (
    | { url: string; endpoint?: never }
    | { url?: never; endpoint: TcpEndpoint }
) & {
    database?: string;
    auth?: PasswordAuth;
    tls?: TlsOptions;
    pool?: PoolOptions;
    connectTimeoutMs?: number;
};

/** Where `listen` opens the application network and how it authenticates. */
export interface PostgreSQLListenOptions {
    endpoint?: TcpEndpoint;
    authentication?: ServerAuth;
}

/** The connection settings one `PostgreSQLClient` dials, after validation. */
export interface ResolvedClientSettings {
    host: string;
    port: number;
    user: string;
    database: string;
    password?: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_USER = 'postgres';

function isPositivePort(port: unknown): port is number {
    return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

/** Validates local options, returning the directory to lock or `undefined` for ephemeral storage. */
export function resolveLocalOptions(options: PostgreSQLOptions): { dataDir: string | undefined; database: string; user: string } {
    if (options.storage !== undefined) {
        const directory = options.storage.directory;
        if (typeof directory !== 'string' || directory.trim() === '') {
            throw configurationFailure('storage.directory must be a non-empty string');
        }
    }
    const database = options.database ?? DEFAULT_USER;
    const user = options.user ?? DEFAULT_USER;
    if (typeof database !== 'string' || database === '') throw configurationFailure('database must be a non-empty string');
    if (typeof user !== 'string' || user === '') throw configurationFailure('user must be a non-empty string');
    return { dataDir: options.storage?.directory, database, user };
}

/** Validates client options into the settings one native connection dials. */
export function resolveClientOptions(options: PostgreSQLClientOptions): ResolvedClientSettings {
    if (options.url !== undefined && options.endpoint !== undefined) {
        throw configurationFailure('url and endpoint are mutually exclusive');
    }
    if (options.tls !== undefined) {
        throw configurationFailure('tls is not available: the native binding has no TLS primitive yet');
    }
    if (options.url !== undefined) {
        const fromUrl = resolveUrl(options.url);
        if (options.auth !== undefined && (fromUrl.user !== DEFAULT_USER || fromUrl.password !== undefined)) {
            throw configurationFailure('url already carries credentials; auth must stay unset');
        }
        if (options.database !== undefined && fromUrl.database !== fromUrl.user) {
            throw configurationFailure('url already names a database; database must stay unset');
        }
        const auth = options.auth;
        return {
            ...fromUrl,
            ...(auth === undefined ? {} : { user: auth.username, password: auth.password }),
            ...(options.database === undefined ? {} : { database: options.database }),
        };
    }
    if (options.endpoint === undefined) {
        throw configurationFailure('one of url or endpoint is required');
    }
    const host = options.endpoint.host;
    if (typeof host !== 'string' || host === '') throw configurationFailure('endpoint.host must be a non-empty string');
    if (!isPositivePort(options.endpoint.port)) throw configurationFailure('endpoint.port must be an integer from 0 to 65535');
    const auth = options.auth;
    if (auth !== undefined && (typeof auth.username !== 'string' || auth.username === '' || typeof auth.password !== 'string')) {
        throw configurationFailure('auth must carry a non-empty username and a password string');
    }
    const user = auth?.username ?? DEFAULT_USER;
    const database = options.database ?? user;
    return {
        host,
        port: options.endpoint.port,
        user,
        database,
        ...(auth === undefined ? {} : { password: auth.password }),
    };
}

/** Parses one `postgresql://` or `postgres://` URL into connection settings. */
function resolveUrl(url: string): ResolvedClientSettings {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw configurationFailure(`cannot parse connection url: ${url}`);
    }
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
        throw configurationFailure(`unsupported connection url scheme "${parsed.protocol}"`);
    }
    if (parsed.search !== '' && parsed.search !== '?') {
        throw configurationFailure('connection url query parameters are not supported');
    }
    if (parsed.hostname === '') throw configurationFailure('connection url must name a host');
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (database.includes('/')) throw configurationFailure('connection url may name at most one database');
    const user = parsed.username === '' ? DEFAULT_USER : decodeURIComponent(parsed.username);
    return {
        host: parsed.hostname,
        port: parsed.port === '' ? DEFAULT_PORT : Number(parsed.port),
        user,
        database: database === '' ? user : database,
        ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    };
}
