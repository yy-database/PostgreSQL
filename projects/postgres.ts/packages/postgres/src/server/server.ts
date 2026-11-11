import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';

import { loadNative } from '../native.ts';
import { ServerError } from './errors.ts';
import {
    SCRAM_CHANNEL_BINDING_NO,
    type ScramSecret,
    parseScramVerifier,
    scramClientProofValid,
    scramFields,
    scramNonce,
    scramServerSignature,
} from './scram.ts';
import { cloneDatabase, databasePrefix, purgeDatabase, scopedStorage, storageFor } from './store.ts';
import { createSessionRuntime, Database, type SessionRuntime, type Storage } from './sql/database.ts';
import { SCHEMA_FILE, touchesSchema, writeSchemaExport } from './sql/schema_export.ts';
import { type ClusterDatabase, ClusterStore, hasDatabasePrivilege } from './sql/cluster.ts';
import { copyColumnCount, copyIn, copyOut } from './sql/copy.ts';
import {
    constantValue,
    parseStatement,
    type CopyStatement,
    type CreateDatabaseStatement,
    type CursorDirection,
    type CursorStatement,
    type DropDatabaseStatement,
    type PrepareStatement,
    type Statement,
    type TransactionStatement,
} from './sql/parser.ts';
import { decodeBinaryParameter, encodeBinaryValue } from './sql/binary.ts';
import {
    armStatementDeadline,
    describeSelect,
    inferParameterTypes,
    restoreStatementDeadline,
    runStatement,
    type Field,
    type Outcome,
} from './sql/engine.ts';
import { LockWait, snapshotIsolation, TransactionManager, type IsolationLevel, type TransactionHandle } from './sql/transaction.ts';
import { TEXT, formatValue, parseLiteral, typeLength, typeOid, type SqlValue, type DataType } from './sql/types.ts';
import {
    authenticationCleartextPassword,
    authenticationOk,
    authenticationSasl,
    authenticationSaslContinue,
    authenticationSaslFinal,
    backendKeyData,
    bindComplete,
    closeComplete,
    commandComplete,
    copyData,
    copyDone,
    copyInResponse,
    copyOutResponse,
    cstring,
    dataRow,
    emptyQueryResponse,
    errorResponse,
    noData,
    noticeResponse,
    notificationResponse,
    parameterDescription,
    parameterStatus,
    parseComplete,
    portalSuspended,
    readyForQuery,
    rowDescription,
    SSL_REQUEST,
    GSSENC_REQUEST,
    CANCEL_REQUEST,
    PROTOCOL_VERSION,
    type MessageFields,
    type RowField,
} from './protocol.ts';

/**
 * Authentication the server offers.
 *
 * - `trust`: no password.
 * - `{ password }`: cleartext password over the wire, kept for compatibility.
 * - `{ scram: true }`: SCRAM-SHA-256 against the verifier stored on each role
 *   by `CREATE ROLE ... PASSWORD` / `ALTER ROLE ... PASSWORD`. A role without a
 *   stored verifier is rejected, never silently trusted.
 */
export type ServerAuth = 'trust' | { password: string } | { scram: true };

export interface PostgresServerOptions {
    /** Address to listen on. Defaults to `127.0.0.1`. */
    host?: string;
    /** Port to listen on. `0` picks a free port. Defaults to `0`. */
    port?: number;
    /** User accepted by startup. Defaults to `postgres`. */
    user?: string;
    /** Database accepted by startup. Defaults to `postgres`. */
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
    /** Projection of the cluster catalogs, rewritten after every schema commit. */
    schemaPath: string;
    /** Stops listening, destroys every open session and releases the lock. */
    close(): Promise<void>;
}

export { ServerError };

const TEXT_OID = typeOid(TEXT);

/**
 * GUC names are case-insensitive on input but canonical on the wire, so
 * `SHOW datestyle`, `SET DATESTYLE` and the startup `DateStyle` all resolve to
 * the same entry.
 */
const GUC_CANONICAL = new Map<string, string>();
const GUC_DEFAULTS = new Map<string, string>();

function defineGuc(canonical: string, value: string): void {
    GUC_CANONICAL.set(canonical.toLowerCase(), canonical);
    GUC_DEFAULTS.set(canonical, value);
}

/** The `GUC_REPORT` set: every change is echoed as a `ParameterStatus`. */
const GUC_REPORTED = new Set([
    'application_name',
    'client_encoding',
    'DateStyle',
    'default_transaction_read_only',
    'in_hot_standby',
    'integer_datetimes',
    'IntervalStyle',
    'is_superuser',
    'server_encoding',
    'server_version',
    'session_authorization',
    'standard_conforming_strings',
    'TimeZone',
]);

/** Milliseconds per accepted timeout unit, the way PostgreSQL's `parse_int` reads them. */
const TIMEOUT_UNITS = new Map<string, number>([
    ['', 1],
    ['us', 0.001],
    ['usec', 0.001],
    ['usecs', 0.001],
    ['microsecond', 0.001],
    ['microseconds', 0.001],
    ['ms', 1],
    ['msec', 1],
    ['msecs', 1],
    ['millisecond', 1],
    ['milliseconds', 1],
    ['s', 1000],
    ['sec', 1000],
    ['secs', 1000],
    ['second', 1000],
    ['seconds', 1000],
    ['min', 60_000],
    ['mins', 60_000],
    ['minute', 60_000],
    ['minutes', 60_000],
    ['h', 3_600_000],
    ['hr', 3_600_000],
    ['hrs', 3_600_000],
    ['hour', 3_600_000],
    ['hours', 3_600_000],
    ['d', 86_400_000],
    ['day', 86_400_000],
    ['days', 86_400_000],
    ['w', 604_800_000],
    ['week', 604_800_000],
    ['weeks', 604_800_000],
]);

/**
 * Reads one timeout GUC value like PostgreSQL: a bare number is milliseconds,
 * an optional unit suffix scales it, and `0` disables the timeout.
 */
function parseTimeoutMs(name: string, text: string): number {
    const match = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i.exec(text.trim());
    if (match === null || match[1] === undefined) {
        throw new ServerError('22023', `invalid value for parameter "${name}": "${text}"`);
    }
    const unit = (match[2] ?? '').toLowerCase();
    const multiplier = TIMEOUT_UNITS.get(unit);
    if (multiplier === undefined) throw new ServerError('22023', `unit "${unit}" is not recognized`);
    return Math.round(Number(match[1]) * multiplier);
}

/** Boolean GUCs render `on`/`off` on `SHOW` and in `ParameterStatus`. */
const GUC_BOOLEAN = new Set([
    'default_transaction_read_only',
    'in_hot_standby',
    'integer_datetimes',
    'is_superuser',
    'standard_conforming_strings',
    'row_security',
    'check_function_bodies',
    'data_checksums',
    'debug_assertions',
]);

for (const [canonical, value] of [
    ['server_version', '16.9'],
    ['server_version_num', '160009'],
    ['server_encoding', 'UTF8'],
    ['client_encoding', 'UTF8'],
    ['DateStyle', 'ISO, MDY'],
    ['TimeZone', 'UTC'],
    ['integer_datetimes', 'on'],
    ['standard_conforming_strings', 'on'],
    ['IntervalStyle', 'postgres'],
    ['is_superuser', 'off'],
    ['session_authorization', 'postgres'],
    ['application_name', ''],
    ['default_transaction_read_only', 'off'],
    ['in_hot_standby', 'off'],
    ['max_connections', '100'],
    ['password_encryption', 'scram-sha-256'],
    ['search_path', '"$user", public'],
    ['extra_float_digits', '1'],
    ['bytea_output', 'hex'],
    ['client_min_messages', 'notice'],
    ['default_transaction_isolation', 'read committed'],
    ['transaction_isolation', 'read committed'],
    ['statement_timeout', '0'],
    ['lock_timeout', '0'],
    ['idle_in_transaction_session_timeout', '0'],
    ['row_security', 'on'],
    ['check_function_bodies', 'on'],
    ['max_identifier_length', '63'],
    ['max_index_keys', '32'],
    ['block_size', '8192'],
    ['segment_size', '1GB'],
    ['wal_block_size', '8192'],
    ['wal_segment_size', '16MB'],
    ['data_checksums', 'off'],
    ['debug_assertions', 'off'],
] as [string, string][]) {
    defineGuc(canonical, value);
}

/** Resolves a GUC spelling to its canonical name, or `undefined` when unknown. */
function canonicalGuc(name: string): string | undefined {
    return GUC_CANONICAL.get(name.toLowerCase());
}

/** Normalizes `DateStyle` to the two-token form PostgreSQL reports. */
function normalizeDateStyle(value: string, current: string): string {
    const styles: Record<string, string> = { iso: 'ISO', sql: 'SQL', postgres: 'Postgres', german: 'German' };
    const orders = new Set(['MDY', 'DMY', 'YMD']);
    let style = '';
    let order = '';
    for (const raw of value.split(',')) {
        const token = raw.trim().toLowerCase();
        if (token === '') continue;
        if (styles[token] !== undefined) style = styles[token] as string;
        else if (orders.has(token.toUpperCase())) order = token.toUpperCase();
        else throw new ServerError('22023', `invalid value for parameter "DateStyle": "${value}"`);
    }
    const previous = current.split(',').map((part) => part.trim());
    if (style === '' && previous[0] !== undefined) style = previous[0];
    if (order === '' && previous[1] !== undefined) order = previous[1];
    return `${style || 'ISO'}, ${order || 'MDY'}`;
}

/** Normalizes boolean GUC spellings, rejecting values PostgreSQL rejects. */
function normalizeBoolean(name: string, value: string): string {
    const token = value.trim().toLowerCase();
    if (['on', 'true', 'yes', '1'].includes(token)) return 'on';
    if (['off', 'false', 'no', '0'].includes(token)) return 'off';
    throw new ServerError('22023', `invalid value for parameter "${name}": "${value}"`);
}

/** `pg_cursors.creation_time`, rendered like `timestamp with time zone`. */
function currentTimestamp(): string {
    const now = new Date();
    const fraction = String(now.getUTCMilliseconds()).padStart(3, '0');
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(
        now.getUTCHours(),
    ).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}.${fraction}+00`;
}

interface SessionState {
    parameters: Map<string, string>;
    user: string;
    database: string;
}

/** Turns engine fields and values into the protocol's row description and cells. */
function wireFields(fields: Field[]): RowField[] {
    return fields.map((field) => ({
        name: field.name,
        typeOid: typeOid(field.type),
        typeLength: typeLength(field.type),
        typeModifier: field.type.typmod,
    }));
}

function wireRows(outcome: { fields: Field[]; rows: SqlValue[][] }): (string | null)[][] {
    return outcome.rows.map((row) =>
        row.map((value, index) => {
            const type = outcome.fields[index]?.type ?? TEXT;
            return formatValue(value, type);
        }),
    );
}

/**
 * Applies a `Bind` result-format list onto the columns of a `RowDescription`.
 *
 * The wire shape is: zero codes → every column text; one code → that code for
 * every column; `n` codes → one per column, with missing codes defaulting to
 * text. PostgreSQL accepts the same three shapes; anything else is rejected by
 * `handleBind` before we ever reach this helper.
 */
function applyResultFormats(fields: RowField[], resultFormats: number[]): RowField[] {
    if (resultFormats.length === 0) return fields;
    const single = resultFormats.length === 1;
    return fields.map((field, index) => ({
        ...field,
        format: single ? resultFormats[0] : resultFormats[index] ?? 0,
    }));
}

/** One `DataRow`'s cells, binary where the portal asked for format code `1`. */
function binaryCells(row: SqlValue[], fields: Field[], resultFormats: number[]): (string | Buffer | null)[] {
    return row.map((value, index) => {
        const type = fields[index]?.type ?? TEXT;
        const format = resultFormats.length === 0 ? 0 : resultFormats.length === 1 ? resultFormats[0] : resultFormats[index] ?? 0;
        return format === 1 ? encodeBinaryValue(value, type) : formatValue(value, type);
    });
}

function unquote(value: string): string {
    const text = value.trim();
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
        return text.slice(1, -1).replaceAll("''", "'");
    }
    return text;
}

/** Splits a simple-query payload on statement boundaries outside quotes and comments. */
export function splitStatements(sql: string): string[] {
    return scanStatements(sql).map((part) => part.text);
}

/** Splits like [`splitStatements`], also telling where each statement starts. */
export function scanStatements(sql: string): { text: string; start: number }[] {
    const statements: { raw: string; start: number }[] = [];
    let current = '';
    let segmentStart = 0;
    let single = false;
    let double = false;
    let lineComment = false;
    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index]!;
        const next = sql[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (!single && !double && character === '-' && next === '-') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (!double && character === "'") {
            if (current.trim().length === 0) segmentStart = index;
            current += character;
            if (single && next === "'") {
                current += "'";
                index += 1;
            } else {
                single = !single;
            }
            continue;
        }
        if (!single && character === '"') {
            if (current.trim().length === 0) segmentStart = index;
            double = !double;
            current += character;
            continue;
        }
        if (!single && !double && character === ';') {
            statements.push({ raw: current, start: segmentStart });
            current = '';
            continue;
        }
        if (current.trim().length === 0 && !/\s/.test(character)) segmentStart = index;
        current += character;
    }
    statements.push({ raw: current, start: segmentStart });
    return statements
        .map((part) => ({ text: part.raw.trim(), start: part.start + (part.raw.length - part.raw.replace(/^\s+/, '').length) }))
        .filter((part) => part.text.length > 0);
}

/** An engine result plus the streamed `COPY ... TO STDOUT` payload. */
type ServerOutcome = (Outcome & { parameters?: { name: string; value: string }[] }) | { kind: 'copy-out'; data: string; rows: number; columns: number };

/** Sessions share one hub so `NOTIFY` reaches connections that `LISTEN`. */
interface NotificationHub {
    sessions: Set<Session>;
}

interface CursorState {
    fields: Field[];
    rows: SqlValue[][];
    /** `-1` before the first row, `rows.length` after the last row. */
    index: number;
    scroll: boolean;
    hold: boolean;
    inTransaction: boolean;
    /** Original `DECLARE` text, rendered by `pg_cursors.statement`. */
    statement: string;
    /** `DECLARE ... BINARY`. */
    binary: boolean;
    /** Timestamp rendered for `pg_cursors.creation_time`. */
    creationTime: string;
}

interface SqlPrepared {
    statement: Statement;
    types: DataType[];
}

/** One bound portal: the `Bind` inputs plus the state a suspended `Execute` resumes from. */
interface PortalState {
    statement: string;
    parameters: SqlValue[];
    /** Result format codes from `Bind`; empty means every column is text. */
    resultFormats: number[];
    /** `true` once a `Describe` has answered, so `Execute` skips `RowDescription`. */
    described: boolean;
    /** Materialized by the first `Execute`; later batches continue from `position`. */
    outcome?: ServerOutcome;
    /** Only a plain `SELECT` portal suspends, like PostgreSQL's `PORTAL_ONE_SELECT`. */
    suspendable: boolean;
    /** Rows already sent for `outcome`. */
    position: number;
}

/**
 * Decodes frontend messages while driving the backend side of protocol v3.
 *
 * Every session owns its GUC map, its prepared statements and its portals. One
 * message shares one `Database`, so its statements either all become durable
 * through a single `commitChanges` call or are discarded together.
 */
class Session {
    private readonly socket: net.Socket;
    private user: string;
    private database: string;
    private readonly auth: ServerAuth;
    /** The unscoped store, used for cluster-level rows and per-database scoping. */
    private readonly baseStorage: Storage;
    private storage: Storage;
    private readonly cluster: ClusterStore;
    private readonly pid = randomInt(1, 2 ** 31 - 1);
    private readonly secret = randomInt(1, 2 ** 31 - 1);

    private buffer: Buffer = Buffer.alloc(0);
    private startupPhase = true;
    private startupParameters = new Map<string, string>();
    private awaitingPassword = false;
    /** SCRAM-SHA-256 handshake state; `null` outside that window. */
    private scram:
        | { phase: 'initial' }
        | { phase: 'final'; clientFirstBare: string; serverFirst: string; combinedNonce: string; verifier: ScramSecret }
        | null = null;
    private state: SessionState | null = null;
    private prepared = new Map<string, { sql: string; parameterOids: number[] }>();
    private portals = new Map<string, PortalState>();
    private extendedFailed = false;
    private closing = false;
    private readonly runtime: SessionRuntime = createSessionRuntime();
    /** Set while an explicit `BEGIN` transaction is open, across messages. */
    private transaction:
        | {
              database: Database;
              handle: TransactionHandle;
              isolation: IsolationLevel;
              readOnly: boolean;
              /** `true` once a real statement ran, which freezes `SET TRANSACTION`. */
              started: boolean;
              savepoints: { name: string; state: Database }[];
              aborted: boolean;
          }
        | null = null;
    /** Row locks of the implicit transaction owned by the current message. */
    private implicitHandle: TransactionHandle | null = null;
    /** A suspended simple-query batch awaiting a row lock. */
    private pendingBatch: { statements: string[]; index: number; outcomes: ServerOutcome[]; implicit: Database | null } | null = null;
    /** A suspended extended-protocol `Execute` awaiting a row lock. */
    private pendingExecute: Buffer | null = null;
    private suspended = false;
    private readonly manager: TransactionManager;
    /** Byte offset of each statement of the current simple query, for psql's caret. */
    private statementOffsets: number[] = [];
    private readonly hub: NotificationHub;
    private readonly channels = new Set<string>();
    /** `NOTIFY` payloads accumulated until the next commit. */
    private pending: { channel: string; payload: string }[] = [];
    private readonly cursors = new Map<string, CursorState>();
    /** Temporary tables this session created, dropped when the session ends. */
    private readonly tempTables = new Set<string>();
    private tempPurged = false;
    private readonly sqlPrepared = new Map<string, SqlPrepared>();
    private copyState:
        | {
              statement: CopyStatement;
              database: Database;
              snapshot: Database | null;
              statements: string[];
              nextIndex: number;
              chunks: Buffer[];
          }
        | null = null;

    constructor(
        socket: net.Socket,
        options: PostgresServerOptions,
        storage: Storage,
        hub: NotificationHub,
        cluster: ClusterStore,
        manager: TransactionManager,
    ) {
        this.socket = socket;
        this.user = options.user ?? 'postgres';
        this.database = options.database ?? 'postgres';
        this.auth = options.auth ?? 'trust';
        this.baseStorage = storage;
        this.storage = scopedStorage(storage, databasePrefix(this.database));
        this.cluster = cluster;
        this.manager = manager;
        this.hub = hub;
        this.runtime.pgCursors = () =>
            [...this.cursors.entries()].map(([name, cursor]) => ({
                name,
                statement: cursor.statement,
                isHoldable: cursor.hold,
                isBinary: cursor.binary,
                isScrollable: cursor.scroll,
                creationTime: cursor.creationTime,
            }));
        this.runtime.passwordEncryption = () =>
            this.state?.parameters.get('password_encryption') ?? GUC_DEFAULTS.get('password_encryption') ?? 'scram-sha-256';
        hub.sessions.add(this);
    }

    /** `true` when this connection is open on `name`; used by `DROP DATABASE`. */
    usesDatabase(name: string): boolean {
        return this.database === name;
    }

    start(): void {
        this.socket.on('data', (chunk: Buffer) => {
            // 当没有残留字节时直接复用入站 chunk，省掉一次 `Buffer.concat` 的拷贝。
            this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
            this.pump();
        });
        this.socket.on('error', () => this.destroy());
        this.socket.on('close', () => {
            this.hub.sessions.delete(this);
            this.endTransactions();
            this.purgeTempTables();
        });
    }

    /** Aborts an open transaction and releases its row locks when the client goes away. */
    private endTransactions(): void {
        if (this.transaction !== null) {
            this.manager.rollback(this.transaction.handle);
            this.transaction = null;
        }
        if (this.implicitHandle !== null) {
            this.manager.rollback(this.implicitHandle);
            this.implicitHandle = null;
        }
    }

    /** Drops a parked session that will never resume. */
    private forgetLocks(): void {
        if (this.transaction !== null) this.manager.forget(this.transaction.handle);
        if (this.implicitHandle !== null) this.manager.forget(this.implicitHandle);
        this.transaction = null;
        this.implicitHandle = null;
        this.pendingBatch = null;
        this.pendingExecute = null;
    }

    /** Drops the temporary tables this session leaves behind, like session exit. */
    private purgeTempTables(): void {
        if (this.tempPurged) return;
        this.tempPurged = true;
        if (this.tempTables.size === 0) return;
        try {
            const database = Database.open(this.storage, this.cluster, this.runtime);
            for (const name of this.tempTables) {
                try {
                    runStatement(
                        database,
                        { kind: 'drop-table', table: { kind: 'relation', schema: undefined, name, alias: undefined, args: undefined }, ifExists: true, cascade: false },
                        [],
                    );
                } catch {
                    // A temp table inside an uncommitted transaction never reached storage.
                }
            }
            database.commit();
        } catch {
            // Closing the socket must not fail because cleanup did.
        }
        this.tempTables.clear();
    }

    destroy(): void {
        this.closing = true;
        this.hub.sessions.delete(this);
        this.forgetLocks();
        this.socket.destroy();
    }

    /** Ends a session the way `DROP DATABASE ... WITH (FORCE)` does. */
    terminate(): void {
        this.closing = true;
        this.hub.sessions.delete(this);
        this.forgetLocks();
        this.socket.write(errorResponse({ severity: 'FATAL', code: '57P01', message: 'terminating connection due to administrator command' }));
        this.socket.end();
    }

    private pump(): void {
        // 一轮处理里产生的所有回包合并成一次 flush：扩展协议的 ParseComplete、
        // BindComplete、RowDescription、DataRow、CommandComplete 与 ReadyForQuery
        // 各是一次 `socket.write`，cork 把它们压进同一次系统调用。
        // `finally` 保证提前返回（等更多字节、锁挂起）时已写的回包照常发出。
        this.socket.cork();
        try {
            this.pumpMessages();
        } finally {
            this.socket.uncork();
        }
    }

    private pumpMessages(): void {
        while (!this.closing && !this.suspended) {
            if (this.startupPhase) {
                if (this.buffer.length < 4) return;
                const length = this.buffer.readInt32BE(0);
                if (length < 8 || length > 10_000) {
                    this.fail('08P01', 'invalid startup packet length');
                    return;
                }
                if (this.buffer.length < length) return;
                const packet = this.buffer.subarray(0, length);
                this.buffer = this.buffer.subarray(length);
                this.handleStartup(packet);
                continue;
            }

            if (this.buffer.length < 5) return;
            const tag = String.fromCharCode(this.buffer[0] ?? 0);
            const length = this.buffer.readInt32BE(1);
            if (length < 4) {
                this.fail('08P01', 'invalid message length');
                return;
            }
            if (this.buffer.length < 1 + length) return;
            const payload = this.buffer.subarray(5, 1 + length);
            this.buffer = this.buffer.subarray(1 + length);
            this.handleMessage(tag, payload);
        }
    }

    private handleStartup(packet: Buffer): void {
        const code = packet.readInt32BE(4);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            this.socket.write('N');
            return;
        }
        if (code === CANCEL_REQUEST) {
            this.destroy();
            return;
        }
        if (code !== PROTOCOL_VERSION) {
            this.fail('0A000', `unsupported frontend protocol ${code >> 16}.${code & 0xffff}`);
            return;
        }

        const parameters = new Map<string, string>();
        let offset = 8;
        while (offset < packet.length) {
            const key = cstring(packet, offset);
            if (key.value.length === 0) break;
            const value = cstring(packet, key.next);
            parameters.set(key.value, value.value);
            offset = value.next;
        }

        const user = parameters.get('user') ?? '';
        const database = parameters.get('database') ?? user;
        if (user.length === 0) {
            this.fail('28000', 'no PostgreSQL user name specified in startup packet');
            return;
        }
        const target = this.cluster.find(database);
        if (!target) {
            this.fail('3D000', `database "${database}" does not exist`);
            return;
        }
        if (!target.datallowconn) {
            this.fail('55000', `database "${database}" is not currently accepting connections`);
            return;
        }
        const role = this.cluster.findRole(user);
        if (!role) {
            this.fail('28000', `role "${user}" does not exist`);
            return;
        }
        if (!role.rolcanlogin) {
            this.fail('28000', `role "${user}" is not permitted to log in`);
            return;
        }
        if (!hasDatabasePrivilege(this.cluster.doc.databases, this.cluster.doc.roles, user, database, 'CONNECT')) {
            this.fail('42501', `permission denied for database "${database}"`, 'User does not have CONNECT privilege.');
            return;
        }
        if (!role.rolsuper && target.datconnlimit > 0 && this.otherSessionsOn(database) >= target.datconnlimit) {
            this.fail('53300', `too many connections for database "${database}"`);
            return;
        }

        this.user = user;
        this.runtime.user = user;
        this.runtime.database = database;
        this.database = database;
        this.storage = scopedStorage(this.baseStorage, databasePrefix(database));
        this.startupParameters = parameters;
        if (this.auth === 'trust') {
            this.completeAuthentication();
            return;
        }
        this.startupPhase = false;
        if ('scram' in this.auth) {
            this.scram = { phase: 'initial' };
            this.socket.write(authenticationSasl(['SCRAM-SHA-256']));
            return;
        }
        this.awaitingPassword = true;
        this.socket.write(authenticationCleartextPassword());
    }

    private completeAuthentication(): void {
        const parameters = this.startupParameters;
        const user = parameters.get('user') ?? this.user;
        const applicationName = parameters.get('application_name') ?? '';
        const role = this.cluster.findRole(user);
        this.startupPhase = false;
        this.awaitingPassword = false;
        this.state = {
            parameters: new Map([
                ['server_version', '16.9'],
                ['server_version_num', '160009'],
                ['server_encoding', 'UTF8'],
                ['client_encoding', parameters.get('client_encoding') ?? 'UTF8'],
                ['DateStyle', 'ISO, MDY'],
                ['TimeZone', 'UTC'],
                ['integer_datetimes', 'on'],
                ['standard_conforming_strings', 'on'],
                ['IntervalStyle', 'postgres'],
                ['is_superuser', role?.rolsuper ? 'on' : 'off'],
                ['session_authorization', user],
                ['application_name', applicationName],
                ['default_transaction_read_only', 'off'],
                ['default_transaction_isolation', 'read committed'],
                ['transaction_isolation', 'read committed'],
                ['in_hot_standby', 'off'],
                ['max_connections', '100'],
            ]),
            user,
            database: this.database,
        };
        this.socket.write(authenticationOk());
        for (const name of [
            'application_name',
            'client_encoding',
            'DateStyle',
            'default_transaction_read_only',
            'in_hot_standby',
            'integer_datetimes',
            'IntervalStyle',
            'is_superuser',
            'server_encoding',
            'server_version',
            'session_authorization',
            'standard_conforming_strings',
            'TimeZone',
        ]) {
            const value = this.state.parameters.get(name);
            if (value !== undefined) this.socket.write(parameterStatus(name, value));
        }
        this.socket.write(backendKeyData(this.pid, this.secret));
        this.socket.write(readyForQuery('I'));
    }

    /**
     * One SASL step of the startup exchange: `SASLInitialResponse` carrying the
     * client-first message, then `SASLResponse` carrying the client-final one.
     * Channel binding is not implemented, so the server advertises only
     * `SCRAM-SHA-256` and a client that asks for `SCRAM-SHA-256-PLUS` is
     * rejected, the way a real PostgreSQL without TLS behaves.
     */
    private handleSaslMessage(tag: string, payload: Buffer): void {
        const user = this.startupParameters.get('user') ?? '';
        const phase = this.scram?.phase;
        if (tag !== 'p') {
            this.fail('08P01', `expected ${phase === 'final' ? 'SASLResponse' : 'SASLInitialResponse'}, but got message type ${tag.charCodeAt(0)}`);
            return;
        }
        if (phase === 'initial') {
            const mechanism = cstring(payload, 0);
            if (mechanism.value !== 'SCRAM-SHA-256') {
                this.fail('08P01', `unsupported SASL mechanism "${mechanism.value}"`);
                return;
            }
            if (payload.length < mechanism.next + 4) {
                this.fail('08P01', 'invalid SASLInitialResponse message length');
                return;
            }
            const length = payload.readInt32BE(mechanism.next);
            if (length < 0 || payload.length < mechanism.next + 4 + length) {
                this.fail('08P01', 'invalid SASLInitialResponse message length');
                return;
            }
            const clientFirst = payload.subarray(mechanism.next + 4, mechanism.next + 4 + length).toString('utf8');
            if (!clientFirst.startsWith('n,,')) {
                this.fail('08P01', 'SCRAM channel binding is not supported');
                return;
            }
            const clientFirstBare = clientFirst.slice(3);
            const fields = scramFields(clientFirstBare);
            const clientNonce = fields.get('r');
            // PostgreSQL authenticates the startup-packet user and treats the
            // SCRAM `n=` field as advisory; node-postgres sends `n=*`.
            if (clientNonce === undefined || clientNonce.length === 0 || fields.get('n') === undefined) {
                this.fail('08P01', 'invalid SCRAM first message');
                return;
            }
            const stored = this.cluster.findRole(user)?.rolpassword;
            const verifier = stored === undefined ? null : parseScramVerifier(stored);
            if (verifier === null) {
                this.fail('28P01', `password authentication failed for user "${user}"`);
                return;
            }
            const combinedNonce = `${clientNonce}${scramNonce()}`;
            const serverFirst = `r=${combinedNonce},s=${verifier.salt.toString('base64')},i=${verifier.iterations}`;
            this.scram = { phase: 'final', clientFirstBare, serverFirst, combinedNonce, verifier };
            this.socket.write(authenticationSaslContinue(serverFirst));
            return;
        }

        if (this.scram === null || this.scram.phase !== 'final') {
            this.fail('08P01', 'invalid SCRAM final message');
            return;
        }
        const { clientFirstBare, serverFirst, combinedNonce, verifier } = this.scram;
        const fields = scramFields(payload.toString('utf8'));
        if (fields.get('c') !== SCRAM_CHANNEL_BINDING_NO || fields.get('r') !== combinedNonce || fields.get('p') === undefined) {
            this.fail('08P01', 'invalid SCRAM final message');
            return;
        }
        const clientFinalWithoutProof = `c=${SCRAM_CHANNEL_BINDING_NO},r=${combinedNonce}`;
        const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
        if (!scramClientProofValid(verifier, authMessage, fields.get('p') as string)) {
            this.fail('28P01', `password authentication failed for user "${user}"`);
            return;
        }
        this.scram = null;
        this.socket.write(authenticationSaslFinal(`v=${scramServerSignature(verifier, authMessage)}`));
        this.completeAuthentication();
    }

    private handleMessage(tag: string, payload: Buffer): void {
        if (this.scram !== null) {
            this.handleSaslMessage(tag, payload);
            return;
        }
        if (this.awaitingPassword && tag === 'p') {
            const password = cstring(payload, 0).value;
            if (typeof this.auth === 'object' && 'password' in this.auth && password === this.auth.password) {
                this.completeAuthentication();
                return;
            }
            this.fail('28P01', `password authentication failed for user "${this.startupParameters.get('user') ?? ''}"`);
            return;
        }

        if (this.extendedFailed && tag !== 'S' && tag !== 'X') return;

        if (this.copyState !== null) {
            switch (tag) {
                case 'd':
                    this.copyState.chunks.push(payload);
                    return;
                case 'c':
                    this.finishCopyIn(true, '');
                    return;
                case 'f':
                    this.finishCopyIn(false, cstring(payload, 0).value);
                    return;
                case 'X':
                    this.destroy();
                    return;
                default:
                    this.fail('08P01', `unexpected frontend message type ${tag.charCodeAt(0)} during COPY`);
            }
        }

        switch (tag) {
            case 'Q':
                this.handleSimpleQuery(payload);
                return;
            case 'P':
                this.handleParse(payload);
                return;
            case 'D':
                this.handleDescribe(payload);
                return;
            case 'B':
                this.handleBind(payload);
                return;
            case 'E':
                this.handleExecute(payload);
                return;
            case 'C':
                this.handleClose(payload);
                return;
            case 'S':
                this.handleSync();
                return;
            case 'H':
                return;
            case 'X':
                this.destroy();
                return;
            default:
                this.fail('08P01', `invalid frontend message type ${tag.charCodeAt(0)}`);
        }
    }

    private handleSimpleQuery(payload: Buffer): void {
        const sql = cstring(payload, 0).value;
        const state = this.state;
        if (!state) {
            this.fail('08006', 'session is not authenticated');
            return;
        }
        const parts = scanStatements(sql);
        const statements = parts.map((part) => part.text);
        this.statementOffsets = parts.map((part) => part.start);
        if (statements.length === 0) {
            this.socket.write(emptyQueryResponse());
            this.socket.write(readyForQuery(this.transactionStatus()));
            return;
        }
        this.runSimpleBatch(statements, 0, [], null);
    }

    /**
     * Runs the remaining statements of one simple-query message.
     *
     * A `COPY ... FROM STDIN` pauses the loop: its outcome is streamed now, the
     * rest waits until `CopyDone`/`CopyFail` resumes the batch.
     */
    private runSimpleBatch(statements: string[], startIndex: number, outcomes: ServerOutcome[], implicitStart: Database | null): void {
        const state = this.state!;
        let implicit = implicitStart;
        try {
            for (let index = startIndex; index < statements.length; index += 1) {
                const statement = statements[index]!;
                if (/^(?:begin|start|commit|end|rollback|abort|savepoint|release)\b/i.test(statement)) {
                    const parsed = parseStatement(statement) as TransactionStatement;
                    if (parsed.command === 'begin' && implicit !== null) {
                        this.commitImplicit(implicit);
                        this.flushNotifications();
                        implicit = null;
                    }
                    outcomes.push(this.runTransaction(parsed));
                    continue;
                }
                if (this.transaction?.aborted) {
                    throw new ServerError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
                }
                const direct = this.sessionCommand(state, statement);
                if (direct !== null) {
                    outcomes.push(direct);
                    continue;
                }
                const database = this.transaction !== null ? this.transaction.database : (implicit ??= this.openImplicit());
                this.statementStarted(database);
                let before: Database | null = null;
                let parsed: Statement | null = null;
                try {
                    parsed = parseStatement(statement);
                    // 隐式批次只在末尾提交，出错时整批丢弃，只读语句无需逐条快照。
                    // 显式事务要支持语句级回滚，写入语句也可能因等锁中断后重放。
                    if (this.transaction !== null || (parsed.kind !== 'select' && parsed.kind !== 'explain')) {
                        before = database.clone();
                    }
                    if (parsed.kind === 'copy' && parsed.direction === 'from') {
                        const columns = copyColumnCount(database, parsed);
                        for (const outcome of outcomes) this.emitOutcome(outcome);
                        this.copyState = {
                            statement: parsed,
                            database,
                            snapshot: before,
                            statements,
                            nextIndex: index + 1,
                            chunks: [],
                        };
                        this.socket.write(copyInResponse(columns));
                        return;
                    }
                    outcomes.push(this.runParsed(state, database, parsed, [], statements.length === 1));
                } catch (error) {
                    if (before !== null) database.restore(before);
                    if (error instanceof ServerError && error.position !== undefined && error.position >= 0) {
                        error.position += this.statementOffsets[index] ?? 0;
                    }
                    if (error instanceof LockWait) {
                        this.suspendBatch(statements, index, outcomes, implicit);
                        return;
                    }
                    throw error;
                }
            }
            if (implicit !== null) {
                this.commitImplicit(implicit);
                this.flushNotifications();
            }
        } catch (error) {
            for (const outcome of outcomes) this.emitOutcome(outcome);
            this.pending.length = 0;
            if (implicit !== null && this.implicitHandle !== null) {
                this.manager.rollback(this.implicitHandle);
                this.implicitHandle = null;
            }
            if (this.transaction !== null) this.abortTransaction();
            this.sendError(error);
            this.socket.write(readyForQuery(this.transactionStatus()));
            return;
        }
        for (const outcome of outcomes) this.emitOutcome(outcome);
        this.socket.write(readyForQuery(this.transactionStatus()));
    }

    /** Opens the working set of one implicit transaction and wires its row locks. */
    private openImplicit(): Database {
        const database = Database.open(this.storage, this.cluster, this.runtime);
        database.readOnly = this.state?.parameters.get('default_transaction_read_only') === 'on';
        database.onWrite = (relOid, key, operation) => this.acquireWrite(database, relOid, key, operation);
        return database;
    }

    /**
     * Prepares one statement of an explicit transaction: `READ COMMITTED`
     * re-reads committed state, the snapshot levels freeze their view on the
     * first statement rather than at `BEGIN`.
     */
    private statementStarted(database: Database): void {
        if (this.transaction === null) return;
        if (snapshotIsolation(this.transaction.isolation) === 'read committed') database.refreshCommitted();
        else if (!this.transaction.started) this.manager.takeSnapshot(this.transaction.handle);
        this.transaction.started = true;
    }

    /** Takes the write lock of one row for the transaction that owns the statement. */
    private acquireWrite(database: Database, relOid: number, key: string, operation: 'update' | 'delete'): void {
        const relation = database.catalog.relations.find((candidate) => candidate.oid === relOid)?.name ?? String(relOid);
        if (this.transaction !== null) {
            this.manager.acquire(this.transaction.handle, relOid, key, relation, operation);
            return;
        }
        if (this.implicitHandle === null) this.implicitHandle = this.manager.begin(this.pid, 'read committed');
        this.manager.acquire(this.implicitHandle, relOid, key, relation, operation);
    }

    /** Ends an implicit transaction through the single commit boundary. */
    private commitImplicit(database: Database): void {
        const handle = this.implicitHandle;
        const written = database.writtenRows();
        try {
            database.commit();
            if (handle !== null) this.manager.commit(handle, written);
        } catch (error) {
            if (handle !== null) this.manager.rollback(handle);
            throw error;
        } finally {
            this.implicitHandle = null;
        }
    }

    /** Parks a simple-query batch until the row lock it needs is released. */
    private suspendBatch(statements: string[], index: number, outcomes: ServerOutcome[], implicit: Database | null): void {
        const handle = this.transaction?.handle ?? this.implicitHandle;
        if (handle === null || handle === undefined) throw new ServerError('55000', 'lock wait without a transaction');
        this.pendingBatch = { statements, index, outcomes, implicit };
        this.suspended = true;
        this.manager.park(handle, () => this.resumeBatch());
    }

    private resumeBatch(): void {
        const pending = this.pendingBatch;
        this.pendingBatch = null;
        this.suspended = false;
        if (pending !== null) this.runSimpleBatch(pending.statements, pending.index, pending.outcomes, pending.implicit);
        this.pump();
    }

    /** Ends an interactive COPY: inserts the buffered rows or reports failure. */
    private finishCopyIn(success: boolean, message: string): void {
        const copy = this.copyState!;
        this.copyState = null;
        try {
            let count = 0;
            if (success) {
                count = copyIn(copy.database, copy.statement, Buffer.concat(copy.chunks).toString('utf8'));
                if (this.transaction === null) {
                    this.commitImplicit(copy.database);
                    this.flushNotifications();
                }
            }
            else throw new ServerError('57014', `COPY from stdin failed: ${message}`);
            this.socket.write(commandComplete(`COPY ${count}`));
            this.runSimpleBatch(copy.statements, copy.nextIndex, [], this.transaction === null ? copy.database : null);
        } catch (error) {
            if (copy.snapshot !== null) copy.database.restore(copy.snapshot);
            this.pending.length = 0;
            if (this.transaction !== null) this.abortTransaction();
            else if (this.implicitHandle !== null) {
                this.manager.rollback(this.implicitHandle);
                this.implicitHandle = null;
            }
            this.sendError(error);
            this.socket.write(readyForQuery(this.transactionStatus()));
        }
    }

    /** Status byte for `ReadyForQuery`: idle, in a transaction, or aborted. */
    private transactionStatus(): 'I' | 'T' | 'E' {
        if (this.transaction === null) return 'I';
        return this.transaction.aborted ? 'E' : 'T';
    }

    /**
     * Aborts the open transaction block the way PostgreSQL does at the first
     * error: the block stays open for `ROLLBACK`, but its row locks are handed
     * to waiting sessions immediately and its staged writes can never commit.
     */
    private abortTransaction(): void {
        if (this.transaction === null) return;
        this.manager.rollback(this.transaction.handle);
        this.transaction.aborted = true;
    }

    private warn(code: string, message: string): void {
        this.socket.write(noticeResponse({ severity: 'WARNING', code, message }));
    }

    private notice(code: string, message: string): void {
        this.socket.write(noticeResponse({ severity: 'NOTICE', code, message }));
    }

    /** Runs `BEGIN`/`COMMIT`/`ROLLBACK`/savepoint commands and returns their tag. */
    private runTransaction(statement: TransactionStatement): Outcome {
        switch (statement.command) {
            case 'begin':
                if (this.transaction !== null) {
                    if (this.transaction.aborted) {
                        throw new ServerError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
                    }
                    this.warn('25001', 'there is already a transaction in progress');
                    return { kind: 'command', tag: 'BEGIN' };
                }
                {
                    const state = this.state!;
                    const isolation =
                        (statement.isolation as IsolationLevel | undefined) ??
                        ((state.parameters.get('default_transaction_isolation') ?? 'read committed') as IsolationLevel);
                    const readOnly = statement.readOnly ?? state.parameters.get('default_transaction_read_only') === 'on';
                    const database = Database.open(this.storage, this.cluster, this.runtime);
                    database.readOnly = readOnly;
                    database.onWrite = (relOid, key, operation) => this.acquireWrite(database, relOid, key, operation);
                    this.transaction = {
                        database,
                        handle: this.manager.begin(this.pid, isolation),
                        isolation,
                        readOnly,
                        started: false,
                        savepoints: [],
                        aborted: false,
                    };
                }
                return { kind: 'command', tag: 'BEGIN' };
            case 'commit':
                if (this.transaction === null) {
                    this.warn('25P01', 'there is no transaction in progress');
                    return { kind: 'command', tag: 'COMMIT' };
                }
                if (this.transaction.aborted) {
                    this.manager.rollback(this.transaction.handle);
                    this.transaction = null;
                    this.closeCursorsInTransaction(true);
                    this.pending.length = 0;
                    return { kind: 'command', tag: 'ROLLBACK' };
                }
                {
                    const handle = this.transaction.handle;
                    const written = this.transaction.database.writtenRows();
                    try {
                        this.transaction.database.commit();
                    } catch (error) {
                        this.manager.rollback(handle);
                        this.transaction = null;
                        throw error;
                    }
                    this.manager.commit(handle, written);
                    this.transaction = null;
                }
                this.closeCursorsInTransaction(false);
                this.flushNotifications();
                return { kind: 'command', tag: 'COMMIT' };
            case 'rollback':
                if (this.transaction === null) {
                    this.warn('25P01', 'there is no transaction in progress');
                    return { kind: 'command', tag: 'ROLLBACK' };
                }
                this.manager.rollback(this.transaction.handle);
                this.transaction = null;
                this.closeCursorsInTransaction(true);
                this.pending.length = 0;
                return { kind: 'command', tag: 'ROLLBACK' };

            case 'savepoint': {
                const name = statement.name ?? '';
                if (this.transaction === null) {
                    throw new ServerError('25P01', 'SAVEPOINT can only be used in transaction blocks');
                }
                if (this.transaction.aborted) {
                    throw new ServerError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
                }
                this.transaction.savepoints.push({ name, state: this.transaction.database.clone() });
                return { kind: 'command', tag: 'SAVEPOINT' };
            }
            case 'release': {
                const name = statement.name ?? '';
                if (this.transaction === null) {
                    throw new ServerError('25P01', 'RELEASE SAVEPOINT can only be used in transaction blocks');
                }
                if (this.transaction.aborted) {
                    throw new ServerError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
                }
                const index = this.findSavepoint(name);
                if (index < 0) throw new ServerError('3B001', `savepoint "${name}" does not exist`);
                this.transaction.savepoints.splice(index);
                return { kind: 'command', tag: 'RELEASE' };
            }
            case 'rollback-to': {
                const name = statement.name ?? '';
                if (this.transaction === null) {
                    throw new ServerError('25P01', 'ROLLBACK TO SAVEPOINT can only be used in transaction blocks');
                }
                const index = this.findSavepoint(name);
                if (index < 0) throw new ServerError('3B001', `savepoint "${name}" does not exist`);
                const saved = this.transaction.savepoints[index];
                if (saved) this.transaction.database.restore(saved.state.clone());
                this.transaction.savepoints.splice(index + 1);
                this.transaction.aborted = false;
                return { kind: 'command', tag: 'ROLLBACK' };
            }
        }
    }

    private findSavepoint(name: string): number {
        if (this.transaction === null) return -1;
        for (let index = this.transaction.savepoints.length - 1; index >= 0; index -= 1) {
            if (this.transaction.savepoints[index]?.name === name) return index;
        }
        return -1;
    }

    /** `COMMIT` keeps only holdable cursors, `ROLLBACK` drops those the transaction opened. */
    private closeCursorsInTransaction(rollback: boolean): void {
        for (const [name, cursor] of this.cursors) {
            if (rollback ? cursor.inTransaction : !cursor.hold) this.cursors.delete(name);
        }
    }

    /** Handles `SET`/`SHOW` without the SQL parser; `null` means "parse normally". */
    private sessionCommand(state: SessionState, sql: string): ServerOutcome | null {
        const statement = sql.trim();
        const setTransaction = /^set\s+transaction\s+([\s\S]+)$/i.exec(statement);
        if (setTransaction?.[1] !== undefined) return this.setTransactionOptions(state, setTransaction[1], false);
        const setSessionTransaction = /^set\s+session\s+characteristics\s+as\s+transaction\s+([\s\S]+)$/i.exec(statement);
        if (setSessionTransaction?.[1] !== undefined) return this.setTransactionOptions(state, setSessionTransaction[1], true);
        const set = /^(?:set|set\s+session|set\s+local)\s+(?:"([^"]+)"|([a-z_][a-z0-9_.]*))\s*(?:=|to)\s*([\s\S]+)$/i.exec(statement);
        if (set) {
            const rawName = set[1] ?? set[2];
            const rawValue = set[3];
            if (rawName !== undefined && rawValue !== undefined) return this.setParameter(state, rawName, rawValue);
        }
        const timeZone = /^(?:set|set\s+session|set\s+local)\s+time\s+zone\s+([\s\S]+)$/i.exec(statement);
        if (timeZone?.[1] !== undefined) {
            const value = timeZone[1].replace(/^(?:=|to)\s+/i, '');
            return this.setParameter(state, 'TimeZone', value);
        }
        const names = /^(?:set|set\s+session|set\s+local)\s+names\s+([\s\S]+)$/i.exec(statement);
        if (names?.[1] !== undefined) return this.setParameter(state, 'client_encoding', names[1]);
        const show = /^show\s+(?:"([^"]+)"|([a-z_][a-z0-9_.]*))$/i.exec(statement);
        if (show) {
            const rawName = show[1] ?? show[2];
            if (rawName !== undefined) {
                const key = canonicalGuc(rawName) ?? [...state.parameters.keys()].find((name) => name.toLowerCase() === rawName.toLowerCase());
                const value =
                    key === 'transaction_isolation'
                        ? (this.transaction?.isolation ?? state.parameters.get('default_transaction_isolation') ?? 'read committed')
                        : key === undefined
                          ? undefined
                          : (state.parameters.get(key) ?? GUC_DEFAULTS.get(key));
                if (key === undefined || value === undefined) throw new ServerError('42704', `unrecognized configuration parameter "${rawName.toLowerCase()}"`);
                return { kind: 'rows', fields: [{ name: key, type: TEXT }], rows: [[value]], tag: 'SHOW' };
            }
        }
        return null;
    }

    /**
     * Applies `SET TRANSACTION ...` to the current transaction, or stores the
     * defaults for `SET SESSION CHARACTERISTICS AS TRANSACTION ...`.
     */
    private setTransactionOptions(state: SessionState, text: string, sessionWide: boolean): ServerOutcome {
        const parsed = parseStatement(`BEGIN ${text}`) as TransactionStatement;
        if (sessionWide) {
            if (parsed.isolation !== undefined) state.parameters.set('default_transaction_isolation', parsed.isolation);
            if (parsed.readOnly !== undefined) state.parameters.set('default_transaction_read_only', parsed.readOnly ? 'on' : 'off');
            return {
                kind: 'command',
                tag: 'SET',
                ...(parsed.readOnly !== undefined
                    ? { parameters: [{ name: 'default_transaction_read_only', value: parsed.readOnly ? 'on' : 'off' }] }
                    : {}),
            };
        }
        if (this.transaction === null) {
            this.warn('25P01', 'SET TRANSACTION can only be used in transaction blocks');
            return { kind: 'command', tag: 'SET' };
        }
        if (this.transaction.started) {
            if (parsed.isolation !== undefined) {
                throw new ServerError('25001', 'SET TRANSACTION ISOLATION LEVEL must be called before any query');
            }
            throw new ServerError('25001', 'SET TRANSACTION READ ONLY must be called before any query');
        }
        if (parsed.isolation !== undefined) {
            this.manager.rollback(this.transaction.handle);
            this.transaction.isolation = parsed.isolation as IsolationLevel;
            this.transaction.handle = this.manager.begin(this.pid, this.transaction.isolation);
        }
        if (parsed.readOnly !== undefined) {
            this.transaction.readOnly = parsed.readOnly;
            this.transaction.database.readOnly = parsed.readOnly;
        }
        return { kind: 'command', tag: 'SET' };
    }

    /** Applies one `SET`, normalizes its value and reports it when it is `GUC_REPORT`. */
    private setParameter(state: SessionState, rawName: string, rawValue: string): ServerOutcome {
        const key = canonicalGuc(rawName);
        if (key === undefined) {
            if (!rawName.includes('.')) throw new ServerError('42704', `unrecognized configuration parameter "${rawName.toLowerCase()}"`);
            // Custom GUCs are accepted as written, like PostgreSQL's dotted names.
            state.parameters.set(rawName.toLowerCase(), unquote(rawValue));
            return { kind: 'command', tag: 'SET' };
        }
        const text = unquote(rawValue);
        const current = state.parameters.get(key) ?? GUC_DEFAULTS.get(key) ?? '';
        let value: string;
        if (/^default$/i.test(text)) {
            value = GUC_DEFAULTS.get(key) ?? '';
        } else if (key === 'DateStyle') {
            value = normalizeDateStyle(text, current);
        } else if (key === 'default_transaction_isolation') {
            const level = text.toLowerCase();
            if (!['read uncommitted', 'read committed', 'repeatable read', 'serializable'].includes(level)) {
                throw new ServerError(
                    '22023',
                    `invalid value for parameter "default_transaction_isolation": "${text}"`,
                    undefined,
                    undefined,
                    'Available values: serializable, repeatable read, read committed, read uncommitted.',
                );
            }
            value = level;
        } else if (key === 'statement_timeout') {
            // Validate like PostgreSQL's `parse_int`; the executor re-reads the
            // stored text per statement, so the value itself stays as entered.
            parseTimeoutMs(key, text);
            value = text;
        } else if (GUC_BOOLEAN.has(key)) {
            value = normalizeBoolean(key, text);
        } else if (key === 'TimeZone' && text.toUpperCase() === 'UTC') {
            value = 'UTC';
        } else {
            value = text;
        }
        state.parameters.set(key, value);
        return {
            kind: 'command',
            tag: 'SET',
            ...(GUC_REPORTED.has(key) ? { parameters: [{ name: key, value }] } : {}),
        };
    }

    /** Rejects writes when the active transaction, or the session default, is read only. */
    private assertWritable(statement: Statement): void {
        const readOnly = this.transaction !== null ? this.transaction.readOnly : this.state?.parameters.get('default_transaction_read_only') === 'on';
        if (!readOnly) return;
        const verb = writeVerb(statement);
        if (verb !== undefined) throw new ServerError('25006', `cannot execute ${verb} in a read-only transaction`);
    }

    /**
     * Arms `statement_timeout` around one statement. The executor checks the
     * deadline at row boundaries, so a scan, join or aggregate that runs past
     * it aborts with `57014`; inside a transaction block the statement error
     * then puts the block in the aborted state, exactly like PostgreSQL.
     * `0` (the default) leaves the deadline unarmed.
     */
    private runParsed(state: SessionState, database: Database, statement: Statement, parameters: SqlValue[], topLevel = true): ServerOutcome {
        const raw = state.parameters.get('statement_timeout') ?? GUC_DEFAULTS.get('statement_timeout') ?? '0';
        const ms = parseTimeoutMs('statement_timeout', raw);
        const deadline = ms <= 0 ? Number.POSITIVE_INFINITY : Date.now() + ms;
        const previous = armStatementDeadline(deadline);
        try {
            return this.runParsedArmed(state, database, statement, parameters, topLevel);
        } finally {
            restoreStatementDeadline(previous);
        }
    }

    /**
     * Runs one statement: session GUCs, then session-owned SQL, then the engine.
     * `topLevel` is false for every statement of a multi-statement simple query.
     */
    private runParsedArmed(state: SessionState, database: Database, statement: Statement, parameters: SqlValue[], topLevel = true): ServerOutcome {
        this.assertWritable(statement);
        switch (statement.kind) {
            case 'copy': {
                if (statement.direction === 'from') {
                    throw new ServerError('0A000', 'feature not supported', 'COPY FROM STDIN is only available through the simple query protocol');
                }
                const result = copyOut(database, statement);
                return { kind: 'copy-out', data: result.data, rows: result.rows, columns: result.columns };
            }
            case 'cursor':
                return this.runCursor(database, statement);
            case 'prepare':
                return this.runPrepare(statement);
            case 'execute': {
                const prepared = this.sqlPrepared.get(statement.name);
                if (!prepared) throw new ServerError('26000', `prepared statement "${statement.name}" does not exist`);
                const args = statement.args.map((arg, index) => {
                    const value = constantValue(arg);
                    const type = prepared.types[index];
                    if (type === undefined || value === null) return value;
                    return parseLiteral(formatValue(value, TEXT) ?? '', type);
                });
                return this.runParsed(state, database, prepared.statement, args);
            }
            case 'deallocate': {
                if (statement.all) {
                    this.sqlPrepared.clear();
                    return { kind: 'command', tag: 'DEALLOCATE ALL' };
                }
                const name = statement.name ?? '';
                if (!this.sqlPrepared.has(name)) throw new ServerError('26000', `prepared statement "${name}" does not exist`);
                this.sqlPrepared.delete(name);
                return { kind: 'command', tag: 'DEALLOCATE' };
            }
            case 'listen':
                this.channels.add(statement.channel);
                return { kind: 'command', tag: 'LISTEN' };
            case 'unlisten':
                if (statement.all) this.channels.clear();
                else this.channels.delete(statement.channel);
                return { kind: 'command', tag: 'UNLISTEN' };
            case 'notify': {
                const payload = statement.payload ?? '';
                if (Buffer.byteLength(payload, 'utf8') >= 8000) {
                    throw new ServerError('22023', 'payload string too long');
                }
                this.pending.push({ channel: statement.channel, payload });
                return { kind: 'command', tag: 'NOTIFY' };
            }
            case 'create-database':
                return this.runCreateDatabase(statement, topLevel);
            case 'drop-database':
                return this.runDropDatabase(statement, topLevel);
            case 'create-index':
                if (statement.concurrently && (this.transaction !== null || !topLevel)) {
                    throw new ServerError('25001', 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
                }
                return runStatement(database, statement, parameters);
            case 'drop-index':
                if (statement.concurrently && (this.transaction !== null || !topLevel)) {
                    throw new ServerError('25001', 'DROP INDEX CONCURRENTLY cannot run inside a transaction block');
                }
                return runStatement(database, statement, parameters);
            case 'vacuum':
                if (this.transaction !== null || !topLevel) {
                    throw new ServerError('25001', 'VACUUM cannot run inside a transaction block');
                }
                return runStatement(database, statement, parameters);
            case 'create-table': {
                const outcome = runStatement(database, statement, parameters);
                if (statement.persistence === 't') this.tempTables.add(statement.table.name);
                return outcome;
            }
            case 'drop-table': {
                const outcome = runStatement(database, statement, parameters);
                this.tempTables.delete(statement.table.name);
                return outcome;
            }
            default:
                return runStatement(database, statement, parameters);
        }
    }

    /**
     * `CREATE DATABASE`: clones the template database's namespaces into the new
     * `db:<name>:` prefix and adds one cluster directory row.
     */
    private runCreateDatabase(statement: CreateDatabaseStatement, topLevel: boolean): ServerOutcome {
        if (this.transaction !== null || !topLevel) {
            throw new ServerError('25001', 'CREATE DATABASE cannot run inside a transaction block');
        }
        const name = statement.name;
        if (this.cluster.find(name)) throw new ServerError('42P04', `database "${name}" already exists`);
        const templateName = statement.template ?? 'template1';
        const template = this.cluster.find(templateName);
        if (!template) throw new ServerError('3D000', `database "${templateName}" does not exist`);
        const users = this.otherSessionsOn(templateName);
        if (users > 0) {
            throw new ServerError(
                '55006',
                `source database "${templateName}" is being accessed by other users`,
                users === 1 ? 'There is 1 other session using the database.' : `There are ${users} other sessions using the database.`,
            );
        }
        const owner = statement.owner ?? this.user;
        const ownerRole = this.cluster.findRole(owner);
        if (!ownerRole) throw new ServerError('42704', `role "${owner}" does not exist`);

        const database: ClusterDatabase = {
            oid: this.cluster.nextOid(),
            datname: name,
            datdba: ownerRole.oid,
            encoding: template.encoding,
            datlocprovider: template.datlocprovider,
            datistemplate: false,
            // `ALLOW_CONNECTIONS` and `CONNECTION LIMIT` are not inherited from the template.
            datallowconn: statement.allowConnections ?? true,
            datconnlimit: statement.connectionLimit ?? -1,
            datfrozenxid: template.datfrozenxid,
            datminmxid: template.datminmxid,
            dattablespace: template.dattablespace,
            datcollate: template.datcollate,
            datctype: template.datctype,
            daticulocale: template.daticulocale,
            daticurules: template.daticurules,
            datcollversion: template.datcollversion,
            datacl: null,
        };
        const changes = cloneDatabase(this.baseStorage, templateName, name);
        this.cluster.append(database);
        changes.push(this.cluster.change());
        try {
            this.baseStorage.commitChanges(changes);
        } catch (error) {
            this.cluster.remove(name);
            throw new ServerError('58030', 'could not write to the data directory', error instanceof Error ? error.message : String(error));
        }
        return { kind: 'command', tag: 'CREATE DATABASE' };
    }

    /**
     * `DROP DATABASE`: removes the cluster row and every durable row the
     * database owns, in one commit.
     */
    private runDropDatabase(statement: DropDatabaseStatement, topLevel: boolean): ServerOutcome {
        if (this.transaction !== null || !topLevel) {
            throw new ServerError('25001', 'DROP DATABASE cannot run inside a transaction block');
        }
        const name = statement.name;
        const target = this.cluster.find(name);
        if (!target) {
            if (!statement.ifExists) throw new ServerError('3D000', `database "${name}" does not exist`);
            this.notice('00000', `database "${name}" does not exist, skipping`);
            return { kind: 'command', tag: 'DROP DATABASE' };
        }
        if (target.datistemplate) throw new ServerError('42809', 'cannot drop a template database');
        if (name === this.database) throw new ServerError('55006', 'cannot drop the currently open database');
        if (statement.force) this.terminateSessionsOn(name);
        const users = this.otherSessionsOn(name);
        if (users > 0) {
            throw new ServerError(
                '55006',
                `database "${name}" is being accessed by other users`,
                users === 1 ? 'There is 1 other session using the database.' : `There are ${users} other sessions using the database.`,
            );
        }

        const changes = purgeDatabase(this.baseStorage, name);
        this.cluster.remove(name);
        changes.push(this.cluster.change());
        try {
            this.baseStorage.commitChanges(changes);
        } catch (error) {
            throw new ServerError('58030', 'could not write to the data directory', error instanceof Error ? error.message : String(error));
        }
        return { kind: 'command', tag: 'DROP DATABASE' };
    }

    /** Sessions other than this one currently connected to `name`. */
    private otherSessionsOn(name: string): number {
        let count = 0;
        for (const session of this.hub.sessions) {
            if (session !== this && session.usesDatabase(name)) count += 1;
        }
        return count;
    }

    /** Ends every other session on `name` for `DROP DATABASE ... WITH (FORCE)`. */
    private terminateSessionsOn(name: string): void {
        for (const session of [...this.hub.sessions]) {
            if (session !== this && session.usesDatabase(name)) session.terminate();
        }
    }

    private runPrepare(statement: PrepareStatement): ServerOutcome {
        if (this.sqlPrepared.has(statement.name)) {
            throw new ServerError('42P05', `prepared statement "${statement.name}" already exists`);
        }
        const inner = statement.types.length === 0 ? statement.statement : rewriteParamTypes(statement.statement, statement.types);
        this.sqlPrepared.set(statement.name, { statement: inner, types: statement.types });
        return { kind: 'command', tag: 'PREPARE' };
    }

    /** Runs `DECLARE`/`FETCH`/`MOVE`/`CLOSE` against the materialized cursor set. */
    private runCursor(database: Database, statement: CursorStatement): ServerOutcome {
        if (statement.action === 'declare') {
            if (!statement.hold && this.transaction === null) {
                throw new ServerError('25P01', 'DECLARE CURSOR can only be used in transaction blocks');
            }
            if (this.cursors.has(statement.name)) throw new ServerError('42P03', `cursor "${statement.name}" already exists`);
            const select = statement.select;
            if (select === null || select === undefined) throw new ServerError('42601', 'DECLARE CURSOR requires a query');
            const outcome = runStatement(database, select, []);
            if (outcome.kind !== 'rows') throw new ServerError('XX000', 'cursor query did not produce rows');
            this.cursors.set(statement.name, {
                fields: outcome.fields,
                rows: outcome.rows,
                index: -1,
                scroll: statement.scroll !== 'no-scroll',
                hold: statement.hold,
                inTransaction: this.transaction !== null,
                statement: statement.source ?? `DECLARE ${statement.name} CURSOR`,
                binary: statement.binary ?? false,
                creationTime: currentTimestamp(),
            });
            return { kind: 'command', tag: 'DECLARE CURSOR' };
        }
        if (statement.action === 'close') {
            if (statement.all) {
                this.cursors.clear();
                return { kind: 'command', tag: 'CLOSE CURSOR ALL' };
            }
            if (!this.cursors.has(statement.name)) throw new ServerError('34000', `cursor "${statement.name}" does not exist`);
            this.cursors.delete(statement.name);
            return { kind: 'command', tag: 'CLOSE CURSOR' };
        }
        const cursor = this.cursors.get(statement.name);
        if (!cursor) throw new ServerError('34000', `cursor "${statement.name}" does not exist`);
        const direction = statement.direction ?? { kind: 'forward', count: 1 };
        if (!cursor.scroll && isBackward(direction)) {
            throw new ServerError(
                '55000',
                'cursor can only scan forward',
                undefined,
                undefined,
                'Declare it with SCROLL option to enable backward scan.',
            );
        }
        const moved = moveCursor(cursor, direction);
        if (statement.action === 'move') return { kind: 'command', tag: `MOVE ${moved.moved}` };
        return { kind: 'rows', fields: cursor.fields, rows: moved.rows, tag: `FETCH ${moved.rows.length}` };
    }

    /** Sends every queued `NOTIFY` to the sessions listening at commit time. */
    private flushNotifications(): void {
        if (this.pending.length === 0) return;
        const items = this.pending;
        this.pending = [];
        for (const item of items) {
            for (const session of this.hub.sessions) {
                if (session.channels.has(item.channel)) session.socket.write(notificationResponse(this.pid, item.channel, item.payload));
            }
        }
    }

    /** Runs one extended-protocol statement, committing outside a transaction. */
    private executeStatement(sql: string, parameters: SqlValue[]): ServerOutcome {
        const state = this.state;
        if (!state) throw new ServerError('08006', 'session is not authenticated');
        const trimmed = sql.trim();
        if (/^(?:begin|start|commit|end|rollback|abort|savepoint|release)\b/i.test(trimmed)) {
            return this.runTransaction(parseStatement(trimmed) as TransactionStatement);
        }
        if (this.transaction?.aborted) {
            throw new ServerError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
        }
        const direct = this.sessionCommand(state, trimmed);
        if (direct !== null) return direct;
        if (this.transaction !== null) {
            const database = this.transaction.database;
            this.statementStarted(database);
            const before = database.clone();
            try {
                return this.runParsed(state, database, parseStatement(trimmed), parameters);
            } catch (error) {
                database.restore(before);
                throw error;
            }
        }
        const database = this.openImplicit();
        const before = database.clone();
        try {
            const outcome = this.runParsed(state, database, parseStatement(trimmed), parameters);
            this.commitImplicit(database);
            this.flushNotifications();
            return outcome;
        } catch (error) {
            database.restore(before);
            if (!(error instanceof LockWait) && this.implicitHandle !== null) {
                this.manager.rollback(this.implicitHandle);
                this.implicitHandle = null;
            }
            throw error;
        }
    }

    private handleParse(payload: Buffer): void {
        try {
            const name = cstring(payload, 0);
            const sql = cstring(payload, name.next);
            const count = payload.readInt16BE(sql.next);
            const parameterOids: number[] = [];
            for (let index = 0; index < count; index += 1) {
                parameterOids.push(payload.readInt32BE(sql.next + 2 + index * 4));
            }
            this.prepared.set(name.value, { sql: sql.value, parameterOids });
            this.socket.write(parseComplete());
        } catch (error) {
            this.sendExtendedError(error);
        }
    }

    private handleBind(payload: Buffer): void {
        try {
            const portal = cstring(payload, 0);
            const statement = cstring(payload, portal.next);
            const prepared = this.prepared.get(statement.value);
            if (!prepared) throw new ServerError('26000', `prepared statement "${statement.value}" does not exist`);
            let offset = statement.next;

            const formatCount = payload.readInt16BE(offset);
            offset += 2;
            const formats: number[] = [];
            for (let index = 0; index < formatCount; index += 1) {
                const format = payload.readInt16BE(offset);
                offset += 2;
                if (format !== 0 && format !== 1) throw new ServerError('08P01', `invalid parameter format code ${format}`);
                formats.push(format);
            }
            const valueCount = payload.readInt16BE(offset);
            offset += 2;
            const parameters: SqlValue[] = [];
            let inferred: (DataType | undefined)[] | undefined;
            for (let index = 0; index < valueCount; index += 1) {
                const length = payload.readInt32BE(offset);
                offset += 4;
                if (length < 0) {
                    parameters.push(null);
                    continue;
                }
                const buffer = payload.subarray(offset, offset + length);
                offset += length;
                const format = formats.length === 0 ? 0 : formats.length === 1 ? formats[0] : formats[index] ?? 0;
                if (format === 0) {
                    parameters.push(buffer.toString('utf8'));
                    continue;
                }
                let oid = prepared.parameterOids[index];
                if (oid === undefined || oid === 0) {
                    if (inferred === undefined) {
                        const state = this.state;
                        if (!state) throw new ServerError('08006', 'session is not authenticated');
                        const database = this.transaction?.database ?? Database.open(this.storage, this.cluster, this.runtime);
                        inferred = inferParameterTypes(database, parseStatement(prepared.sql), valueCount);
                    }
                    const type = inferred[index];
                    if (type === undefined) throw new ServerError('0A000', 'feature not supported', 'binary parameter requires a declared type');
                    oid = typeOid(type);
                }
                parameters.push(decodeBinaryParameter(buffer, oid));
            }
            if (offset + 2 > payload.length) throw new ServerError('08P01', 'invalid Bind message: missing result format count');
            const resultFormatCount = payload.readInt16BE(offset);
            offset += 2;
            const resultFormats: number[] = [];
            for (let index = 0; index < resultFormatCount; index += 1) {
                if (offset + 2 > payload.length) throw new ServerError('08P01', 'invalid Bind message: truncated result formats');
                const format = payload.readInt16BE(offset);
                offset += 2;
                if (format !== 0 && format !== 1) throw new ServerError('08P01', `invalid result format code ${format}`);
                resultFormats.push(format);
            }
            this.portals.set(portal.value, {
                statement: statement.value,
                parameters,
                resultFormats,
                described: false,
                suspendable: false,
                position: 0,
            });
            this.socket.write(bindComplete());
        } catch (error) {
            // Like PostgreSQL, any `Bind` failure inside a transaction block
            // aborts the block; the next statement is refused until it ends.
            if (this.transaction !== null) this.abortTransaction();
            this.sendExtendedError(error);
        }
    }

    private handleDescribe(payload: Buffer): void {
        const state = this.state;
        if (!state) {
            this.sendExtendedError(new ServerError('08006', 'session is not authenticated'));
            return;
        }
        try {
            const kind = String.fromCharCode(payload[0] ?? 0);
            const name = cstring(payload, 1).value;
            if (kind === 'S') {
                const prepared = this.prepared.get(name);
                if (!prepared) throw new ServerError('26000', `prepared statement "${name}" does not exist`);
                this.socket.write(parameterDescription(prepared.parameterOids));
                this.socket.write(this.describeSql(prepared.sql, prepared.parameterOids.length));
                return;
            }
            if (kind === 'P') {
                const portal = this.portals.get(name);
                if (!portal) {
                    // A SQL cursor is a portal from the client's point of view:
                    // libpq's `PQdescribePortal` addresses the DECLARE name.
                    const cursor = this.cursors.get(name);
                    if (cursor === undefined) throw new ServerError('34000', `portal "${name}" does not exist`);
                    this.socket.write(rowDescription(wireFields(cursor.fields)));
                    return;
                }
                const prepared = this.prepared.get(portal.statement);
                if (!prepared) throw new ServerError('26000', `prepared statement "${portal.statement}" does not exist`);
                portal.described = true;
                this.socket.write(this.describeSql(prepared.sql, portal.parameters.length, portal.resultFormats));
                return;
            }
            throw new ServerError('08P01', `invalid DESCRIBE message subtype ${kind}`);
        } catch (error) {
            // A `Describe` failure aborts the transaction block too, so the
            // block's `COMMIT` reports `ROLLBACK` like PostgreSQL's.
            if (this.transaction !== null) this.abortTransaction();
            this.sendExtendedError(error);
        }
    }

    /**
     * Builds the `RowDescription` (or `NoData`) a `Describe` answers with.
     *
     * `resultFormats` come from the portal's `Bind`; a statement `Describe` has
     * no portal yet, so PostgreSQL always answers text there and the default is
     * empty.
     */
    private describeSql(sql: string, parameterCount: number, resultFormats: number[] = []): Buffer {
        const statement = sql.trim();
        if (statement.length === 0) return noData();
        const show = /^show\s+(?:"([^"]+)"|([a-z_][a-z0-9_.]*))$/i.exec(statement);
        const showName = show?.[1] ?? show?.[2];
        if (showName !== undefined) {
            const name = canonicalGuc(showName) ?? showName.toLowerCase();
            return rowDescription(applyResultFormats([{ name, typeOid: TEXT_OID, typeLength: -1 }], resultFormats));
        }
        const parsed = parseStatement(statement);
        if (parsed.kind !== 'select') return noData();
        const placeholders = Array.from({ length: parameterCount }, () => null);
        const database = this.transaction?.database ?? Database.open(this.storage, this.cluster, this.runtime);
        return rowDescription(applyResultFormats(wireFields(describeSelect(database, parsed, placeholders)), resultFormats));
    }

    private handleExecute(payload: Buffer): void {
        const state = this.state;
        if (!state) {
            this.sendExtendedError(new ServerError('08006', 'session is not authenticated'));
            return;
        }
        try {
            const portalName = cstring(payload, 0);
            const maxRows = payload.readInt32BE(portalName.next);
            if (maxRows < 0) throw new ServerError('08P01', 'invalid row limit in Execute message');
            const portal = this.portals.get(portalName.value);
            if (!portal) throw new ServerError('34000', `portal "${portalName.value}" does not exist`);
            const prepared = this.prepared.get(portal.statement);
            if (!prepared) throw new ServerError('26000', `prepared statement "${portal.statement}" does not exist`);
            if (portal.outcome === undefined) {
                portal.outcome = this.executeStatement(prepared.sql, portal.parameters);
                // Only a plain `SELECT` portal suspends, like PostgreSQL's
                // `PORTAL_ONE_SELECT`; utility and modifying statements run to
                // completion whatever row limit arrives.
                portal.suspendable =
                    portal.outcome.kind === 'rows' && /^(?:select|with|table|values)\b/i.test(prepared.sql.trim());
                portal.position = 0;
            }
            this.emitPortal(portal, maxRows);
        } catch (error) {
            if (error instanceof LockWait) {
                const handle = this.transaction?.handle ?? this.implicitHandle;
                if (handle !== null && handle !== undefined) {
                    this.pendingExecute = payload;
                    this.suspended = true;
                    this.manager.park(handle, () => this.resumeExecute());
                    return;
                }
            }
            if (this.transaction !== null) this.abortTransaction();
            this.sendExtendedError(error);
        }
    }

    private resumeExecute(): void {
        const payload = this.pendingExecute;
        this.pendingExecute = null;
        this.suspended = false;
        if (payload !== null) this.handleExecute(payload);
        this.pump();
    }

    /**
     * Streams one `Execute` batch from a portal's materialized rows.
     *
     * A positive row limit stops after that many rows and answers
     * `PortalSuspended` without a `CommandComplete`, leaving the portal alive at
     * its read position; the next `Execute` on the same portal continues there.
     * A limit of `0` runs the portal to completion. The completion tag counts
     * the rows this `Execute` sent, so the final batch of a suspended portal
     * reports `SELECT <batch size>`, exactly like PostgreSQL.
     */
    private emitPortal(portal: PortalState, maxRows: number): void {
        const outcome = portal.outcome;
        if (outcome === undefined) return;
        if (outcome.kind !== 'rows') {
            this.emitOutcome(outcome, portal.described);
            return;
        }
        const rows = outcome.rows;
        const start = portal.position;
        const limit = maxRows === 0 || !portal.suspendable ? rows.length - start : maxRows;
        const end = Math.min(start + Math.max(limit, 0), rows.length);
        const parts: Buffer[] = [];
        if (!portal.described) parts.push(rowDescription(applyResultFormats(wireFields(outcome.fields), portal.resultFormats)));
        for (let index = start; index < end; index += 1) parts.push(dataRow(binaryCells(rows[index]!, outcome.fields, portal.resultFormats)));
        portal.position = end;
        // PostgreSQL suspends whenever the batch filled the requested limit, even
        // when the portal happened to run dry exactly there; the next `Execute`
        // then answers zero rows and the completion tag.
        const sent = end - start;
        if (portal.suspendable && maxRows > 0 && sent === maxRows) {
            parts.push(portalSuspended());
        } else {
            parts.push(commandComplete(portal.suspendable ? `SELECT ${sent}` : outcome.tag));
        }
        this.socket.write(Buffer.concat(parts));
    }

    private handleClose(payload: Buffer): void {
        const kind = String.fromCharCode(payload[0] ?? 0);
        const name = cstring(payload, 1).value;
        if (kind === 'S') this.prepared.delete(name);
        if (kind === 'P') this.portals.delete(name);
        this.socket.write(closeComplete());
    }

    private handleSync(): void {
        this.extendedFailed = false;
        // `Sync` ends the implicit transaction, and every portal bound inside it
        // dies with the transaction. Only an open explicit transaction keeps a
        // named portal — and with it a suspended `Execute` position — alive.
        if (this.transaction === null) this.portals.clear();
        this.socket.write(readyForQuery(this.transactionStatus()));
    }

    private emitOutcome(outcome: ServerOutcome, described = false): void {
        if (outcome.kind === 'copy-out') {
            this.socket.write(copyOutResponse(outcome.columns));
            if (outcome.data.length > 0) this.socket.write(copyData(Buffer.from(outcome.data, 'utf8')));
            this.socket.write(copyDone());
            this.socket.write(commandComplete(`COPY ${outcome.rows}`));
            return;
        }
        if (outcome.kind === 'command') {
            for (const parameter of outcome.parameters ?? []) {
                this.socket.write(parameterStatus(parameter.name, parameter.value));
            }
            for (const notice of outcome.notices ?? []) {
                this.socket.write(noticeResponse({ severity: notice.severity ?? 'NOTICE', code: notice.code, message: notice.message }));
            }
            this.socket.write(commandComplete(outcome.tag));
            return;
        }
        // 一条语句的协议消息合并成一次写入，减少往返中的小包与系统调用。
        const parts: Buffer[] = [];
        if (!described) parts.push(rowDescription(wireFields(outcome.fields)));
        for (const values of wireRows(outcome)) parts.push(dataRow(values));
        parts.push(commandComplete(outcome.tag));
        this.socket.write(parts.length === 1 ? parts[0]! : Buffer.concat(parts));
    }

    private sendError(error: unknown): void {
        const fields: MessageFields =
            error instanceof ServerError
                ? {
                      severity: 'ERROR',
                      code: error.code,
                      message: error.message,
                      ...(error.detail ? { detail: error.detail } : {}),
                      ...(error.hint ? { hint: error.hint } : {}),
                      ...(error.constraint ? { constraint: error.constraint } : {}),
                      ...(error.schema ? { schema: error.schema } : {}),
                      ...(error.table ? { table: error.table } : {}),
                      ...(error.column ? { column: error.column } : {}),
                      ...(error.dataType ? { dataType: error.dataType } : {}),
                      ...(error.position !== undefined ? { position: String(error.position + 1) } : {}),
                      ...(error.context ? { where: error.context } : {}),
                      ...(error.sourceFile ? { file: error.sourceFile } : {}),
                      ...(error.sourceLine ? { line: error.sourceLine } : {}),
                      ...(error.sourceRoutine ? { routine: error.sourceRoutine } : {}),
                  }
                : { severity: 'ERROR', code: 'XX000', message: error instanceof Error ? error.message : String(error) };
        this.socket.write(errorResponse(fields));
    }

    private sendExtendedError(error: unknown): void {
        this.extendedFailed = true;
        this.sendError(error);
    }

    private fail(code: string, message: string, detail?: string): void {
        this.socket.write(errorResponse({ severity: 'FATAL', code, message, ...(detail ? { detail } : {}) }));
        this.closing = true;
        this.socket.end();
    }
}

/** Name of the SQL command a read-only transaction must reject, if this statement writes. */
function writeVerb(statement: Statement): string | undefined {
    switch (statement.kind) {
        case 'insert':
            return 'INSERT';
        case 'update':
            return 'UPDATE';
        case 'delete':
            return 'DELETE';
        case 'create-table':
            return 'CREATE TABLE';
        case 'drop-table':
            return 'DROP TABLE';
        case 'create-view':
            return 'CREATE VIEW';
        case 'drop-view':
            return 'DROP VIEW';
        case 'vacuum':
            return 'VACUUM';
        case 'analyze':
            return 'ANALYZE';
        case 'create-index':
            return 'CREATE INDEX';
        case 'drop-index':
            return 'DROP INDEX';
        case 'alter-table':
            return 'ALTER TABLE';
        case 'create-role':
            return 'CREATE ROLE';
        case 'alter-role':
            return 'ALTER ROLE';
        case 'drop-role':
            return 'DROP ROLE';
        case 'grant':
            return 'GRANT';
        case 'revoke':
            return 'REVOKE';
        case 'copy':
            return statement.direction === 'from' ? 'COPY' : undefined;
        default:
            return undefined;
    }
}

function isBackward(direction: CursorDirection): boolean {
    switch (direction.kind) {
        case 'prior':
        case 'backward':
            return true;
        case 'relative':
            return direction.count < 0;
        case 'absolute':
            return direction.count <= 0;
        default:
            return false;
    }
}

/** Applies one FETCH/MOVE direction to a materialized cursor. */
function moveCursor(cursor: CursorState, direction: CursorDirection): { rows: SqlValue[][]; moved: number } {
    const data = cursor.rows;
    const count = data.length;
    const current = (): SqlValue[][] => (cursor.index >= 0 && cursor.index < count ? [data[cursor.index]!] : []);
    const forward = (take: number | 'all'): { rows: SqlValue[][]; moved: number } => {
        if (take === 0) return { rows: current(), moved: 0 };
        const start = cursor.index >= count ? count : cursor.index + 1;
        const available = count - start;
        const amount = take === 'all' ? available : Math.min(take, available);
        if (amount <= 0) {
            cursor.index = count;
            return { rows: [], moved: 0 };
        }
        const rows = data.slice(start, start + amount);
        cursor.index = take === 'all' || amount < take ? count : start + amount - 1;
        return { rows, moved: amount };
    };
    const backward = (take: number | 'all'): { rows: SqlValue[][]; moved: number } => {
        const start = cursor.index >= count ? count - 1 : cursor.index - 1;
        const available = start + 1;
        const amount = take === 'all' ? available : Math.min(take, available);
        if (amount <= 0) {
            cursor.index = -1;
            return { rows: [], moved: 0 };
        }
        const rows: SqlValue[][] = [];
        for (let offset = 0; offset < amount; offset += 1) rows.push(data[start - offset]!);
        cursor.index = take === 'all' ? -1 : Math.max(-1, start - amount + 1);
        return { rows, moved: amount };
    };
    switch (direction.kind) {
        case 'next':
            return forward(1);
        case 'prior':
            return backward(1);
        case 'forward':
            return forward(direction.count);
        case 'backward':
            return backward(direction.count);
        case 'absolute': {
            const target = direction.count > 0 ? direction.count - 1 : direction.count === 0 ? -1 : count + direction.count;
            if (target < 0) {
                cursor.index = -1;
                return { rows: [], moved: 0 };
            }
            if (target >= count) {
                cursor.index = count;
                return { rows: [], moved: 0 };
            }
            cursor.index = target;
            return { rows: [data[target]!], moved: 1 };
        }
        case 'relative':
            if (direction.count === 0) return { rows: current(), moved: 0 };
            return direction.count > 0 ? forward(direction.count) : backward(-direction.count);
        default:
            return { rows: [], moved: 0 };
    }
}

/** Casts every `$n` placeholder to the type declared in `PREPARE name (types)`. */
function rewriteParamTypes(statement: Statement, types: DataType[]): Statement {
    const rewrite = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(rewrite);
        if (node === null || typeof node !== 'object') return node;
        const record = node as Record<string, unknown>;
        if (record.kind === 'param' && typeof record.index === 'number') {
            const type = types[record.index - 1];
            return type ? { kind: 'cast', expr: record, type, start: record.start } : node;
        }
        const clone: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) clone[key] = rewrite(value);
        return clone;
    };
    return rewrite(statement) as Statement;
}

/** One live protocol endpoint attached to a shared engine assembly. */
export interface PostgresEndpointHandle {
    host: string;
    port: number;
    /** Stops listening and destroys every session on this endpoint. */
    close(): Promise<void>;
}

/**
 * One data directory's engine state: the store lock, the catalogs, the
 * transaction manager and the notification fan-out shared by every endpoint.
 */
export interface PostgresAssembly {
    dataDir: string;
    schemaPath: string;
    /** Attaches one protocol endpoint; sessions on every endpoint drive this engine. */
    serve(options: PostgresServerOptions): Promise<PostgresEndpointHandle>;
    /** Closes every endpoint, then releases the data directory lock. */
    close(): Promise<void>;
}

/** Takes one data directory's lock, seeds the catalogs and writes the schema projection. */
export function createPostgresAssembly(dataDir: string): PostgresAssembly {
    const store = new (loadNative().ServerStore)(dataDir);
    const committed = storageFor(store);
    // `local-0.yyds` remains the recovery truth. The projection is refreshed
    // after the commit that changed schema metadata, so a reader never sees
    // an export that is ahead of the catalog. A projection failure must not
    // turn a committed statement into a client-visible error.
    let clusterReady = false;
    let cluster: ClusterStore;
    const storage: Storage = {
        // 索引访问路径依赖前缀与游标下推到原生层，这里必须原样透传。
        scan: (namespace, prefix, after, before, limit) => committed.scan(namespace, prefix, after, before, limit),
        commitChanges: (changes) => {
            committed.commitChanges(changes);
            if (!clusterReady || !changes.some((change) => touchesSchema(change.namespace))) return;
            try {
                writeSchemaExport(dataDir, committed, cluster.doc.databases.map((database) => database.datname));
            } catch {
                // The catalog commit already succeeded; the projection is
                // rebuilt by the next schema commit or restart.
            }
        },
    };
    cluster = new ClusterStore(storage);
    clusterReady = true;
    writeSchemaExport(dataDir, storage, cluster.doc.databases.map((database) => database.datname));

    const hub: NotificationHub = { sessions: new Set<Session>() };
    const manager = new TransactionManager();
    const endpoints = new Set<PostgresEndpointHandle>();
    let closed = false;
    return {
        dataDir,
        schemaPath: path.join(dataDir, SCHEMA_FILE),
        serve: (options) =>
            new Promise<PostgresEndpointHandle>((resolve, reject) => {
                if (closed) {
                    reject(new Error('the engine assembly is closed'));
                    return;
                }
                const host = options.host ?? '127.0.0.1';
                const sockets = new Set<net.Socket>();
                const server = net.createServer((socket) => {
                    sockets.add(socket);
                    socket.on('close', () => sockets.delete(socket));
                    const session = new Session(socket, options, storage, hub, cluster, manager);
                    session.start();
                });
                const onError = (error: Error): void => {
                    server.off('error', onError);
                    reject(error);
                };
                server.once('error', onError);
                server.listen(options.port ?? 0, host, () => {
                    server.off('error', onError);
                    const address = server.address();
                    const port = typeof address === 'object' && address !== null ? address.port : 0;
                    const endpoint: PostgresEndpointHandle = {
                        host,
                        port,
                        close: () =>
                            new Promise<void>((done) => {
                                endpoints.delete(endpoint);
                                for (const socket of sockets) socket.destroy();
                                sockets.clear();
                                server.close(() => done());
                            }),
                    };
                    endpoints.add(endpoint);
                    resolve(endpoint);
                });
            }),
        close: async () => {
            if (closed) return;
            closed = true;
            for (const endpoint of [...endpoints]) await endpoint.close();
            endpoints.clear();
            store.close();
        },
    };
}

/** Starts a protocol-v3 server that accepts real `psql` and `pg` clients. */
export function startPostgresServer(options: PostgresServerOptions = {}): Promise<PostgresServerHandle> {
    let assembly: PostgresAssembly;
    try {
        assembly = createPostgresAssembly(options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-data-')));
    } catch (error) {
        return Promise.reject(error);
    }
    return assembly.serve(options).then(
        (endpoint) => ({
            host: endpoint.host,
            port: endpoint.port,
            dataDir: assembly.dataDir,
            schemaPath: assembly.schemaPath,
            close: async () => {
                await endpoint.close();
                await assembly.close();
            },
        }),
        async (error: Error) => {
            await assembly.close();
            throw error;
        },
    );
}
