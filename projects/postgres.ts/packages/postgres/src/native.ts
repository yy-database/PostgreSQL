// Resolves the platform addon through the optional dependency, or a sibling
// platform package directory on a plain checkout. `package.json#main` owns the
// `.node` filename — callers never concatenate it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type PlatformKey = 'win32-x64' | 'linux-x64' | 'darwin-x64' | 'darwin-arm64';

/** Where one connection goes and which identity it presents. */
export interface ClientOptions {
    host: string;
    port: number;
    user: string;
    database: string;
}

/** The `pid` and `secret key` from `BackendKeyData`, needed for `CancelRequest`. */
export interface BackendKeyDataInfo {
    processId: number;
    secretKey: number;
}

/** One column of a result set. */
export interface ColumnInfo {
    name: string;
}

/** One row. `null` inside `values` is a SQL `NULL` cell. */
export interface DataRow {
    values: (string | null)[];
}

/** Everything one statement returned. */
export interface StatementResult {
    columns: ColumnInfo[];
    rows: DataRow[];
    tag: string;
}

/** One decoded server error. */
export interface ServerErrorInfo {
    code: string;
    message: string;
}

/** One `ErrorResponse` or `NoticeResponse` field, kept in wire order. */
export interface MessageFieldInfo {
    /** One-byte selector from the protocol, such as `C` or `P`. */
    kind: string;
    value: string;
}

/** A server error together with every field the server sent, in wire order. */
export interface ErrorInfo {
    code: string;
    message: string;
    fields: MessageFieldInfo[];
}

/** One `NoticeResponse` the server emitted while a statement ran. */
export interface NoticeInfo {
    fields: MessageFieldInfo[];
}

/** Outcome of one simple-query batch. */
export interface ExecutionReport {
    /** Every statement that finished before the batch stopped. */
    results: StatementResult[];
    /** The failure that stopped the batch, or `null` when every statement ran. */
    error: ErrorInfo | null;
    /** Every notice in wire order. */
    notices: NoticeInfo[];
}

/** Outcome of one `COPY ... FROM STDIN` round trip. */
export interface CopyInReport {
    /** `CommandComplete` tag, such as `COPY 2`. */
    tag: string;
    /** The server error that stopped the copy, or `null` when it finished. */
    error: ErrorInfo | null;
    notices: NoticeInfo[];
}

/** Outcome of one `COPY ... TO STDOUT` round trip. */
export interface CopyOutReport {
    /** Every `CopyData` payload concatenated in wire order. */
    data: Buffer;
    tag: string;
    /** The server error that stopped the copy, or `null` when it finished. */
    error: ErrorInfo | null;
    notices: NoticeInfo[];
}

/** One decoded `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse`. */
export interface CopyResponseInfo {
    /** `0` for text and `1` for binary. */
    format: number;
    columns: number;
    columnFormats: number[];
}

/** One bound parameter: a format code plus an optional payload. */
export interface ParamInfo {
    /** `0` for text and `1` for binary. */
    format: number;
    /** Omitted or `undefined` binds SQL `NULL`. */
    value?: Buffer;
}

/** One named portal bound to a prepared statement. */
export interface PortalInfo {
    name: string;
    /** Parameter OIDs the statement resolved. */
    parameters: number[];
    columns: ColumnInfo[];
}

/** One `Execute` round trip on a portal. */
export interface PortalExecReport {
    /** Rows produced by this batch. */
    results: StatementResult[];
    /** `true` when the server stopped at the row limit with rows still waiting. */
    suspended: boolean;
}

/** One named prepared statement on a live connection. */
export interface PreparedStatement {
    name(): string;
    /** Parameter OIDs the server resolved, in declaration order. */
    parameters(): number[];
    /** Columns the statement returns; empty when it returns no row set. */
    columns(): ColumnInfo[];
    isClosed(): boolean;
    execute(params: (string | null)[]): StatementResult[];
    close(): void;
}

/** One socket in the protocol-v3 simple and extended query modes. */
export interface Connection {
    execute(sql: string): StatementResult[];
    /** Runs one batch, keeping the statements that finished before the error. */
    executeReport(sql: string): ExecutionReport;
    /** Drains every notice received by `execute` calls so far, in wire order. */
    takeNotices(): NoticeInfo[];
    /** `BackendKeyData` from startup, or `null` when the server skipped it. */
    backendKeyData(): BackendKeyDataInfo | null;
    /** Sends a `CancelRequest` on a fresh socket; the main socket stays usable. */
    cancel(): void;
    executeWithParams(sql: string, params: (string | null)[], types: number[]): StatementResult[];
    /** Runs one statement with explicit text or binary parameters and result formats. */
    executeWithParamFormats(
        sql: string,
        params: ParamInfo[],
        types: number[],
        resultFormats: number[],
    ): StatementResult[];
    prepare(sql: string, types: number[]): PreparedStatement;
    executePrepared(name: string, params: (string | null)[]): StatementResult[];
    /** Executes a prepared statement with explicit parameter and result formats. */
    executePreparedFormats(name: string, params: ParamInfo[], resultFormats: number[]): StatementResult[];
    closePrepared(name: string): void;
    /** Binds a named portal so it can be executed more than once. */
    bindPortal(statement: string, portal: string, params: ParamInfo[], resultFormats: number[]): PortalInfo;
    /** Executes an open portal; `maxRows` of `0` runs it to completion. */
    executePortal(portal: string, maxRows: number): PortalExecReport;
    closePortal(name: string): void;
    /** Streams `chunks` as `COPY ... FROM STDIN` data for one statement. */
    copyIn(sql: string, chunks: Buffer[]): CopyInReport;
    /** Collects every `CopyData` payload of one `COPY ... TO STDOUT` statement. */
    copyOut(sql: string): CopyOutReport;
    close(): void;
}

/** One stored row. */
export interface StoreRow {
    key: Buffer;
    value: Buffer;
}

/** One durable `.yyds`/`.yykv` store handle. */
export interface Store {
    put(namespace: string, key: Buffer, value: Buffer): void;
    get(namespace: string, key: Buffer): Buffer | null;
    delete(namespace: string, key: Buffer): boolean;
    keys(namespace: string, prefix: Buffer): Buffer[];
    scan(namespace: string, prefix: Buffer): StoreRow[];
    namespaces(): string[];
    len(namespace: string): number;
    flush(namespace: string): number;
    dataDir(): string;
    shardPath(): string;
    catalogPath(): string;
}

/** One mutation inside a `ServerStore` commit batch. */
export interface ServerStoreChange {
    kind: 'put' | 'delete';
    namespace: string;
    key: Buffer;
    /** Required for `put`, omitted for `delete`. */
    value?: Buffer;
}

/** One durable server data directory: `.yyds` catalog, `.yykv` shard and lock. */
export interface ServerStore {
    scan(namespace: string, prefix: Buffer, after: Buffer | null, before: Buffer | null, limit: number): StoreRow[];
    /**
     * Flat transfer form of `scan`: `u32le` row count, then per row `u32le`
     * key length, `u32le` value length, key bytes, value bytes. Same rows, same
     * order, one boundary crossing instead of per-row objects.
     */
    scanFlat(namespace: string, prefix: Buffer, after: Buffer | null, before: Buffer | null, limit: number): Buffer;
    commitChanges(changes: ServerStoreChange[]): void;
    close(): void;
    durableAtomicCommit(): boolean;
    dataDir(): string;
    shardPath(): string;
    catalogPath(): string;
    lockPath(): string;
}

/** Effective `psql` options, as normalized by the binding. */
export interface CommandOptions extends ClientOptions {
    sql: string;
    headers: boolean;
    separator: string;
    nullValue: string;
}

/** Median/p95/extremes of one millisecond sample set, computed by `database.harness`. */
export interface BenchStats {
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    rounds: number;
}

/** The primitive surface exported by the native binding. */
export interface PostgresNative {
    connect(options: ClientOptions): Connection;
    version(): string;
    protocolVersion(): number;
    maxMessageBytes(): number;
    encodeStartupPacket(user: string, database: string): Buffer;
    encodeQueryPacket(sql: string): Buffer;
    /** The 16-byte `CancelRequest` sent on its own connection. */
    encodeCancelRequest(processId: number, secretKey: number): Buffer;
    decodeErrorResponse(payload: Buffer): ServerErrorInfo;
    decodeErrorFields(payload: Buffer): MessageFieldInfo[];
    decodeNoticeFields(payload: Buffer): MessageFieldInfo[];
    decodeRowDescription(payload: Buffer): string[];
    decodeDataRow(payload: Buffer, columns: number): (string | null)[];
    decodeCommandTag(payload: Buffer): string;
    encodeParseMessage(name: string, sql: string, paramTypes: number[]): Buffer;
    encodeBindMessage(
        portal: string,
        statement: string,
        params: (string | null)[],
        resultFormat: number,
    ): Buffer;
    encodeDescribeMessage(target: 'statement' | 'portal', name: string): Buffer;
    /** Builds one `Bind` message with explicit parameter and result format codes. */
    encodeBindMessageWithFormats(
        portal: string,
        statement: string,
        params: ParamInfo[],
        paramFormats: number[],
        resultFormats: number[],
    ): Buffer;
    encodeExecuteMessage(portal: string, maxRows: number): Buffer;
    encodeSyncMessage(): Buffer;
    encodeCloseMessage(target: 'statement' | 'portal', name: string): Buffer;
    decodeParameterDescription(payload: Buffer): number[];
    /** One `CopyData` message carrying a chunk of the copy stream. */
    encodeCopyData(data: Buffer): Buffer;
    /** The `CopyDone` message that ends a `COPY ... FROM STDIN` stream. */
    encodeCopyDone(): Buffer;
    /** A `CopyFail` message carrying a human readable reason. */
    encodeCopyFail(reason: string): Buffer;
    decodeCopyResponse(payload: Buffer): CopyResponseInfo;
    parameterTypeOid(name: string): number | null;
    encodeBytea(bytes: Buffer): string;
    parsePsqlArguments(args: string[]): CommandOptions;
    formatPsqlResults(results: StatementResult[], options: CommandOptions): string[];
    /** median/p95/极值，nearest-rank 判定在上游 `database.harness` 统一维护。 */
    harnessBenchSummary(samplesMs: number[]): BenchStats;
    /** 单次操作的归一毫秒（median / ops）；`ops` 为 0 时返回 NaN。 */
    harnessBenchPerOp(stats: BenchStats, ops: number): number;
    Store: new (dataDir: string) => Store;
    ServerStore: new (dataDir: string) => ServerStore;
}

/** Map Node platform/arch to the optionalDependency package suffix. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
    if (platform === 'win32' && arch === 'x64') return 'win32-x64';
    if (platform === 'linux' && arch === 'x64') return 'linux-x64';
    if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
    if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
    return null;
}

/** Load the platform binding; every package entry point resolves through it. */
export function loadNative(): PostgresNative {
    const key = platformKey();
    if (!key) throw new Error(`PostgreSQL native binding is unavailable for ${process.platform}-${process.arch}`);
    // A checkout builds the addon into the sibling platform package, so prefer it
    // over the optional dependency: the registry copy can lag behind the sources
    // the tests are exercising.
    const repo = resolve(packageRoot, '..', '..', '..', '..');
    const local = join(repo, 'projects', 'postgres.ts', 'platforms', `postgres-${key}`);
    if (existsSync(join(local, 'package.json'))) return require(local) as PostgresNative;
    const platformPackage = `@yydb/postgres-${key}`;
    try {
        return require(platformPackage) as PostgresNative;
    } catch (error) {
        throw new Error(
            `cannot resolve ${platformPackage}: install the matching platform package (${(error as Error).message})`,
        );
    }
}
