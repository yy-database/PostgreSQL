import net from 'node:net';
import { randomInt } from 'node:crypto';

import {
    authenticationCleartextPassword,
    authenticationOk,
    backendKeyData,
    bindComplete,
    closeComplete,
    commandComplete,
    cstring,
    dataRow,
    emptyQueryResponse,
    errorResponse,
    noData,
    parameterDescription,
    parameterStatus,
    parseComplete,
    readyForQuery,
    rowDescription,
    SSL_REQUEST,
    GSSENC_REQUEST,
    CANCEL_REQUEST,
    PROTOCOL_VERSION,
    type MessageFields,
    type RowField,
} from './protocol.ts';

/** Authentication the server offers: no password, or one cleartext password. */
export type ServerAuth = 'trust' | { password: string };

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
}

export interface PostgresServerHandle {
    host: string;
    port: number;
    /** Stops listening and destroys every open session. */
    close(): Promise<void>;
}

const INT4_OID = 23;
const TEXT_OID = 25;

/** A statement-level failure that turns into an `ErrorResponse`. */
export class ServerError extends Error {
    readonly code: string;
    readonly detail: string | undefined;

    constructor(code: string, message: string, detail?: string) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}

interface SessionState {
    parameters: Map<string, string>;
    user: string;
    database: string;
}

type Outcome =
    | { kind: 'empty' }
    | { kind: 'command'; tag: string }
    | { kind: 'rows'; fields: RowField[]; rows: (string | null)[][]; tag: string };

function truncate(sql: string, limit = 64): string {
    const text = sql.trim().replace(/\s+/g, ' ');
    return text.length <= limit ? text : `${text.slice(0, limit)}...`;
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
    const statements: string[] = [];
    let current = '';
    let single = false;
    let double = false;
    let lineComment = false;
    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index];
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
            double = !double;
            current += character;
            continue;
        }
        if (!single && !double && character === ';') {
            statements.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    statements.push(current);
    return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/** Literal-only `SELECT` list: integers, strings, `NULL` and bound `$n` parameters. */
function selectColumns(sql: string, parameters: (string | null)[]): { fields: RowField[]; values: (string | null)[] } {
    const match = /^select\s+([\s\S]+)$/i.exec(sql.trim());
    if (!match || match[1] === undefined) throw new ServerError('0A000', 'feature not supported', 'not a SELECT list');
    const list = match[1];
    const items: string[] = [];
    let current = '';
    let single = false;
    for (let index = 0; index < list.length; index += 1) {
        const character = list[index];
        if (character === "'") single = !single;
        if (character === ',' && !single) {
            items.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    items.push(current);

    const fields: RowField[] = [];
    const values: (string | null)[] = [];
    for (const raw of items) {
        const item = raw.trim();
        const integer = /^-?\d+$/.exec(item);
        if (integer) {
            fields.push({ name: '?column?', typeOid: INT4_OID, typeLength: 4 });
            values.push(item);
            continue;
        }
        if (/^null$/i.test(item)) {
            fields.push({ name: '?column?', typeOid: TEXT_OID, typeLength: -1 });
            values.push(null);
            continue;
        }
        const text = /^'((?:[^']|'')*)'$/.exec(item);
        if (text && text[1] !== undefined) {
            fields.push({ name: '?column?', typeOid: TEXT_OID, typeLength: -1 });
            values.push(text[1].replaceAll("''", "'"));
            continue;
        }
        const parameter = /^\$(\d+)$/.exec(item);
        if (parameter && parameter[1] !== undefined) {
            const position = Number(parameter[1]);
            if (position < 1 || position > parameters.length) {
                throw new ServerError('42P02', `there is no parameter $${position}`);
            }
            fields.push({ name: '?column?', typeOid: TEXT_OID, typeLength: -1 });
            values.push(parameters[position - 1] ?? null);
            continue;
        }
        throw new ServerError('0A000', 'feature not supported', `expression is not implemented: ${item}`);
    }
    return { fields, values };
}

function executeStatement(state: SessionState, sql: string, parameters: (string | null)[]): Outcome {
    const statement = sql.trim();
    if (statement.length === 0) return { kind: 'empty' };

    const set = /^(?:set|set\s+session|set\s+local)\s+([a-z_][a-z0-9_.]*)\s*(?:=|to)\s*([\s\S]+)$/i.exec(statement);
    if (set && set[1] !== undefined && set[2] !== undefined) {
        const name = set[1].toLowerCase();
        state.parameters.set(name, unquote(set[2]));
        return { kind: 'command', tag: 'SET' };
    }

    if (/^select\s/i.test(statement)) {
        const { fields, values } = selectColumns(statement, parameters);
        return { kind: 'rows', fields, rows: [values], tag: 'SELECT 1' };
    }

    const show = /^show\s+([a-z_][a-z0-9_.]*)$/i.exec(statement);
    if (show && show[1] !== undefined) {
        const name = show[1].toLowerCase();
        const value = state.parameters.get(name);
        if (value === undefined) throw new ServerError('42704', `unrecognized configuration parameter "${name}"`);
        return {
            kind: 'rows',
            fields: [{ name, typeOid: TEXT_OID, typeLength: -1 }],
            rows: [[value]],
            tag: 'SHOW',
        };
    }

    throw new ServerError('0A000', 'feature not supported', `statement is not implemented: ${truncate(statement)}`);
}

/**
 * Decodes frontend messages while driving the backend side of protocol v3.
 *
 * Every session owns its GUC map, its prepared statements and its portals.
 * Batch 1 answers `SET`, `SHOW` and literal `SELECT` lists only.
 */
class Session {
    private readonly socket: net.Socket;
    private readonly user: string;
    private readonly database: string;
    private readonly auth: ServerAuth;
    private readonly pid = randomInt(1, 2 ** 31 - 1);
    private readonly secret = randomInt(1, 2 ** 31 - 1);

    private buffer: Buffer = Buffer.alloc(0);
    private startupPhase = true;
    private startupParameters = new Map<string, string>();
    private awaitingPassword = false;
    private state: SessionState | null = null;
    private prepared = new Map<string, { sql: string; parameterOids: number[] }>();
    private portals = new Map<string, { statement: string; parameters: (string | null)[]; described: boolean }>();
    private extendedFailed = false;
    private closing = false;

    constructor(socket: net.Socket, options: PostgresServerOptions) {
        this.socket = socket;
        this.user = options.user ?? 'postgres';
        this.database = options.database ?? 'postgres';
        this.auth = options.auth ?? 'trust';
    }

    start(): void {
        this.socket.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.pump();
        });
        this.socket.on('error', () => this.destroy());
    }

    destroy(): void {
        this.closing = true;
        this.socket.destroy();
    }

    private pump(): void {
        while (!this.closing) {
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
        if (database !== this.database) {
            this.fail('3D000', `database "${database}" does not exist`);
            return;
        }
        if (user !== this.user) {
            this.fail('28000', `role "${user}" does not exist`);
            return;
        }

        this.startupParameters = parameters;
        if (this.auth === 'trust') {
            this.completeAuthentication();
            return;
        }
        this.startupPhase = false;
        this.awaitingPassword = true;
        this.socket.write(authenticationCleartextPassword());
    }

    private completeAuthentication(): void {
        const parameters = this.startupParameters;
        const user = parameters.get('user') ?? this.user;
        const applicationName = parameters.get('application_name') ?? '';
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
                ['is_superuser', 'on'],
                ['session_authorization', user],
                ['application_name', applicationName],
                ['default_transaction_read_only', 'off'],
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

    private handleMessage(tag: string, payload: Buffer): void {
        if (this.awaitingPassword && tag === 'p') {
            const password = cstring(payload, 0).value;
            if (this.auth !== 'trust' && password === this.auth.password) {
                this.completeAuthentication();
                return;
            }
            this.fail('28P01', `password authentication failed for user "${this.startupParameters.get('user') ?? ''}"`);
            return;
        }

        if (this.extendedFailed && tag !== 'S' && tag !== 'X') return;

        switch (tag) {
            case 'Q':
                this.handleSimpleQuery(payload);
                return;
            case 'P':
                this.handleParse(payload);
                return;
            case 'B':
                this.handleBind(payload);
                return;
            case 'D':
                this.handleDescribe(payload);
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
        const statements = splitStatements(sql);
        if (statements.length === 0) {
            this.socket.write(emptyQueryResponse());
            this.socket.write(readyForQuery('I'));
            return;
        }
        try {
            for (const statement of statements) {
                this.emitOutcome(executeStatement(state, statement, []));
            }
        } catch (error) {
            this.sendError(error);
        }
        this.socket.write(readyForQuery('I'));
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
            for (let index = 0; index < formatCount; index += 1) {
                const format = payload.readInt16BE(offset);
                offset += 2;
                if (format !== 0) throw new ServerError('0A000', 'feature not supported', 'binary parameters are not implemented');
            }
            const valueCount = payload.readInt16BE(offset);
            offset += 2;
            const parameters: (string | null)[] = [];
            for (let index = 0; index < valueCount; index += 1) {
                const length = payload.readInt32BE(offset);
                offset += 4;
                if (length < 0) {
                    parameters.push(null);
                    continue;
                }
                parameters.push(payload.subarray(offset, offset + length).toString('utf8'));
                offset += length;
            }
            this.portals.set(portal.value, { statement: statement.value, parameters, described: false });
            this.socket.write(bindComplete());
        } catch (error) {
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
                if (!portal) throw new ServerError('34000', `portal "${name}" does not exist`);
                const prepared = this.prepared.get(portal.statement);
                if (!prepared) throw new ServerError('26000', `prepared statement "${portal.statement}" does not exist`);
                portal.described = true;
                this.socket.write(this.describeSql(prepared.sql, portal.parameters.length));
                return;
            }
            throw new ServerError('08P01', `invalid DESCRIBE message subtype ${kind}`);
        } catch (error) {
            this.sendExtendedError(error);
        }
    }

    private describeSql(sql: string, parameterCount: number): Buffer {
        const statement = sql.trim();
        if (statement.length === 0) return noData();
        if (/^select\s/i.test(statement)) {
            const placeholders = Array.from({ length: parameterCount }, () => null);
            return rowDescription(selectColumns(statement, placeholders).fields);
        }
        const show = /^show\s+([a-z_][a-z0-9_.]*)$/i.exec(statement);
        if (show && show[1] !== undefined) {
            return rowDescription([{ name: show[1].toLowerCase(), typeOid: TEXT_OID, typeLength: -1 }]);
        }
        return noData();
    }

    private handleExecute(payload: Buffer): void {
        const state = this.state;
        if (!state) {
            this.sendExtendedError(new ServerError('08006', 'session is not authenticated'));
            return;
        }
        try {
            const portalName = cstring(payload, 0).value;
            const portal = this.portals.get(portalName);
            if (!portal) throw new ServerError('34000', `portal "${portalName}" does not exist`);
            const prepared = this.prepared.get(portal.statement);
            if (!prepared) throw new ServerError('26000', `prepared statement "${portal.statement}" does not exist`);
            this.emitOutcome(executeStatement(state, prepared.sql, portal.parameters), portal.described);
        } catch (error) {
            this.sendExtendedError(error);
        }
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
        this.portals.delete('');
        this.socket.write(readyForQuery('I'));
    }

    private emitOutcome(outcome: Outcome, described = false): void {
        if (outcome.kind === 'empty') {
            this.socket.write(emptyQueryResponse());
            return;
        }
        if (outcome.kind === 'command') {
            this.socket.write(commandComplete(outcome.tag));
            return;
        }
        if (!described) this.socket.write(rowDescription(outcome.fields));
        for (const values of outcome.rows) this.socket.write(dataRow(values));
        this.socket.write(commandComplete(outcome.tag));
    }

    private sendError(error: unknown): void {
        const fields: MessageFields =
            error instanceof ServerError
                ? {
                      severity: 'ERROR',
                      code: error.code,
                      message: error.message,
                      ...(error.detail ? { detail: error.detail } : {}),
                  }
                : { severity: 'ERROR', code: 'XX000', message: error instanceof Error ? error.message : String(error) };
        this.socket.write(errorResponse(fields));
    }

    private sendExtendedError(error: unknown): void {
        this.extendedFailed = true;
        this.sendError(error);
    }

    private fail(code: string, message: string): void {
        this.socket.write(errorResponse({ severity: 'FATAL', code, message }));
        this.closing = true;
        this.socket.end();
    }
}

/** Starts a protocol-v3 server that accepts real `psql` and `pg` clients. */
export function startPostgresServer(options: PostgresServerOptions = {}): Promise<PostgresServerHandle> {
    const sockets = new Set<net.Socket>();
    const host = options.host ?? '127.0.0.1';
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const session = new Session(socket, options);
        session.start();
    });

    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(options.port ?? 0, host, () => {
            server.off('error', onError);
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({
                host,
                port,
                close: () =>
                    new Promise<void>((done) => {
                        for (const socket of sockets) socket.destroy();
                        sockets.clear();
                        server.close(() => done());
                    }),
            });
        });
    });
}
