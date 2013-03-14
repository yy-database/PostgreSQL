import { createRequire } from 'node:module';

export type PlatformKey = 'win32-x64' | 'linux-x64' | 'darwin-x64' | 'darwin-arm64';

/** Where one connection goes and which identity it presents. */
export interface ClientOptions {
    host: string;
    port: number;
    user: string;
    database: string;
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
    executeWithParams(sql: string, params: (string | null)[], types: number[]): StatementResult[];
    prepare(sql: string, types: number[]): PreparedStatement;
    executePrepared(name: string, params: (string | null)[]): StatementResult[];
    closePrepared(name: string): void;
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

/** Effective `psql` options, as normalized by the binding. */
export interface CommandOptions extends ClientOptions {
    sql: string;
    headers: boolean;
    separator: string;
    nullValue: string;
}

/** The primitive surface exported by the native binding. */
export interface PostgresNative {
    connect(options: ClientOptions): Connection;
    version(): string;
    protocolVersion(): number;
    maxMessageBytes(): number;
    encodeStartupPacket(user: string, database: string): Buffer;
    encodeQueryPacket(sql: string): Buffer;
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
    encodeExecuteMessage(portal: string, maxRows: number): Buffer;
    encodeSyncMessage(): Buffer;
    encodeCloseMessage(target: 'statement' | 'portal', name: string): Buffer;
    decodeParameterDescription(payload: Buffer): number[];
    parameterTypeOid(name: string): number | null;
    encodeBytea(bytes: Buffer): string;
    parsePsqlArguments(args: string[]): CommandOptions;
    formatPsqlResults(results: StatementResult[], options: CommandOptions): string[];
    Store: new (dataDir: string) => Store;
}

/** Map Node platform/arch to the optionalDependency package suffix. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
    if (platform === 'win32' && arch === 'x64') return 'win32-x64';
    if (platform === 'linux' && arch === 'x64') return 'linux-x64';
    if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
    if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
    return null;
}

/** Native binding filename inside each `@yydb/postgres-<platform>` package `lib/`. */
export function nativeBindingName(key: PlatformKey): string {
    switch (key) {
        case 'win32-x64':
            return 'postgres-win32-x64-msvc.node';
        case 'linux-x64':
            return 'postgres-linux-x64-gnu.node';
        case 'darwin-x64':
            return 'postgres-darwin-x64.node';
        case 'darwin-arm64':
            return 'postgres-darwin-arm64.node';
    }
}

const require = createRequire(import.meta.url);

/** Load the platform binding; every package entry point resolves through it. */
export function loadNative(): PostgresNative {
    const key = platformKey();
    if (!key) throw new Error(`PostgreSQL native binding is unavailable for ${process.platform}-${process.arch}`);
    const loaded: { default?: PostgresNative } | PostgresNative = require(`@yydb/postgres-${key}`);
    return ('default' in loaded && loaded.default ? loaded.default : loaded) as PostgresNative;
}
