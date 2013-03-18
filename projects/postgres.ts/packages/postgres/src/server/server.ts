import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';

import { loadNative, type ServerStore } from '../native.ts';
import { ServerError } from './errors.ts';
import { storageFor } from './store.ts';
import { Database, type Storage } from './sql/database.ts';
import { describeSelect, runStatement, type Field, type Outcome } from './sql/engine.ts';
import { parseStatement } from './sql/parser.ts';
import { TEXT, formatValue, typeLength, typeOid, type SqlValue } from './sql/types.ts';
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
    /** Stops listening, destroys every open session and releases the lock. */
    close(): Promise<void>;
}

export { ServerError };

const TEXT_OID = typeOid(TEXT);

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

/** Runs one statement: session GUCs first, then the SQL engine. */
function runSql(state: SessionState, database: Database, sql: string, parameters: SqlValue[]): Outcome {
    const statement = sql.trim();

    const set = /^(?:set|set\s+session|set\s+local)\s+([a-z_][a-z0-9_.]*)\s*(?:=|to)\s*([\s\S]+)$/i.exec(statement);
    if (set && set[1] !== undefined && set[2] !== undefined) {
        const name = set[1].toLowerCase();
        state.parameters.set(name, unquote(set[2]));
        return { kind: 'command', tag: 'SET' };
    }

    const show = /^show\s+([a-z_][a-z0-9_.]*)$/i.exec(statement);
    if (show && show[1] !== undefined) {
        const name = show[1].toLowerCase();
        const value = state.parameters.get(name);
        if (value === undefined) throw new ServerError('42704', `unrecognized configuration parameter "${name}"`);
        return { kind: 'rows', fields: [{ name, type: TEXT }], rows: [[value]], tag: 'SHOW' };
    }

    return runStatement(database, parseStatement(statement), parameters);
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
    private readonly user: string;
    private readonly database: string;
    private readonly auth: ServerAuth;
    private readonly storage: Storage;
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

    constructor(socket: net.Socket, options: PostgresServerOptions, storage: Storage) {
        this.socket = socket;
        this.user = options.user ?? 'postgres';
        this.database = options.database ?? 'postgres';
        this.auth = options.auth ?? 'trust';
        this.storage = storage;
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

        const database = Database.open(this.storage);
        const outcomes: Outcome[] = [];
        try {
            for (const statement of statements) outcomes.push(runSql(state, database, statement, []));
        } catch (error) {
            // Statements that already ran are reported, the whole batch is discarded.
            for (const outcome of outcomes) this.emitOutcome(outcome);
            this.sendError(error);
            this.socket.write(readyForQuery('I'));
            return;
        }
        try {
            database.commit();
        } catch (error) {
            this.sendError(error);
            this.socket.write(readyForQuery('I'));
            return;
        }
        for (const outcome of outcomes) this.emitOutcome(outcome);
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
        const show = /^show\s+([a-z_][a-z0-9_.]*)$/i.exec(statement);
        if (show && show[1] !== undefined) {
            return rowDescription([{ name: show[1].toLowerCase(), typeOid: TEXT_OID, typeLength: -1 }]);
        }
        const parsed = parseStatement(statement);
        if (parsed.kind !== 'select') return noData();
        const placeholders = Array.from({ length: parameterCount }, () => null);
        const database = Database.open(this.storage);
        return rowDescription(wireFields(describeSelect(database, parsed, placeholders)));
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
            const database = Database.open(this.storage);
            const outcome = runSql(state, database, prepared.sql, portal.parameters);
            database.commit();
            this.emitOutcome(outcome, portal.described);
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
        if (outcome.kind === 'command') {
            this.socket.write(commandComplete(outcome.tag));
            return;
        }
        if (!described) this.socket.write(rowDescription(wireFields(outcome.fields)));
        for (const values of wireRows(outcome)) this.socket.write(dataRow(values));
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
    const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-data-'));
    let store: ServerStore;
    try {
        store = new (loadNative().ServerStore)(dataDir);
    } catch (error) {
        return Promise.reject(error);
    }
    const storage = storageFor(store);

    const sockets = new Set<net.Socket>();
    const host = options.host ?? '127.0.0.1';
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const session = new Session(socket, options, storage);
        session.start();
    });

    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            store.close();
            reject(error);
        };
        server.once('error', onError);
        server.listen(options.port ?? 0, host, () => {
            server.off('error', onError);
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({
                host,
                port,
                dataDir,
                close: () =>
                    new Promise<void>((done) => {
                        for (const socket of sockets) socket.destroy();
                        sockets.clear();
                        server.close(() => {
                            store.close();
                            done();
                        });
                    }),
            });
        });
    });
}
