import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import pg from 'pg';
import copyStreams from 'pg-copy-streams';

import { mustRun } from './process.mjs';
import { startPostgresServer } from '../../postgres/dist/server/server.js';

const PROTOCOL_VERSION = 196608;

function frame(tag, payload = Buffer.alloc(0)) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 4);
    return Buffer.concat([Buffer.from(tag), length, payload]);
}

function startupPacket(parameters) {
    const body = [];
    for (const [name, value] of Object.entries(parameters)) body.push(Buffer.from(name), Buffer.from([0]), Buffer.from(value), Buffer.from([0]));
    body.push(Buffer.from([0]));
    const payload = Buffer.concat(body);
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 8);
    const version = Buffer.alloc(4);
    version.writeInt32BE(PROTOCOL_VERSION);
    return Buffer.concat([length, version, payload]);
}

function passwordPacket(password) {
    return frame('p', Buffer.concat([Buffer.from(password), Buffer.from([0])]));
}

function errorFields(payload) {
    const result = { severity: '', code: '', message: '', detail: '', schema: '', table: '', column: '', dataType: '', constraint: '', file: '', line: '', routine: '' };
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
        const kind = String.fromCharCode(payload[offset]);
        const end = payload.indexOf(0, offset + 1);
        const value = payload.subarray(offset + 1, end).toString('utf8');
        if (kind === 'S') result.severity = value;
        if (kind === 'V') result.severity = value;
        if (kind === 'C') result.code = value;
        if (kind === 'M') result.message = value;
        if (kind === 'D') result.detail = value;
        if (kind === 's') result.schema = value;
        if (kind === 't') result.table = value;
        if (kind === 'c') result.column = value;
        if (kind === 'd') result.dataType = value;
        if (kind === 'n') result.constraint = value;
        if (kind === 'F') result.file = value;
        if (kind === 'L') result.line = value;
        if (kind === 'R') result.routine = value;
        offset = end + 1;
    }
    return result;
}

function rowFields(payload) {
    const count = payload.readInt16BE(0);
    const fields = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const end = payload.indexOf(0, offset);
        const name = payload.subarray(offset, end).toString('utf8');
        offset = end + 1;
        const tableOid = payload.readInt32BE(offset);
        const columnId = payload.readInt16BE(offset + 4);
        const typeOid = payload.readInt32BE(offset + 6);
        const typeLength = payload.readInt16BE(offset + 10);
        const typeModifier = payload.readInt32BE(offset + 12);
        const format = payload.readInt16BE(offset + 16);
        offset += 18;
        fields.push({ name, tableOid, columnId, typeOid, typeLength, typeModifier, format });
    }
    return fields;
}

function dataRowValues(payload) {
    const count = payload.readInt16BE(0);
    const values = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const length = payload.readInt32BE(offset);
        offset += 4;
        if (length < 0) {
            values.push(null);
            continue;
        }
        values.push(payload.subarray(offset, offset + length).toString('utf8'));
        offset += length;
    }
    return values;
}

/** Builds a `Parse` message with explicit parameter type OIDs. */
function parseFrame(name, sql, oids = []) {
    const parts = [Buffer.from(name), Buffer.from([0]), Buffer.from(sql), Buffer.from([0])];
    const count = Buffer.alloc(2);
    count.writeInt16BE(oids.length);
    parts.push(count);
    for (const oid of oids) {
        const value = Buffer.alloc(4);
        value.writeInt32BE(oid);
        parts.push(value);
    }
    return frame('P', Buffer.concat(parts));
}

/** Builds a `Bind` message whose values are buffers, or `null` for SQL NULL. */
function bindFrame(portal, statement, formats, values) {
    const parts = [Buffer.from(portal), Buffer.from([0]), Buffer.from(statement), Buffer.from([0])];
    const formatCount = Buffer.alloc(2);
    formatCount.writeInt16BE(formats.length);
    parts.push(formatCount);
    for (const format of formats) {
        const value = Buffer.alloc(2);
        value.writeInt16BE(format);
        parts.push(value);
    }
    const valueCount = Buffer.alloc(2);
    valueCount.writeInt16BE(values.length);
    parts.push(valueCount);
    for (const value of values) {
        const length = Buffer.alloc(4);
        if (value === null) {
            length.writeInt32BE(-1);
            parts.push(length);
        } else {
            length.writeInt32BE(value.length);
            parts.push(length, value);
        }
    }
    parts.push(Buffer.from([0, 0]));
    return frame('B', Buffer.concat(parts));
}

function int16Buffer(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(value);
    return buffer;
}

function int32Buffer(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
}

function bigintBuffer(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(value);
    return buffer;
}

class Wire {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.queue = [];
        this.closed = false;
        this.waiter = null;
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            let offset = 0;
            while (this.buffer.length - offset >= 5) {
                const length = this.buffer.readInt32BE(offset + 1);
                if (this.buffer.length - offset - 1 < length) break;
                this.queue.push({
                    tag: String.fromCharCode(this.buffer[offset]),
                    payload: this.buffer.subarray(offset + 5, offset + 1 + length),
                });
                offset += 1 + length;
            }
            this.buffer = this.buffer.subarray(offset);
            this.wake();
        });
        socket.on('close', () => {
            this.closed = true;
            this.wake();
        });
    }

    wake() {
        if (this.waiter && (this.queue.length || this.closed)) {
            const next = this.waiter;
            this.waiter = null;
            next();
        }
    }

    next() {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.closed) return Promise.resolve(null);
        return new Promise((resolve) => {
            this.waiter = () => resolve(this.queue.length ? this.queue.shift() : null);
        });
    }

    async readUntilReady() {
        const messages = [];
        for (;;) {
            const message = await this.next();
            if (message === null) return messages;
            messages.push(message);
            if (message.tag === 'Z') return messages;
        }
    }

    async readUntilClose() {
        const messages = [];
        for (;;) {
            const message = await this.next();
            if (message === null) return messages;
            messages.push(message);
        }
    }

    send(message) {
        this.socket.write(message);
    }

    query(sql) {
        this.send(frame('Q', Buffer.concat([Buffer.from(sql), Buffer.from([0])])));
        return this.readUntilReady();
    }

    close() {
        this.send(frame('X'));
        this.socket.destroy();
    }
}

async function openSocket(host, port) {
    const socket = net.connect(port, host);
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    return new Wire(socket);
}

async function openTrustSession(host, port) {
    const wire = await openSocket(host, port);
    wire.send(startupPacket({ user: 'postgres', database: 'postgres', application_name: 'wire-probe' }));
    await wire.readUntilReady();
    return wire;
}

function requireTags(messages, expected) {
    const tags = messages.map((message) => message.tag).join('');
    if (tags !== expected) throw new Error(`expected tags '${expected}', received '${tags}'`);
}

function firstRow(messages) {
    const rows = messages.filter((message) => message.tag === 'D').map((message) => dataRowValues(message.payload));
    if (rows.length !== 1) throw new Error(`expected one data row, received ${rows.length}`);
    return rows[0];
}

function onlyError(messages) {
    const errors = messages.filter((message) => message.tag === 'E');
    if (errors.length !== 1) throw new Error(`expected one ErrorResponse, received ${errors.length}`);
    return errorFields(errors[0].payload);
}

export async function runServerStage(repositoryRoot, harnessDir) {
    await mustRun('pnpm', ['run', 'build:ts'], { cwd: repositoryRoot });

    const lines = [];
    let executed = 0;
    let failed = 0;
    const check = async (name, body) => {
        executed += 1;
        try {
            await body();
            lines.push(`ok ${name}`);
        } catch (error) {
            failed += 1;
            lines.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };

    const trust = await startPostgresServer({});
    const password = await startPostgresServer({ auth: { password: 'batch1-secret' } });
    const batch2 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch2-')) });
    const batch3 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch3-')) });
    const batch4 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch4-')) });
    const batch5 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch5-')) });
    const batch7 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch7-')) });
    const batch8 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch8-')) });
    const batch9 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch9-')) });
    const batch9fixture = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch9-fixture-')) });
    const batch10 = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-batch10-')) });
    const batchMeta = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-meta-')) });
    const batchTx = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-tx-')) });
    const batchTxVis = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-tx-vis-')) });
    const batchTxVerbose = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-tx-verbose-')) });
    const batchTxDeadlock = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-tx-deadlock-')) });
    const batchTxDisc = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-tx-disc-')) });
    const batchJoin = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-join-')) });
    const batchAgg = await startPostgresServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-agg-')) });
    try {
        await check('startup/trust', async () => {
            const wire = await openSocket(trust.host, trust.port);
            wire.send(startupPacket({ user: 'postgres', database: 'postgres', application_name: 'trust' }));
            const messages = await wire.readUntilReady();
            assert(messages[0]?.tag === 'R' && messages[0].payload.readInt32BE(0) === 0, 'trust startup must answer AuthenticationOk');
            assert(messages.filter((message) => message.tag === 'S').length === 13, 'thirteen ParameterStatus messages');
            assert(messages.filter((message) => message.tag === 'K').length === 1, 'one BackendKeyData');
            requireTags(messages.slice(-1), 'Z');
            wire.close();
        });

        await check('simple/select-1', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const messages = await wire.query('SELECT 1');
            requireTags(messages, 'TDCZ');
            const [field] = rowFields(messages[0].payload);
            assert(field.name === '?column?' && field.typeOid === 23, `field is ${field.name}/${field.typeOid}`);
            assert(JSON.stringify(firstRow(messages)) === '["1"]', `row is ${JSON.stringify(firstRow(messages))}`);
            assert(messages[2].payload.subarray(0, -1).toString('utf8') === 'SELECT 1', 'command tag is SELECT 1');
            wire.close();
        });

        await check('session/set-show', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const set = await wire.query("SET application_name = 'batch-one'");
            requireTags(set, 'SCZ');
            const status = set.find((message) => message.tag === 'S');
            assert(status?.payload.toString('utf8') === 'application_name\0batch-one\0', 'application_name is reported');
            const show = await wire.query('SHOW application_name');
            requireTags(show, 'TDCZ');
            assert(JSON.stringify(firstRow(show)) === '["batch-one"]', `SHOW returned ${JSON.stringify(firstRow(show))}`);
            const version = await wire.query('SHOW server_version');
            assert(JSON.stringify(firstRow(version)) === '["16.9"]', `server_version is ${JSON.stringify(firstRow(version))}`);
            wire.close();
        });

        await check('error/unknown-statement', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const messages = await wire.query('ALTER TABLE batch_one ADD COLUMN a int');
            requireTags(messages, 'EZ');
            const error = onlyError(messages);
            assert(error.code === '0A000' && error.message === 'feature not supported', `error is ${error.code} ${error.message}`);
            const after = await wire.query('SELECT 1');
            requireTags(after, 'TDCZ');
            wire.close();
        });

        await check('error/unknown-guc', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const messages = await wire.query('SHOW not_a_setting');
            requireTags(messages, 'EZ');
            const error = onlyError(messages);
            assert(error.code === '42704' && error.message.includes('"not_a_setting"'), `error is ${error.code} ${error.message}`);
            wire.close();
        });

        await check('simple/multi-statement', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const messages = await wire.query("SELECT 1; SELECT 'two'");
            requireTags(messages, 'TDCTDCZ');
            const [second] = rowFields(messages[3].payload);
            assert(second.typeOid === 25, `text literal must be oid 25, received ${second.typeOid}`);
            assert(JSON.stringify(firstRow(messages.slice(3))) === '["two"]', 'second statement value');
            wire.close();
        });

        await check('simple/empty-query', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const messages = await wire.query('; -- nothing but a comment');
            requireTags(messages, 'IZ');
            wire.close();
        });

        await check('extended/select-1', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const name = Buffer.from([0]);
            wire.send(frame('P', Buffer.concat([name, Buffer.from('SELECT 1'), Buffer.from([0]), Buffer.from([0, 0])])));
            wire.send(
                frame(
                    'B',
                    Buffer.concat([name, name, Buffer.from([0, 0]), Buffer.from([0, 0]), Buffer.from([0, 0])]),
                ),
            );
            wire.send(frame('D', Buffer.concat([Buffer.from('P'), name])));
            wire.send(frame('E', Buffer.concat([name, Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            assert(JSON.stringify(firstRow(messages)) === '["1"]', 'extended row');
            wire.close();
        });

        await check('extended/null-parameter', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const name = Buffer.from([0]);
            wire.send(frame('P', Buffer.concat([name, Buffer.from('SELECT $1'), Buffer.from([0]), Buffer.from([0, 0])])));
            wire.send(
                frame('B', Buffer.concat([name, name, Buffer.from([0, 0]), Buffer.from([0, 1]), Buffer.from([255, 255, 255, 255])])),
            );
            wire.send(frame('D', Buffer.concat([Buffer.from('P'), name])));
            wire.send(frame('E', Buffer.concat([name, Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            assert(JSON.stringify(firstRow(messages)) === '[null]', `null parameter is ${JSON.stringify(firstRow(messages))}`);
            wire.close();
        });

        await check('session/guc-canonical', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const showZone = await wire.query('SHOW TimeZone');
            requireTags(showZone, 'TDCZ');
            const [zoneField] = rowFields(showZone[0].payload);
            assert(zoneField.name === 'TimeZone' && zoneField.typeOid === 25, `SHOW TimeZone field is ${zoneField.name}/${zoneField.typeOid}`);
            assert(JSON.stringify(firstRow(showZone)) === '["UTC"]', `TimeZone is ${JSON.stringify(firstRow(showZone))}`);
            const showStyle = await wire.query('SHOW datestyle');
            const [styleField] = rowFields(showStyle[0].payload);
            assert(styleField.name === 'DateStyle', `SHOW datestyle field is ${styleField.name}`);
            assert(JSON.stringify(firstRow(showStyle)) === '["ISO, MDY"]', `DateStyle is ${JSON.stringify(firstRow(showStyle))}`);
            const set = await wire.query("SET datestyle TO 'German'");
            requireTags(set, 'SCZ');
            const status = set.find((message) => message.tag === 'S');
            assert(status?.payload.toString('utf8') === 'DateStyle\0German, MDY\0', `DateStyle status is ${status?.payload.toString('utf8')}`);
            const normalized = await wire.query('SHOW DateStyle');
            assert(JSON.stringify(firstRow(normalized)) === '["German, MDY"]', `normalized DateStyle is ${JSON.stringify(firstRow(normalized))}`);
            const zone = await wire.query('SET TIME ZONE UTC');
            requireTags(zone, 'SCZ');
            const zoneStatus = zone.find((message) => message.tag === 'S');
            assert(zoneStatus?.payload.toString('utf8') === 'TimeZone\0UTC\0', `TimeZone status is ${zoneStatus?.payload.toString('utf8')}`);
            wire.close();
        });

        await check('extended/binary-int4', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            wire.send(parseFrame('s1', 'SELECT $1::int4', [23]));
            wire.send(bindFrame('p1', 's1', [1], [int32Buffer(42)]));
            wire.send(frame('D', Buffer.concat([Buffer.from('P'), Buffer.from('p1'), Buffer.from([0])])));
            wire.send(frame('E', Buffer.concat([Buffer.from('p1'), Buffer.from([0]), Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            assert(JSON.stringify(firstRow(messages)) === '["42"]', `binary int4 is ${JSON.stringify(firstRow(messages))}`);
            wire.close();
        });

        await check('extended/binary-scalars', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const sql = 'SELECT $1::int2, $2::int8, $3::float4, $4::float8, $5::bool, $6::text, $7::bytea, $8::date, $9::timestamp, $10::uuid';
            wire.send(parseFrame('s1', sql, [21, 20, 700, 701, 16, 25, 17, 1082, 1114, 2950]));
            wire.send(
                bindFrame(
                    'p1',
                    's1',
                    [1],
                    [
                        int16Buffer(42),
                        bigintBuffer(1234567890123n),
                        Buffer.from([0x3f, 0x00, 0x00, 0x00]),
                        Buffer.from([0x3f, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
                        Buffer.from([1]),
                        Buffer.from('hello'),
                        Buffer.from([0xde, 0xad]),
                        int32Buffer(0),
                        bigintBuffer(0n),
                        Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
                    ],
                ),
            );
            wire.send(frame('E', Buffer.concat([Buffer.from('p1'), Buffer.from([0]), Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            const row = firstRow(messages);
            assert(
                JSON.stringify(row) === JSON.stringify(['42', '1234567890123', '0.5', '0.25', 't', 'hello', '\\xdead', '2000-01-01', '2000-01-01 00:00:00', '00112233-4455-6677-8899-aabbccddeeff']),
                `binary scalars are ${JSON.stringify(row)}`,
            );
            wire.close();
        });

        await check('extended/binary-array', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const payload = Buffer.concat([
                int32Buffer(1),
                int32Buffer(0),
                int32Buffer(23),
                int32Buffer(3),
                int32Buffer(1),
                int32Buffer(4),
                int32Buffer(1),
                int32Buffer(4),
                int32Buffer(2),
                int32Buffer(4),
                int32Buffer(3),
            ]);
            wire.send(parseFrame('s1', 'SELECT $1::int4[]', [1007]));
            wire.send(bindFrame('p1', 's1', [1], [payload]));
            wire.send(frame('E', Buffer.concat([Buffer.from('p1'), Buffer.from([0]), Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            assert(JSON.stringify(firstRow(messages)) === '["{1,2,3}"]', `binary array is ${JSON.stringify(firstRow(messages))}`);
            wire.close();
        });

        await check('extended/binary-numeric', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const payload = Buffer.concat([int16Buffer(2), int16Buffer(0), int16Buffer(0), int16Buffer(2), int16Buffer(12), int16Buffer(3400)]);
            wire.send(parseFrame('s1', 'SELECT $1::numeric', [1700]));
            wire.send(bindFrame('p1', 's1', [1], [payload]));
            wire.send(frame('E', Buffer.concat([Buffer.from('p1'), Buffer.from([0]), Buffer.from([0, 0, 0, 0])])));
            wire.send(frame('S'));
            const messages = await wire.readUntilReady();
            requireTags(messages, '12TDCZ');
            assert(JSON.stringify(firstRow(messages)) === '["12.34"]', `binary numeric is ${JSON.stringify(firstRow(messages))}`);
            wire.close();
        });

        await check('catalog/pg-cursors', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const begin = await wire.query('BEGIN');
            requireTags(begin, 'CZ');
            const declare = await wire.query('DECLARE c11 CURSOR FOR SELECT 1 AS n');
            requireTags(declare, 'CZ');
            const rows = await wire.query('SELECT name, statement, is_holdable, is_binary, is_scrollable FROM pg_catalog.pg_cursors');
            requireTags(rows, 'TDCZ');
            assert(JSON.stringify(firstRow(rows))?.startsWith('["c11","DECLARE c11 CURSOR FOR SELECT 1 AS n",') ?? false, `pg_cursors row is ${JSON.stringify(firstRow(rows))}`);
            const commit = await wire.query('COMMIT');
            requireTags(commit, 'CZ');
            const after = await wire.query('SELECT count(*) FROM pg_catalog.pg_cursors');
            assert(JSON.stringify(firstRow(after)) === '["0"]', `pg_cursors after COMMIT is ${JSON.stringify(firstRow(after))}`);
            wire.close();
        });

        await check('session/temp-table', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            const create = await wire.query('CREATE TEMP TABLE b11_temp (id int, v text)');
            assert(create.at(-2)?.payload.subarray(0, -1).toString('utf8') === 'CREATE TABLE', 'CREATE TEMP TABLE tag');
            const insert = await wire.query("INSERT INTO b11_temp VALUES (1, 'one')");
            requireTags(insert, 'CZ');
            const select = await wire.query('SELECT id, v FROM b11_temp');
            requireTags(select, 'TDCZ');
            assert(JSON.stringify(firstRow(select)) === '["1","one"]', `temp row is ${JSON.stringify(firstRow(select))}`);
            const persistence = await wire.query("SELECT relpersistence FROM pg_catalog.pg_class WHERE relname = 'b11_temp'");
            assert(JSON.stringify(firstRow(persistence)) === '["t"]', `relpersistence is ${JSON.stringify(firstRow(persistence))}`);
            await wire.query('DROP TABLE b11_temp');
            wire.close();
            const second = await openTrustSession(trust.host, trust.port);
            const survivors = await second.query("SELECT count(*) FROM pg_catalog.pg_class WHERE relname = 'b11_temp'");
            assert(JSON.stringify(firstRow(survivors)) === '["0"]', `temp table survived the session: ${JSON.stringify(firstRow(survivors))}`);
            second.close();
        });

        await check('error/structured-fields', async () => {
            const wire = await openTrustSession(trust.host, trust.port);
            await wire.query('CREATE TABLE b11_err (id int primary key, v int not null check (v > 0))');
            const nulls = await wire.query('INSERT INTO b11_err VALUES (1, NULL)');
            requireTags(nulls, 'EZ');
            const nullError = onlyError(nulls);
            assert(nullError.code === '23502', `not-null code is ${nullError.code}`);
            assert(nullError.schema === 'public' && nullError.table === 'b11_err' && nullError.column === 'v', `not-null fields are ${JSON.stringify(nullError)}`);
            assert(nullError.file !== '' && nullError.line !== '' && nullError.routine !== '', 'not-null carries source fields');
            const check = await wire.query('INSERT INTO b11_err VALUES (2, 0)');
            const checkError = onlyError(check);
            assert(checkError.code === '23514' && checkError.constraint === 'b11_err_v_check', `check fields are ${JSON.stringify(checkError)}`);
            assert(checkError.schema === 'public' && checkError.table === 'b11_err', 'check carries schema and table');
            await wire.query('INSERT INTO b11_err VALUES (1, 1)');
            const duplicate = await wire.query('INSERT INTO b11_err VALUES (1, 2)');
            const duplicateError = onlyError(duplicate);
            assert(duplicateError.code === '23505' && duplicateError.constraint === 'b11_err_pkey', `unique fields are ${JSON.stringify(duplicateError)}`);
            wire.close();
        });

        await check('driver/temp-table', async () => {
            const client = new pg.Client({ host: trust.host, port: trust.port, user: 'postgres', database: 'postgres' });
            await client.connect();
            try {
                await client.query('CREATE TEMP TABLE b11_driver (n int)');
                await client.query('INSERT INTO b11_driver VALUES ($1)', [7]);
                const result = await client.query('SELECT n FROM b11_driver');
                assert(result.rows[0]?.n === 7, `driver temp row is ${JSON.stringify(result.rows)}`);
            } finally {
                await client.end();
            }
        });

        await check('auth/password-accepted', async () => {
            const wire = await openSocket(password.host, password.port);
            wire.send(startupPacket({ user: 'postgres', database: 'postgres' }));
            const request = await wire.next();
            assert(request?.tag === 'R' && request.payload.readInt32BE(0) === 3, 'cleartext password request');
            wire.send(passwordPacket('batch1-secret'));
            const messages = await wire.readUntilReady();
            assert(messages[0]?.tag === 'R' && messages[0].payload.readInt32BE(0) === 0, 'AuthenticationOk after the password');
            const result = await wire.query('SELECT 1');
            requireTags(result, 'TDCZ');
            wire.close();
        });

        await check('auth/password-rejected', async () => {
            const wire = await openSocket(password.host, password.port);
            wire.send(startupPacket({ user: 'postgres', database: 'postgres' }));
            const request = await wire.next();
            assert(request?.tag === 'R' && request.payload.readInt32BE(0) === 3, 'cleartext password request');
            wire.send(passwordPacket('wrong-password'));
            const messages = await wire.readUntilClose();
            const error = onlyError(messages);
            assert(error.severity === 'FATAL' && error.code === '28P01', `error is ${error.severity} ${error.code}`);
            assert(messages.every((message) => message.tag !== 'Z'), 'a rejected password must not reach ReadyForQuery');
        });

        await check('startup/unknown-database', async () => {
            const wire = await openSocket(trust.host, trust.port);
            wire.send(startupPacket({ user: 'postgres', database: 'missing' }));
            const messages = await wire.readUntilClose();
            const error = onlyError(messages);
            assert(error.severity === 'FATAL' && error.code === '3D000', `error is ${error.severity} ${error.code}`);
        });

        await check('driver/pg-trust', async () => {
            const client = new pg.Client({ host: trust.host, port: trust.port, user: 'postgres', database: 'postgres' });
            await client.connect();
            try {
                const one = await client.query('SELECT 1');
                assert(one.rows[0]?.['?column?'] === 1, `pg returned ${JSON.stringify(one.rows)}`);
                await client.query("SET application_name = 'pg-batch-one'");
                const show = await client.query('SHOW application_name');
                assert(show.rows[0]?.application_name === 'pg-batch-one', `pg SHOW returned ${JSON.stringify(show.rows)}`);
                const failure = await client.query('ALTER TABLE batch_one ADD COLUMN a int').then(
                    () => null,
                    (error) => error,
                );
                assert(failure && failure.code === '0A000', `pg error is ${failure?.code}`);
                const again = await client.query('SELECT 1');
                assert(again.rows[0]?.['?column?'] === 1, 'the session survives an ErrorResponse');
            } finally {
                await client.end();
            }
        });

        await check('driver/pg-password', async () => {
            const client = new pg.Client({
                host: password.host,
                port: password.port,
                user: 'postgres',
                database: 'postgres',
                password: 'batch1-secret',
            });
            await client.connect();
            try {
                const one = await client.query('SELECT 1');
                assert(one.rows[0]?.['?column?'] === 1, 'pg with password returned a row');
            } finally {
                await client.end();
            }
            const rejected = new pg.Client({
                host: password.host,
                port: password.port,
                user: 'postgres',
                database: 'postgres',
                password: 'wrong',
            });
            const error = await rejected.connect().then(
                () => null,
                (reason) => reason,
            );
            assert(error && error.code === '28P01', `pg rejection is ${error?.code}`);
        });

        const withClient = async (server, body) => {
            const client = new pg.Client({ host: server.host, port: server.port, user: 'postgres', database: 'postgres' });
            await client.connect();
            try {
                return await body(client);
            } finally {
                await client.end();
            }
        };

        await check('ddl/create-defaults', async () => {
            await withClient(batch2, async (client) => {
                const created = await client.query("CREATE TABLE t (id int PRIMARY KEY, name text DEFAULT 'x', code varchar(20))");
                assert(created.command === 'CREATE', `command tag is ${created.command}`);
                const inserted = await client.query('INSERT INTO t (id) VALUES (1), (2) RETURNING id, name, code');
                assert(inserted.command === 'INSERT' && inserted.rowCount === 2, `INSERT is ${inserted.command}/${inserted.rowCount}`);
                assert(
                    JSON.stringify(inserted.rows) ===
                        JSON.stringify([
                            { id: 1, name: 'x', code: null },
                            { id: 2, name: 'x', code: null },
                        ]),
                    `defaults are ${JSON.stringify(inserted.rows)}`,
                );
                const updated = await client.query("UPDATE t SET name = 'y' WHERE id = 2 RETURNING id, name");
                assert(updated.command === 'UPDATE' && updated.rowCount === 1, `UPDATE is ${updated.command}/${updated.rowCount}`);
                assert(updated.rows[0]?.name === 'y', 'UPDATE RETURNING');
                const deleted = await client.query('DELETE FROM t WHERE id = 1');
                assert(deleted.command === 'DELETE' && deleted.rowCount === 1, `DELETE is ${deleted.command}/${deleted.rowCount}`);
            });
        });

        await check('ddl/error-codes', async () => {
            await withClient(batch2, async (client) => {
                const code = async (sql) => {
                    try {
                        await client.query(sql);
                        return null;
                    } catch (error) {
                        return error.code;
                    }
                };
                assert((await code("INSERT INTO t (id) VALUES ('bad')")) === '22P02', '22P02');
                assert((await code('SELECT nope FROM t')) === '42703', '42703');
                assert((await code('SELECT * FROM missing')) === '42P01', '42P01');
                assert((await code('CREATE TABLE t (x int)')) === '42P07', '42P07');
                assert((await code('INSERT INTO t (id) VALUES (NULL)')) === '23502', '23502');
                const duplicate = await client.query('INSERT INTO t (id) VALUES (2)').then(
                    () => null,
                    (error) => error,
                );
                assert(duplicate?.code === '23505', `23505 is ${duplicate?.code}`);
                assert(duplicate?.detail === 'Key (id)=(2) already exists.', `detail is ${duplicate?.detail}`);
            });
        });

        await check('batch/atomic', async () => {
            await withClient(batch2, async (client) => {
                const failure = await client
                    .query("INSERT INTO t (id, name) VALUES (3, 'c'); INSERT INTO t (id) VALUES ('bad')")
                    .then(() => null, (error) => error);
                assert(failure?.code === '22P02', `batch error is ${failure?.code}`);
                const after = await client.query('SELECT id FROM t ORDER BY id');
                assert(JSON.stringify(after.rows) === '[{"id":2}]', `rows after rollback are ${JSON.stringify(after.rows)}`);
            });
        });

        await check('order/null-placement', async () => {
            await withClient(batch2, async (client) => {
                await client.query('CREATE TABLE n (v int, w int)');
                await client.query('INSERT INTO n VALUES (1,2),(NULL,1),(2,1),(NULL,2)');
                const asc = await client.query('SELECT v FROM n ORDER BY v');
                assert(JSON.stringify(asc.rows) === '[{"v":1},{"v":2},{"v":null},{"v":null}]', `ASC ${JSON.stringify(asc.rows)}`);
                const desc = await client.query('SELECT v FROM n ORDER BY v DESC');
                assert(JSON.stringify(desc.rows) === '[{"v":null},{"v":null},{"v":2},{"v":1}]', `DESC ${JSON.stringify(desc.rows)}`);
                const first = await client.query('SELECT v FROM n ORDER BY v NULLS FIRST');
                assert(JSON.stringify(first.rows) === '[{"v":null},{"v":null},{"v":1},{"v":2}]', `NULLS FIRST ${JSON.stringify(first.rows)}`);
                const last = await client.query('SELECT v,w FROM n ORDER BY v ASC, w DESC');
                assert(
                    JSON.stringify(last.rows) ===
                        '[{"v":1,"w":2},{"v":2,"w":1},{"v":null,"w":2},{"v":null,"w":1}]',
                    `multi-column ${JSON.stringify(last.rows)}`,
                );
                await client.query('DROP TABLE n');
            });
        });

        await check('catalog/fixtures', async () => {
            const fixture = JSON.parse(fs.readFileSync(path.join(harnessDir, 'fixtures', 'catalog-queries.json'), 'utf8'));
            await withClient(batch2, async (client) => {
                const oid = await client.query("SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relname = 't'");
                assert(oid.rows.length === 1, `catalog lookup returned ${oid.rows.length} rows`);
                const oidText = String(oid.rows[0].oid);
                for (const item of fixture.cases) {
                    const result = await client.query(item.sql.replaceAll('__OID__', oidText));
                    assert(result.rowCount === item.rows, `${item.name}: ${result.rowCount} rows, expected ${item.rows}`);
                }
            });
        });

        await check('restart/persistence', async () => {
            const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-persist-'));
            let persist = await startPostgresServer({ dataDir: persistDir });
            try {
                await withClient(persist, async (client) => {
                    await client.query('CREATE TABLE p (id int PRIMARY KEY, v text)');
                    await client.query("INSERT INTO p VALUES (7, 'kept')");
                });
                await persist.close();
                persist = await startPostgresServer({ dataDir: persistDir });
                await withClient(persist, async (client) => {
                    const rows = await client.query('SELECT id, v FROM p');
                    assert(JSON.stringify(rows.rows) === '[{"id":7,"v":"kept"}]', `persisted rows are ${JSON.stringify(rows.rows)}`);
                });
                const locked = await startPostgresServer({ dataDir: persistDir }).then(
                    () => null,
                    (error) => error,
                );
                assert(locked !== null && /already exists/.test(locked.message), `lock error is ${locked?.message}`);
            } finally {
                await persist.close();
            }
        });

        // Batch 3 fixtures: numeric/check/serial/foreign keys and indexes.
        const setup = fs.readFileSync(path.join(harnessDir, 'fixtures', 'b3-setup.sql'), 'utf8');
        await withClient(batch3, async (client) => {
            for (const statement of setup.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
                await client.query(statement);
            }
        });

        // Batch 4 fixtures: joins, grouping, subqueries, set operations and windows.
        const setupB4 = fs.readFileSync(path.join(harnessDir, 'fixtures', 'b4-setup.sql'), 'utf8');
        await withClient(batch4, async (client) => {
            for (const statement of setupB4.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
                await client.query(statement);
            }
        });

        const psql = process.env.PSQL_BIN;
        if (psql) {
            const runOn = (server, sql, password = '') =>
                new Promise((resolve, reject) => {
                    const child = spawn(
                        psql,
                        ['-h', server.host, '-p', String(server.port), '-U', 'postgres', '-d', 'postgres', '-c', sql],
                        { env: { ...process.env, PGPASSWORD: password, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] },
                    );
                    let stdout = '';
                    let stderr = '';
                    child.stdout.on('data', (chunk) => {
                        stdout += chunk;
                    });
                    child.stderr.on('data', (chunk) => {
                        stderr += chunk;
                    });
                    child.once('error', reject);
                    child.once('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
                });
            const run = (sql, password = '') => runOn(trust, sql, password);
            const runFileOn = (server, file) =>
                new Promise((resolve, reject) => {
                    const child = spawn(
                        psql,
                        ['-h', server.host, '-p', String(server.port), '-U', 'postgres', '-d', 'postgres', '-f', file],
                        { env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] },
                    );
                    let stdout = '';
                    let stderr = '';
                    child.stdout.on('data', (chunk) => {
                        stdout += chunk;
                    });
                    child.stderr.on('data', (chunk) => {
                        stderr += chunk;
                    });
                    child.once('error', reject);
                    child.once('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
                });

            await check('psql/select-1', async () => {
                const result = await run('SELECT 1');
                assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                assert(result.stdout.includes('?column?') && result.stdout.includes('(1 row)'), `psql printed ${result.stdout}`);
                lines.push(`  psql stdout:\n${result.stdout.trimEnd().replace(/^/gm, '    ')}`);
            });

            await check('psql/show-and-set', async () => {
                const result = await run('SHOW server_version');
                assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                assert(result.stdout.includes('16.9'), `psql printed ${result.stdout}`);
                const set = await run("SET application_name = 'psql-batch-one'");
                assert(set.status === 0 && set.stdout.includes('SET'), `psql printed ${set.stdout}${set.stderr}`);
            });

            await check('psql/error-then-recover', async () => {
                const failure = await run('ALTER TABLE batch_one ADD COLUMN a int');
                assert(failure.status === 1, `psql exited ${failure.status}`);
                assert(failure.stderr.includes('ERROR:') && failure.stderr.includes('feature not supported'), `psql stderr ${failure.stderr}`);
                const recovery = await run('SELECT 1');
                assert(recovery.status === 0, 'a second psql connection reaches the same server');
                lines.push(`  psql stderr:\n${failure.stderr.trimEnd().replace(/^/gm, '    ')}`);
            });

            await check('psql/describe-dt', async () => {
                const result = await runOn(batch2, '\\dt');
                assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', 'psql-dt.txt'), 'utf8');
                assert(result.stdout === expected, `psql \\dt differs from the real fixture:\n${result.stdout}`);
                lines.push(`  \\dt matches pg16 fixture (${expected.length} bytes)`);
            });

            await check('psql/describe-d-t', async () => {
                const result = await runOn(batch2, '\\d t');
                assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', 'psql-d-t.txt'), 'utf8');
                assert(result.stdout === expected, `psql \\d t differs from the real fixture:\n${result.stdout}`);
                lines.push(`  \\d t matches pg16 fixture (${expected.length} bytes)`);
            });

            const describeB3 = (name, sql, fixture) =>
                check(name, async () => {
                    const result = await runOn(batch3, sql);
                    assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                    const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', fixture), 'utf8');
                    assert(result.stdout === expected, `psql ${sql} differs from the real fixture:\n${result.stdout}`);
                    lines.push(`  ${sql} matches pg16 fixture (${expected.length} bytes)`);
                });

            await describeB3('psql/b3-dt', '\\dt', 'psql-b3-dt.txt');
            await describeB3('psql/b3-d-num', '\\d b3_num', 'psql-b3-d-num.txt');
            await describeB3('psql/b3-d-ck', '\\d b3_ck', 'psql-b3-d-ck.txt');
            await describeB3('psql/b3-d-cascade', '\\d b3_cascade', 'psql-b3-d-cascade.txt');
            await describeB3('psql/b3-d-p', '\\d b3_p', 'psql-b3-d-p.txt');

            // Batch 4: byte-exact comparison against psql 16.9 with `Buffer.compare`.
            const sameBytes = (name, fixture, runBody, label) =>
                check(name, async () => {
                    const result = await runBody();
                    assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                    const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', fixture));
                    const actual = Buffer.from(result.stdout, 'utf8');
                    assert(
                        Buffer.compare(actual, expected) === 0,
                        `${label} differs from the pg16 fixture:\n${result.stdout}`,
                    );
                    lines.push(`  ${label} matches pg16 fixture (${expected.length} bytes)`);
                });
            const sameErrorBytes = (name, fixture, sql, label) =>
                check(name, async () => {
                    const result = await runOn(batch4, sql);
                    assert(result.status === 1, `psql exited ${result.status} for ${sql}`);
                    const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', fixture));
                    const actual = Buffer.from(result.stderr, 'utf8');
                    assert(
                        Buffer.compare(actual, expected) === 0,
                        `${label} differs from the pg16 fixture:\n${result.stderr}`,
                    );
                    lines.push(`  ${label} matches pg16 fixture (${expected.length} bytes)`);
                });

            await sameBytes('psql/b4-dn', 'psql-b4-dn.txt', () => runOn(batch4, '\\dn'), '\\dn');
            await sameBytes('psql/b4-du', 'psql-b4-du.txt', () => runOn(batch4, '\\du'), '\\du');
            await sameBytes('psql/b4-df', 'psql-b4-df.txt', () => runOn(batch4, '\\df'), '\\df');
            await sameBytes('psql/b4-dp', 'psql-b4-dp.txt', () => runOn(batch4, '\\dp'), '\\dp');
            await sameBytes(
                'psql/b4-queries',
                'psql-b4-queries.txt',
                () => runFileOn(batch4, path.join(harnessDir, 'fixtures', 'b4-queries.sql')),
                '-f b4-queries.sql',
            );
            await sameErrorBytes('psql/b4-error-cast', 'psql-b4-error-cast.txt', "SELECT 'oops'::int", "SELECT 'oops'::int");
            await sameErrorBytes(
                'psql/b4-error-relation',
                'psql-b4-error-relation.txt',
                'SELECT * FROM missing_table',
                'SELECT * FROM missing_table',
            );

            // Batch 11: system-catalog meta commands against the same schema
            // that seeded the real 16 oracle. Physical Size cells are masked
            // because the two engines have different storage layouts, every
            // other character has to match byte for byte.
            const metaSetup = fs.readFileSync(path.join(harnessDir, 'fixtures', 'meta-setup.sql'), 'utf8');
            await withClient(batchMeta, async (client) => {
                for (const statement of metaSetup.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
                    await client.query(statement);
                }
            });
            const normalizeMeta = (text) =>
                text
                    .split('\n')
                    .map((line) => {
                        if (/^[\s+-]+$/.test(line)) return '<rule>';
                        if (!line.includes('|')) return line.trim();
                        return line
                            .split('|')
                            .map((cell) => cell.replace(/\b\d+(?:\.\d+)? (?:bytes|kB|MB|GB|TB)\b/g, '<size>').trim())
                            .join('|');
                    })
                    .join('\n');
            const normalizeMessages = (text) =>
                text
                    .split('\n')
                    .filter((line) => line.length > 0)
                    .map((line) => line.replace(/^psql:.*:\d+: /, ''))
                    .join('\n');
            await check('psql/meta-commands', async () => {
                const commands = fs
                    .readFileSync(path.join(harnessDir, 'fixtures', 'psql-meta.sql'), 'utf8')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && !line.startsWith('--'));
                const result = await runFileOn(batchMeta, path.join(harnessDir, 'fixtures', 'psql-meta.sql'));
                assert(result.status === 0, `psql exited ${result.status}: ${result.stderr}`);
                assert(!/ERROR:/.test(result.stderr), `the meta sweep raised a server error:\n${result.stderr}`);
                const expected = fs.readFileSync(path.join(harnessDir, 'fixtures', 'psql-meta.txt'), 'utf8');
                assert(
                    normalizeMeta(result.stdout) === normalizeMeta(expected),
                    `system catalog meta commands differ from the pg16 fixture:\n${result.stdout}`,
                );
                const expectedErr = fs.readFileSync(path.join(harnessDir, 'fixtures', 'psql-meta.err.txt'), 'utf8');
                assert(
                    normalizeMessages(result.stderr) === normalizeMessages(expectedErr),
                    `meta command advisories differ from the pg16 fixture:\n${result.stderr}`,
                );
                const missing = await runOn(batchMeta, '\\d missing_relation');
                assert(!/ERROR:/.test(missing.stderr), `a missing relation raised a server error:\n${missing.stderr}`);
                assert(
                    /Did not find any relation named "missing_relation"/.test(missing.stdout + missing.stderr),
                    `a missing relation did not report the psql advisory:\n${missing.stdout}${missing.stderr}`,
                );
                const recovered = await runOn(batchMeta, 'SELECT 1');
                assert(
                    recovered.status === 0 && recovered.stdout.includes('(1 row)'),
                    `the server did not answer after a missing relation:\n${recovered.stdout}${recovered.stderr}`,
                );
                lines.push(`  ${commands.length} meta commands match the pg16 fixture, Size cells masked`);
            });
        }

        const capture = (promise) => promise.then(() => null, (error) => error);

        await check('b3/numeric', async () => {
            await withClient(batch3, async (client) => {
                const rows = await client.query('SELECT id, amount, qty FROM b3_num ORDER BY id');
                assert(
                    JSON.stringify(rows.rows) === '[{"id":1,"amount":"1.50","qty":"2"},{"id":2,"amount":"-0.01","qty":"1000"}]',
                    `numeric rows are ${JSON.stringify(rows.rows)}`,
                );
                const overflow = await capture(client.query('INSERT INTO b3_num (amount) VALUES (99999999.995)'));
                assert(overflow?.code === '22003', `overflow code is ${overflow?.code}`);
                assert(
                    overflow.detail === 'A field with precision 10, scale 2 must round to an absolute value less than 10^8.',
                    `overflow detail is ${overflow.detail}`,
                );
            });
        });

        await check('b3/check', async () => {
            await withClient(batch3, async (client) => {
                const columnCheck = await capture(client.query('INSERT INTO b3_ck VALUES (2, -1, 0)'));
                assert(columnCheck?.code === '23514' && /b3_ck_v_check/.test(columnCheck.message), `column check is ${columnCheck?.message}`);
                assert(columnCheck.detail === 'Failing row contains (2, -1, 0).', `column check detail is ${columnCheck.detail}`);
                const notValid = await capture(client.query('INSERT INTO b3_ck VALUES (3, 150, 10)'));
                assert(notValid?.code === '23514' && /ck_nv/.test(notValid.message), `NOT VALID check is ${notValid?.message}`);
                const tableCheck = await capture(client.query('INSERT INTO b3_ck VALUES (4, 5, 6)'));
                assert(tableCheck?.code === '23514' && /ck_w/.test(tableCheck.message), `table check is ${tableCheck?.message}`);
                const validated = await client.query('ALTER TABLE b3_ck VALIDATE CONSTRAINT ck_nv');
                assert(validated.command === 'ALTER', `validate returned ${validated.command}`);
            });
        });

        await check('b3/serial', async () => {
            await withClient(batch3, async (client) => {
                const sequence = await client.query("SELECT nextval('b3_num_id_seq') AS next, lastval() AS last, currval('b3_num_id_seq') AS curr");
                assert(JSON.stringify(sequence.rows) === '[{"next":"3","last":"3","curr":"3"}]', `sequence rows are ${JSON.stringify(sequence.rows)}`);
                const inserted = await client.query('INSERT INTO b3_num (amount) VALUES (7.00) RETURNING id');
                assert(JSON.stringify(inserted.rows) === '[{"id":4}]', `serial insert is ${JSON.stringify(inserted.rows)}`);
            });
        });

        await check('b3/serial-burn', async () => {
            await withClient(batch3, async (client) => {
                const duplicate = await capture(client.query('INSERT INTO b3_num (amount, qty) VALUES (9.99, 2)'));
                assert(duplicate?.code === '23505', `duplicate code is ${duplicate?.code}`);
                assert(duplicate.detail === 'Key (qty)=(2) already exists.', `duplicate detail is ${duplicate.detail}`);
            });
            await withClient(batch3, async (client) => {
                const rows = await client.query('INSERT INTO b3_num (amount, qty) VALUES (10.00, NULL), (11.00, NULL) RETURNING id');
                assert(JSON.stringify(rows.rows) === '[{"id":6},{"id":7}]', `a failed insert must burn its sequence value, got ${JSON.stringify(rows.rows)}`);
            });
        });

        await check('b3/foreign-keys', async () => {
            await withClient(batch3, async (client) => {
                const child = await capture(client.query('INSERT INTO b3_cascade VALUES (10, 99)'));
                assert(child?.code === '23503' && /b3_cascade_pid_fkey/.test(child.message), `child FK is ${child?.message}`);
                assert(child.detail === 'Key (pid)=(99) is not present in table "b3_p".', `child FK detail is ${child.detail}`);
                await client.query('INSERT INTO b3_cascade VALUES (10, 1), (11, 2)');
                await client.query('INSERT INTO b3_setnull VALUES (20, 1)');
                await client.query('INSERT INTO b3_restrict VALUES (30, 1)');
                const parent = await capture(client.query('DELETE FROM b3_p WHERE id = 1'));
                assert(parent?.code === '23503' && /b3_restrict/.test(parent.message), `parent FK is ${parent?.message}`);
                await client.query('DELETE FROM b3_restrict WHERE id = 30');
                await client.query('DELETE FROM b3_p WHERE id = 1');
                const cascaded = await client.query('SELECT id, pid FROM b3_cascade ORDER BY id');
                assert(JSON.stringify(cascaded.rows) === '[{"id":11,"pid":2}]', `cascade rows are ${JSON.stringify(cascaded.rows)}`);
                const nulled = await client.query('SELECT id, pid FROM b3_setnull');
                assert(JSON.stringify(nulled.rows) === '[{"id":20,"pid":null}]', `set-null rows are ${JSON.stringify(nulled.rows)}`);
            });
        });

        await check('b3/transactions', async () => {
            await withClient(batch3, async (client) => {
                await client.query('BEGIN');
                await client.query('CREATE TABLE b3_tx (id int)');
                await client.query('ROLLBACK');
                const gone = await capture(client.query('SELECT * FROM b3_tx'));
                assert(gone?.code === '42P01', `rolled back DDL still visible: ${gone?.code}`);
                await client.query('BEGIN');
                await client.query('SAVEPOINT s1');
                await client.query('INSERT INTO b3_ck VALUES (8, 1, 0)');
                await client.query('SAVEPOINT s2');
                await client.query('INSERT INTO b3_ck VALUES (9, 2, 1)');
                await client.query('ROLLBACK TO s2');
                await client.query('INSERT INTO b3_ck VALUES (10, 3, 1)');
                await client.query('RELEASE s2');
                await client.query('COMMIT');
                const kept = await client.query('SELECT id FROM b3_ck ORDER BY id');
                assert(JSON.stringify(kept.rows) === '[{"id":1},{"id":8},{"id":10}]', `savepoint rows are ${JSON.stringify(kept.rows)}`);
                await client.query('BEGIN');
                const failed = await capture(client.query('SELECT * FROM b3_missing'));
                assert(failed?.code === '42P01', `missing relation code is ${failed?.code}`);
                const aborted = await capture(client.query('SELECT 1'));
                assert(aborted?.code === '25P02', `aborted transaction code is ${aborted?.code}`);
                await client.query('ROLLBACK');
                await client.query('BEGIN');
                const missing = await capture(client.query('ROLLBACK TO absent'));
                assert(missing?.code === '3B001', `missing savepoint code is ${missing?.code}`);
                await client.query('ROLLBACK');
            });
            if (process.env.PSQL_BIN) {
                const warning = await new Promise((resolve, reject) => {
                    const child = spawn(process.env.PSQL_BIN, ['-h', batch3.host, '-p', String(batch3.port), '-U', 'postgres', '-d', 'postgres', '-c', 'COMMIT'], {
                        env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' },
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    let stderr = '';
                    child.stderr.on('data', (chunk) => {
                        stderr += chunk;
                    });
                    child.once('error', reject);
                    child.once('close', () => resolve(stderr));
                });
                assert(warning.includes('WARNING:  there is no transaction in progress'), `COMMIT warning is ${warning}`);
            }
        });

        await check('b3/indexes', async () => {
            await withClient(batch3, async (client) => {
                const dropped = await client.query('DROP INDEX b3_num_partial');
                assert(dropped.command === 'DROP', `drop index returned ${dropped.command}`);
                const gone = await client.query("SELECT relname FROM pg_class WHERE relname = 'b3_num_partial'");
                assert(gone.rowCount === 0, `index catalog row survived the drop: ${JSON.stringify(gone.rows)}`);
            });
        });

        await check('lock/concurrent-startup', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-lock-'));
            const first = await startPostgresServer({ dataDir: dir });
            const pidFile = path.join(dir, 'postmaster.pid');
            try {
                assert(fs.existsSync(pidFile), 'postmaster.pid must live in the data directory');
                assert(fs.readFileSync(pidFile, 'utf8').trim().length > 0, 'postmaster.pid must record the lock holder');
                const second = await capture(startPostgresServer({ dataDir: dir }));
                assert(second !== null && /already exists/.test(second.message), `second startup is ${second?.message}`);
            } finally {
                await first.close();
            }
            assert(!fs.existsSync(pidFile), 'a clean shutdown removes postmaster.pid');
        });

        await check('lock/abnormal-exit', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-crash-'));
            const bin = path.join(repositoryRoot, 'projects', 'postgres.ts', 'packages', 'postgres', 'bin', 'postgres-server.mjs');
            const child = spawn(process.execPath, [bin, '--port', '0', '--data-dir', dir], { stdio: 'ignore' });
            const pidFile = path.join(dir, 'postmaster.pid');
            const deadline = Date.now() + 10_000;
            while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((rest) => setTimeout(rest, 50));
            assert(fs.existsSync(pidFile), 'a starting server writes postmaster.pid');
            const holder = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0];
            assert(holder === String(child.pid), `postmaster.pid records ${holder}, child is ${child.pid}`);
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
            assert(fs.existsSync(pidFile), 'a crashed server leaves postmaster.pid behind');
            const restart = await capture(startPostgresServer({ dataDir: dir }));
            assert(restart !== null && /already exists/.test(restart.message), `restart on a stale lock is ${restart?.message}`);
        });

        // Batch 4: query breadth, all checked through the `pg` driver.
        await check('b4/joins', async () => {
            await withClient(batch4, async (client) => {
                const inner = await client.query(
                    'SELECT e.name AS emp, d.name AS dept FROM b4_emp e JOIN b4_dept d ON e.dept = d.id ORDER BY e.id',
                );
                assert(
                    JSON.stringify(inner.rows) ===
                        JSON.stringify([
                            { emp: 'ann', dept: 'sales' },
                            { emp: 'bob', dept: 'sales' },
                            { emp: 'cid', dept: 'eng' },
                            { emp: 'dan', dept: 'eng' },
                        ]),
                    `INNER JOIN is ${JSON.stringify(inner.rows)}`,
                );
                const left = await client.query(
                    'SELECT e.name AS emp, d.name AS dept FROM b4_emp e LEFT JOIN b4_dept d ON e.dept = d.id ORDER BY e.id',
                );
                assert(
                    JSON.stringify(left.rows) ===
                        JSON.stringify([
                            { emp: 'ann', dept: 'sales' },
                            { emp: 'bob', dept: 'sales' },
                            { emp: 'cid', dept: 'eng' },
                            { emp: 'dan', dept: 'eng' },
                            { emp: 'eve', dept: null },
                        ]),
                    `LEFT JOIN is ${JSON.stringify(left.rows)}`,
                );
                const right = await client.query(
                    'SELECT e.name AS emp, d.name AS dept FROM b4_emp e RIGHT JOIN b4_dept d ON e.dept = d.id ORDER BY d.id, e.id',
                );
                assert(
                    JSON.stringify(right.rows) ===
                        JSON.stringify([
                            { emp: 'ann', dept: 'sales' },
                            { emp: 'bob', dept: 'sales' },
                            { emp: 'cid', dept: 'eng' },
                            { emp: 'dan', dept: 'eng' },
                            { emp: null, dept: 'hr' },
                        ]),
                    `RIGHT JOIN is ${JSON.stringify(right.rows)}`,
                );
                const full = await client.query(
                    'SELECT e.name AS emp, d.name AS dept FROM b4_emp e FULL JOIN b4_dept d ON e.dept = d.id ORDER BY e.id NULLS LAST, d.id',
                );
                assert(
                    JSON.stringify(full.rows) ===
                        JSON.stringify([
                            { emp: 'ann', dept: 'sales' },
                            { emp: 'bob', dept: 'sales' },
                            { emp: 'cid', dept: 'eng' },
                            { emp: 'dan', dept: 'eng' },
                            { emp: 'eve', dept: null },
                            { emp: null, dept: 'hr' },
                        ]),
                    `FULL JOIN is ${JSON.stringify(full.rows)}`,
                );
                const using = await client.query(
                    'SELECT id, e.name AS emp, d.name AS dept FROM b4_emp e JOIN b4_dept d USING (id) ORDER BY id',
                );
                assert(
                    JSON.stringify(using.rows) ===
                        JSON.stringify([
                            { id: 1, emp: 'ann', dept: 'sales' },
                            { id: 2, emp: 'bob', dept: 'eng' },
                            { id: 3, emp: 'cid', dept: 'hr' },
                        ]),
                    `JOIN USING is ${JSON.stringify(using.rows)}`,
                );
            });
        });

        await check('b4/aggregates', async () => {
            await withClient(batch4, async (client) => {
                const counts = await client.query(
                    'SELECT dept, count(*) AS c_all, count(mgr) AS c_mgr FROM b4_emp GROUP BY dept ORDER BY dept NULLS LAST',
                );
                assert(
                    JSON.stringify(counts.rows) ===
                        JSON.stringify([
                            { dept: 1, c_all: '2', c_mgr: '1' },
                            { dept: 2, c_all: '2', c_mgr: '2' },
                            { dept: null, c_all: '1', c_mgr: '1' },
                        ]),
                    `grouped counts are ${JSON.stringify(counts.rows)}`,
                );
                const distinct = await client.query('SELECT count(DISTINCT dept) AS c FROM b4_emp');
                assert(distinct.rows[0]?.c === '2', `count(DISTINCT dept) is ${distinct.rows[0]?.c}`);
                const having = await client.query(
                    'SELECT dept, sum(salary) AS total FROM b4_emp GROUP BY dept HAVING sum(salary) > 150 ORDER BY dept',
                );
                assert(JSON.stringify(having.rows) === '[{"dept":1,"total":"180"},{"dept":2,"total":"210"}]', `HAVING is ${JSON.stringify(having.rows)}`);
                const average = await client.query(
                    'SELECT dept, avg(salary) AS mean FROM b4_emp GROUP BY dept ORDER BY dept NULLS LAST',
                );
                assert(
                    JSON.stringify(average.rows) ===
                        JSON.stringify([
                            { dept: 1, mean: '90.0000000000000000' },
                            { dept: 2, mean: '105.0000000000000000' },
                            { dept: null, mean: '70.0000000000000000' },
                        ]),
                    `avg is ${JSON.stringify(average.rows)}`,
                );
            });
        });

        await check('b4/subquery-cte', async () => {
            await withClient(batch4, async (client) => {
                const scalar = await client.query(
                    'SELECT name FROM b4_emp WHERE salary > (SELECT avg(salary) FROM b4_emp) ORDER BY name',
                );
                assert(JSON.stringify(scalar.rows) === '[{"name":"ann"},{"name":"cid"}]', `scalar subquery is ${JSON.stringify(scalar.rows)}`);
                const inList = await client.query(
                    "SELECT name FROM b4_emp WHERE dept IN (SELECT id FROM b4_dept WHERE name = 'eng') ORDER BY name",
                );
                assert(JSON.stringify(inList.rows) === '[{"name":"cid"},{"name":"dan"}]', `IN subquery is ${JSON.stringify(inList.rows)}`);
                const exists = await client.query(
                    'SELECT d.name FROM b4_dept d WHERE EXISTS (SELECT 1 FROM b4_emp e WHERE e.dept = d.id) ORDER BY d.name',
                );
                assert(JSON.stringify(exists.rows) === '[{"name":"eng"},{"name":"sales"}]', `EXISTS is ${JSON.stringify(exists.rows)}`);
                const fromSub = await client.query(
                    'SELECT t.dept, t.total FROM (SELECT dept, sum(salary) AS total FROM b4_emp GROUP BY dept) t ORDER BY t.dept NULLS LAST',
                );
                assert(
                    JSON.stringify(fromSub.rows) === '[{"dept":1,"total":"180"},{"dept":2,"total":"210"},{"dept":null,"total":"70"}]',
                    `FROM subquery is ${JSON.stringify(fromSub.rows)}`,
                );
                const cte = await client.query(
                    'WITH big AS (SELECT name, salary FROM b4_emp WHERE salary >= 90) SELECT name FROM big ORDER BY name',
                );
                assert(JSON.stringify(cte.rows) === '[{"name":"ann"},{"name":"cid"},{"name":"dan"}]', `CTE is ${JSON.stringify(cte.rows)}`);
                const recursive = await client.query(
                    'WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT n FROM nums ORDER BY n',
                );
                assert(JSON.stringify(recursive.rows) === '[{"n":1},{"n":2},{"n":3},{"n":4},{"n":5}]', `recursive CTE is ${JSON.stringify(recursive.rows)}`);
            });
        });

        await check('b4/setops', async () => {
            await withClient(batch4, async (client) => {
                const union = await client.query('SELECT 1 AS x UNION SELECT 2 UNION SELECT 1 ORDER BY x');
                assert(JSON.stringify(union.rows) === '[{"x":1},{"x":2}]', `UNION is ${JSON.stringify(union.rows)}`);
                const unionAll = await client.query('SELECT 1 AS x UNION ALL SELECT 1 ORDER BY x');
                assert(JSON.stringify(unionAll.rows) === '[{"x":1},{"x":1}]', `UNION ALL is ${JSON.stringify(unionAll.rows)}`);
                const intersect = await client.query('SELECT 1 AS x INTERSECT SELECT 1 ORDER BY x');
                assert(JSON.stringify(intersect.rows) === '[{"x":1}]', `INTERSECT is ${JSON.stringify(intersect.rows)}`);
                const except = await client.query('SELECT 1 AS x EXCEPT SELECT 1 ORDER BY x');
                assert(JSON.stringify(except.rows) === '[]', `EXCEPT is ${JSON.stringify(except.rows)}`);
                const intersectAll = await client.query(
                    'SELECT dept FROM b4_emp INTERSECT ALL SELECT dept FROM b4_emp ORDER BY dept NULLS LAST',
                );
                assert(
                    JSON.stringify(intersectAll.rows) === '[{"dept":1},{"dept":1},{"dept":2},{"dept":2},{"dept":null}]',
                    `INTERSECT ALL is ${JSON.stringify(intersectAll.rows)}`,
                );
                const exceptAll = await client.query(
                    'SELECT dept FROM b4_emp EXCEPT ALL SELECT dept FROM b4_emp WHERE salary > 90 ORDER BY dept NULLS LAST',
                );
                assert(JSON.stringify(exceptAll.rows) === '[{"dept":1},{"dept":2},{"dept":null}]', `EXCEPT ALL is ${JSON.stringify(exceptAll.rows)}`);
            });
        });

        await check('b4/expressions', async () => {
            await withClient(batch4, async (client) => {
                const bands = await client.query(
                    "SELECT name, CASE WHEN salary >= 100 THEN 'high' WHEN salary >= 80 THEN 'mid' ELSE 'low' END AS band FROM b4_emp ORDER BY name",
                );
                assert(
                    JSON.stringify(bands.rows) ===
                        JSON.stringify([
                            { name: 'ann', band: 'high' },
                            { name: 'bob', band: 'mid' },
                            { name: 'cid', band: 'high' },
                            { name: 'dan', band: 'mid' },
                            { name: 'eve', band: 'low' },
                        ]),
                    `CASE is ${JSON.stringify(bands.rows)}`,
                );
                const coalesce = await client.query('SELECT name, COALESCE(mgr, 0) AS boss FROM b4_emp ORDER BY name');
                assert(
                    JSON.stringify(coalesce.rows) ===
                        JSON.stringify([
                            { name: 'ann', boss: 0 },
                            { name: 'bob', boss: 1 },
                            { name: 'cid', boss: 1 },
                            { name: 'dan', boss: 3 },
                            { name: 'eve', boss: 2 },
                        ]),
                    `COALESCE is ${JSON.stringify(coalesce.rows)}`,
                );
                const nullif = await client.query('SELECT NULLIF(salary, 100) AS s FROM b4_emp ORDER BY id');
                assert(
                    JSON.stringify(nullif.rows) === '[{"s":null},{"s":80},{"s":120},{"s":90},{"s":70}]',
                    `NULLIF is ${JSON.stringify(nullif.rows)}`,
                );
                const cast = await client.query("SELECT CAST('42' AS int) + 1 AS answer");
                assert(cast.rows[0]?.answer === 43, `CAST is ${cast.rows[0]?.answer}`);
            });
        });

        await check('b4/windows', async () => {
            await withClient(batch4, async (client) => {
                const numbered = await client.query(
                    'SELECT name, row_number() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM b4_emp ORDER BY name',
                );
                assert(
                    JSON.stringify(numbered.rows) ===
                        '[{"name":"ann","rn":"1"},{"name":"bob","rn":"2"},{"name":"cid","rn":"1"},{"name":"dan","rn":"2"},{"name":"eve","rn":"1"}]',
                    `row_number is ${JSON.stringify(numbered.rows)}`,
                );
                const ranks = await client.query(
                    'SELECT name, rank() OVER (ORDER BY salary DESC) AS r, dense_rank() OVER (ORDER BY salary DESC) AS dr FROM b4_emp ORDER BY name',
                );
                assert(
                    JSON.stringify(ranks.rows) ===
                        '[{"name":"ann","r":"2","dr":"2"},{"name":"bob","r":"4","dr":"4"},{"name":"cid","r":"1","dr":"1"},{"name":"dan","r":"3","dr":"3"},{"name":"eve","r":"5","dr":"5"}]',
                    `rank is ${JSON.stringify(ranks.rows)}`,
                );
                const shifted = await client.query(
                    'SELECT name, lag(name) OVER (ORDER BY salary) AS prev, lead(name) OVER (ORDER BY salary) AS next FROM b4_emp ORDER BY name',
                );
                assert(
                    JSON.stringify(shifted.rows) ===
                        JSON.stringify([
                            { name: 'ann', prev: 'dan', next: 'cid' },
                            { name: 'bob', prev: 'eve', next: 'dan' },
                            { name: 'cid', prev: 'ann', next: null },
                            { name: 'dan', prev: 'bob', next: 'ann' },
                            { name: 'eve', prev: null, next: 'bob' },
                        ]),
                    `lag/lead is ${JSON.stringify(shifted.rows)}`,
                );
                const running = await client.query(
                    'SELECT name, sum(salary) OVER (PARTITION BY dept ORDER BY salary ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM b4_emp ORDER BY name',
                );
                assert(
                    JSON.stringify(running.rows) ===
                        '[{"name":"ann","running":"180"},{"name":"bob","running":"80"},{"name":"cid","running":"210"},{"name":"dan","running":"90"},{"name":"eve","running":"70"}]',
                    `sum over frame is ${JSON.stringify(running.rows)}`,
                );
                const average = await client.query(
                    'SELECT name, avg(salary) OVER (PARTITION BY dept) AS dept_avg FROM b4_emp ORDER BY name',
                );
                assert(
                    JSON.stringify(average.rows) ===
                        '[{"name":"ann","dept_avg":"90.0000000000000000"},{"name":"bob","dept_avg":"90.0000000000000000"},{"name":"cid","dept_avg":"105.0000000000000000"},{"name":"dan","dept_avg":"105.0000000000000000"},{"name":"eve","dept_avg":"70.0000000000000000"}]',
                    `avg over is ${JSON.stringify(average.rows)}`,
                );
            });
        });

        await check('catalog/meta-fixtures', async () => {
            const fixture = JSON.parse(fs.readFileSync(path.join(harnessDir, 'fixtures', 'meta-queries.json'), 'utf8'));
            await withClient(batch4, async (client) => {
                for (const item of fixture.cases) {
                    const result = await client.query(item.sql);
                    assert(result.rowCount === item.rows, `${item.command}: ${result.rowCount} rows, expected ${item.rows}`);
                }
            });
        });

        await check('catalog/meta-l', async () => {
            const fixture = JSON.parse(fs.readFileSync(path.join(harnessDir, 'fixtures', 'meta-queries.json'), 'utf8'));
            const list = fixture.cases.find((item) => item.command === '\\l');
            await withClient(batch4, async (client) => {
                const result = await client.query(list.sql);
                assert(result.rowCount === 3, `\\l returned ${result.rowCount} rows`);
                const names = result.rows.map((row) => row.Name);
                assert(JSON.stringify(names) === '["postgres","template0","template1"]', `\\l names are ${JSON.stringify(names)}`);
                const row = result.rows[0];
                assert(row.Owner === 'postgres', `\\l owner is ${row.Owner}`);
                assert(row.Encoding === 'UTF8', `\\l encoding is ${row.Encoding}`);
                assert(row['Locale Provider'] === 'libc' && row.Collate === 'C' && row.Ctype === 'C', `\\l locale is ${JSON.stringify(row)}`);
                assert(result.rows[0]['Access privileges'] === null, `postgres ACL is ${JSON.stringify(result.rows[0]['Access privileges'])}`);
                const acl = '=c/postgres\npostgres=CTc/postgres';
                for (const template of result.rows.slice(1)) {
                    assert(template['Access privileges'] === acl, `${template.Name} ACL is ${JSON.stringify(template['Access privileges'])}`);
                }
            });
        });

        await check('b6/catalog', async () => {
            await withClient(batch4, async (client) => {
                const result = await client.query('SELECT * FROM pg_database');
                assert(result.rowCount === 3, `pg_database returned ${result.rowCount} rows`);
                const names = result.rows.map((row) => row.datname);
                assert(JSON.stringify(names) === '["postgres","template1","template0"]', `pg_database order is ${JSON.stringify(names)}`);
                const postgres = result.rows[0];
                assert(postgres.datistemplate === false && postgres.datallowconn === true, 'postgres flags are wrong');
                assert(postgres.datacl === null, `postgres datacl is ${JSON.stringify(postgres.datacl)}`);
                assert(postgres.datdba === 10 && postgres.encoding === 6 && postgres.dattablespace === 1663, 'postgres attributes are wrong');
                const acl = ['=c/postgres', 'postgres=CTc/postgres'];
                for (const template of result.rows.slice(1)) {
                    assert(template.datistemplate === true, `${template.datname} is not a template`);
                    assert(Array.isArray(template.datacl) && JSON.stringify(template.datacl) === JSON.stringify(acl), `${template.datname} datacl is ${JSON.stringify(template.datacl)}`);
                }
                assert(result.rows[1].datallowconn === true && result.rows[2].datallowconn === false, 'template allowconn flags are wrong');
            });
        });

        await check('catalog/meta-lplus', async () => {
            const fixture = JSON.parse(fs.readFileSync(path.join(harnessDir, 'fixtures', 'meta-queries.json'), 'utf8'));
            const list = fixture.cases.find((item) => item.command === '\\l+');
            await withClient(batch4, async (client) => {
                const result = await client.query(list.sql);
                assert(result.rowCount === 3, `\\l+ returned ${result.rowCount} rows`);
                assert(
                    JSON.stringify(result.fields.map((field) => field.name)) ===
                        JSON.stringify(['Name', 'Owner', 'Encoding', 'Locale Provider', 'Collate', 'Ctype', 'ICU Locale', 'ICU Rules', 'Access privileges', 'Size', 'Tablespace', 'Description']),
                    `\\l+ columns are ${JSON.stringify(result.fields.map((field) => field.name))}`,
                );
                for (const row of result.rows) {
                    assert(/^[0-9]+ (bytes|kB|MB|GB|TB)$/.test(row.Size), `${row.Name} size is ${row.Size}`);
                    assert(row.Tablespace === 'pg_default', `${row.Name} tablespace is ${row.Tablespace}`);
                }
            });
        });

        // Batch 7: cluster directory isolation plus CREATE/DROP DATABASE.
        const connectDatabase = async (server, database) => {
            const client = new pg.Client({ host: server.host, port: server.port, user: 'postgres', database });
            await client.connect();
            return client;
        };
        const failureOf = (promise) => promise.then(() => null, (error) => error);

        await check('database/create-isolation', async () => {
            await withClient(batch7, async (client) => {
                await client.query('CREATE TABLE postgres_only (id int)');
                const created = await client.query('CREATE DATABASE b7_iso');
                assert(created.command === 'CREATE', `create tag is ${created.command}`);
                const listed = await client.query('SELECT oid, datname FROM pg_database ORDER BY datname');
                assert(
                    JSON.stringify(listed.rows) ===
                        '[{"oid":16384,"datname":"b7_iso"},{"oid":5,"datname":"postgres"},{"oid":4,"datname":"template0"},{"oid":1,"datname":"template1"}]',
                    `pg_database rows are ${JSON.stringify(listed.rows)}`,
                );
            });
            const app = await connectDatabase(batch7, 'b7_iso');
            try {
                const inherited = await failureOf(app.query('SELECT * FROM postgres_only'));
                assert(inherited?.code === '42P01', `new database sees a postgres table: ${inherited?.code}`);
                await app.query('CREATE TABLE only_here (id int)');
                await app.query('INSERT INTO only_here VALUES (1)');
                const count = await app.query('SELECT count(*) AS n FROM only_here');
                assert(count.rows[0]?.n === '1', `b7_iso count is ${count.rows[0]?.n}`);
            } finally {
                await app.end();
            }
            await withClient(batch7, async (client) => {
                const leaked = await failureOf(client.query('SELECT * FROM only_here'));
                assert(leaked?.code === '42P01', `postgres sees a clone table: ${leaked?.code}`);
                const dropped = await client.query('DROP DATABASE b7_iso');
                assert(dropped.command === 'DROP', `drop tag is ${dropped.command}`);
            });
        });

        await check('database/errors', async () => {
            await withClient(batch7, async (client) => {
                await client.query('BEGIN');
                const createInTransaction = await failureOf(client.query('CREATE DATABASE b7_txn_create'));
                assert(
                    createInTransaction?.code === '25001' &&
                        createInTransaction.message === 'CREATE DATABASE cannot run inside a transaction block',
                    `create in transaction is ${createInTransaction?.code}/${createInTransaction?.message}`,
                );
                await client.query('ROLLBACK');

                await client.query('BEGIN');
                const dropInTransaction = await failureOf(client.query('DROP DATABASE b7_txn_drop'));
                assert(
                    dropInTransaction?.code === '25001' && dropInTransaction.message === 'DROP DATABASE cannot run inside a transaction block',
                    `drop in transaction is ${dropInTransaction?.code}/${dropInTransaction?.message}`,
                );
                await client.query('ROLLBACK');

                const multiCreate = await failureOf(client.query('CREATE DATABASE b7_multi; SELECT 1'));
                assert(
                    multiCreate?.code === '25001' && multiCreate.message === 'CREATE DATABASE cannot run inside a transaction block',
                    `multi-statement create is ${multiCreate?.code}/${multiCreate?.message}`,
                );
                const multiDrop = await failureOf(client.query('DROP DATABASE b7_multi_drop; SELECT 1'));
                assert(
                    multiDrop?.code === '25001' && multiDrop.message === 'DROP DATABASE cannot run inside a transaction block',
                    `multi-statement drop is ${multiDrop?.code}/${multiDrop?.message}`,
                );
                const multiLeft = await client.query("SELECT count(*) AS n FROM pg_database WHERE datname = 'b7_multi'");
                assert(multiLeft.rows[0]?.n === '0', `multi-statement create left ${multiLeft.rows[0]?.n} rows`);

                await client.query('CREATE DATABASE b7_dup');
                const duplicate = await failureOf(client.query('CREATE DATABASE b7_dup'));
                assert(duplicate?.code === '42P04' && duplicate.message === 'database "b7_dup" already exists', `duplicate is ${duplicate?.code}`);
                const unknownTemplate = await failureOf(client.query('CREATE DATABASE b7_tpl TEMPLATE b7_no_template'));
                assert(unknownTemplate?.code === '3D000', `unknown template is ${unknownTemplate?.code}`);
                const missing = await failureOf(client.query('DROP DATABASE b7_missing'));
                assert(missing?.code === '3D000' && missing.message === 'database "b7_missing" does not exist', `missing drop is ${missing?.code}`);
                const template = await failureOf(client.query('DROP DATABASE template1'));
                assert(template?.code === '42809' && template.message === 'cannot drop a template database', `template drop is ${template?.code}`);
                const current = await failureOf(client.query('DROP DATABASE postgres'));
                assert(
                    current?.code === '55006' && current.message === 'cannot drop the currently open database',
                    `current drop is ${current?.code}/${current?.message}`,
                );

                const notices = [];
                const onNotice = (notice) => notices.push(notice);
                client.on('notice', onNotice);
                try {
                    const skipped = await client.query('DROP DATABASE IF EXISTS b7_missing_again');
                    assert(skipped.command === 'DROP', `IF EXISTS tag is ${skipped.command}`);
                } finally {
                    client.off('notice', onNotice);
                }
                assert(notices.length === 1, `IF EXISTS emitted ${notices.length} notices`);
                assert(notices[0]?.code === '00000', `notice code is ${notices[0]?.code}`);
                assert(
                    notices[0]?.message === 'database "b7_missing_again" does not exist, skipping',
                    `notice message is ${notices[0]?.message}`,
                );
                await client.query('DROP DATABASE b7_dup');
            });
        });

        await check('database/occupied', async () => {
            await withClient(batch7, async (client) => {
                await client.query('CREATE DATABASE b7_busy');
                const other = await connectDatabase(batch7, 'b7_busy');
                try {
                    const busy = await failureOf(client.query('DROP DATABASE b7_busy'));
                    assert(
                        busy?.code === '55006' && busy.message === 'database "b7_busy" is being accessed by other users',
                        `busy drop is ${busy?.code}/${busy?.message}`,
                    );
                    assert(busy?.detail === 'There is 1 other session using the database.', `busy detail is ${busy?.detail}`);
                } finally {
                    await other.end();
                }
                const dropped = await client.query('DROP DATABASE b7_busy');
                assert(dropped.command === 'DROP', `busy drop tag is ${dropped.command}`);
            });
        });

        await check('database/startup', async () => {
            const template0 = new pg.Client({ host: batch7.host, port: batch7.port, user: 'postgres', database: 'template0' });
            const templateError = await failureOf(template0.connect());
            assert(
                templateError?.code === '55000' &&
                    templateError.message === 'database "template0" is not currently accepting connections',
                `template0 startup is ${templateError?.code}/${templateError?.message}`,
            );
            const nowhere = new pg.Client({ host: batch7.host, port: batch7.port, user: 'postgres', database: 'b7_no_such_database' });
            const missingError = await failureOf(nowhere.connect());
            assert(
                missingError?.code === '3D000' && missingError.message === 'database "b7_no_such_database" does not exist',
                `missing startup is ${missingError?.code}/${missingError?.message}`,
            );
            const template1 = await connectDatabase(batch7, 'template1');
            try {
                const databases = await template1.query('SELECT count(*) AS n FROM pg_database');
                assert(databases.rows[0]?.n === '3', `template1 sees ${databases.rows[0]?.n} databases`);
                const inherited = await template1.query("SELECT count(*) AS n FROM pg_catalog.pg_class WHERE relname = 'postgres_only'");
                assert(inherited.rows[0]?.n === '0', `template1 inherited ${inherited.rows[0]?.n} postgres tables`);
            } finally {
                await template1.end();
            }
        });

        await check('database/clone-template0', async () => {
            await withClient(batch7, async (client) => {
                const created = await client.query('CREATE DATABASE b7_clone TEMPLATE template0');
                assert(created.command === 'CREATE', `clone tag is ${created.command}`);
                const row = await client.query("SELECT datallowconn, datistemplate FROM pg_database WHERE datname = 'b7_clone'");
                assert(row.rows[0]?.datallowconn === true && row.rows[0]?.datistemplate === false, `clone row is ${JSON.stringify(row.rows[0])}`);
            });
            const clone = await connectDatabase(batch7, 'b7_clone');
            try {
                await clone.query('CREATE TABLE cloned (id int)');
            } finally {
                await clone.end();
            }
            await withClient(batch7, async (client) => {
                await client.query('DROP DATABASE b7_clone');
            });
        });

        await check('database/persistence', async () => {
            const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-db-persist-'));
            const first = await startPostgresServer({ dataDir: persistDir });
            try {
                await withClient(first, async (client) => {
                    await client.query('CREATE DATABASE b7_kept');
                });
                const app = await connectDatabase(first, 'b7_kept');
                try {
                    await app.query('CREATE TABLE kept (v text)');
                    await app.query("INSERT INTO kept VALUES ('yes')");
                } finally {
                    await app.end();
                }
            } finally {
                await first.close();
            }
            const second = await startPostgresServer({ dataDir: persistDir });
            try {
                const reopened = await connectDatabase(second, 'b7_kept');
                try {
                    const rows = await reopened.query('SELECT v FROM kept');
                    assert(JSON.stringify(rows.rows) === '[{"v":"yes"}]', `persisted rows are ${JSON.stringify(rows.rows)}`);
                } finally {
                    await reopened.end();
                }
                await withClient(second, async (client) => {
                    const listed = await client.query("SELECT datname FROM pg_database WHERE datname = 'b7_kept'");
                    assert(listed.rowCount === 1, `cluster row rows are ${listed.rowCount}`);
                });
            } finally {
                await second.close();
            }
        });

        // Batch 8: database options, template clone boundaries, ACL and FORCE.
        await check('database/options', async () => {
            await withClient(batch8, async (client) => {
                const created = await client.query(
                    'CREATE DATABASE b8_opts WITH TEMPLATE = template0 CONNECTION LIMIT = 5 ALLOW_CONNECTIONS = true',
                );
                assert(created.command === 'CREATE', `options create tag is ${created.command}`);
                const row = await client.query("SELECT datconnlimit, datallowconn, datistemplate FROM pg_database WHERE datname = 'b8_opts'");
                assert(
                    JSON.stringify(row.rows[0]) === '{"datconnlimit":5,"datallowconn":true,"datistemplate":false}',
                    `option row is ${JSON.stringify(row.rows[0])}`,
                );
                const shut = await client.query('CREATE DATABASE b8_shut ALLOW_CONNECTIONS false');
                assert(shut.command === 'CREATE', `shut create tag is ${shut.command}`);
                // `CONNECTION LIMIT` and `ALLOW_CONNECTIONS` are not inherited from the template.
                await client.query('CREATE DATABASE b8_parent CONNECTION LIMIT = 1 ALLOW_CONNECTIONS = false');
                await client.query('CREATE DATABASE b8_child TEMPLATE b8_parent');
                const inherited = await client.query("SELECT datconnlimit, datallowconn FROM pg_database WHERE datname = 'b8_child'");
                assert(
                    JSON.stringify(inherited.rows[0]) === '{"datconnlimit":-1,"datallowconn":true}',
                    `child row is ${JSON.stringify(inherited.rows[0])}`,
                );
            });
            const shut = new pg.Client({ host: batch8.host, port: batch8.port, user: 'postgres', database: 'b8_shut' });
            const shutError = await failureOf(shut.connect());
            assert(
                shutError?.code === '55000' && shutError.message === 'database "b8_shut" is not currently accepting connections',
                `allow_connections startup is ${shutError?.code}/${shutError?.message}`,
            );
            await shut.end().catch(() => undefined);
            // PostgreSQL exempts superusers from `CONNECTION LIMIT`; every session here is that role.
            const first = await connectDatabase(batch8, 'b8_opts');
            const second = await connectDatabase(batch8, 'b8_opts');
            await first.end();
            await second.end();
            await withClient(batch8, async (client) => {
                for (const name of ['b8_shut', 'b8_child', 'b8_parent', 'b8_opts']) await client.query(`DROP DATABASE ${name}`);
            });
        });

        await check('database/parse-errors', async () => {
            await withClient(batch8, async (client) => {
                const limit = await failureOf(client.query('CREATE DATABASE b8_bad CONNECTION LIMIT foo'));
                assert(
                    limit?.code === '42601' && limit.message === 'connection_limit requires an integer value',
                    `bad connection limit is ${limit?.code}/${limit?.message}`,
                );
                const allow = await failureOf(client.query('CREATE DATABASE b8_bad ALLOW_CONNECTIONS maybe'));
                assert(
                    allow?.code === '42601' && allow.message === 'allow_connections requires a Boolean value',
                    `bad allow_connections is ${allow?.code}/${allow?.message}`,
                );
            });
        });

        await check('database/clone-source-busy', async () => {
            await withClient(batch8, async (client) => {
                await client.query('CREATE DATABASE b8_src8');
                const other = await connectDatabase(batch8, 'b8_src8');
                try {
                    const busy = await failureOf(client.query('CREATE DATABASE b8_src8_clone TEMPLATE b8_src8'));
                    assert(
                        busy?.code === '55006' &&
                            busy.message === 'source database "b8_src8" is being accessed by other users',
                        `busy source is ${busy?.code}/${busy?.message}`,
                    );
                    assert(busy?.detail === 'There is 1 other session using the database.', `busy source detail is ${busy?.detail}`);
                } finally {
                    await other.end();
                }
                const cloned = await client.query('CREATE DATABASE b8_src8_clone TEMPLATE b8_src8');
                assert(cloned.command === 'CREATE', `clone tag is ${cloned.command}`);
                await client.query('DROP DATABASE b8_src8_clone');
                await client.query('DROP DATABASE b8_src8');
            });
        });

        await check('database/force', async () => {
            await withClient(batch8, async (client) => {
                await client.query('CREATE DATABASE b8_force');
                const victim = await connectDatabase(batch8, 'b8_force');
                // A forced drop sends FATAL 57P01 and then closes the socket. node-postgres
                // reports the FATAL error first and the trailing socket close as a second
                // "Connection terminated unexpectedly" error. Keep the listener attached for
                // the whole session so the late report cannot crash the harness as an
                // unhandled 'error' event, and assert the first report.
                const terminated = new Promise((resolve) => {
                    victim.on('error', (error) => resolve(error));
                });
                try {
                    const busy = await failureOf(client.query('DROP DATABASE b8_force'));
                    assert(busy?.code === '55006', `drop without force is ${busy?.code}`);
                    const dropped = await client.query('DROP DATABASE b8_force WITH (FORCE)');
                    assert(dropped.command === 'DROP', `force drop tag is ${dropped.command}`);
                    const error = await Promise.race([terminated, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
                    assert(
                        error?.code === '57P01' && error.message === 'terminating connection due to administrator command',
                        `terminated session is ${error?.code}/${error?.message}`,
                    );
                } finally {
                    await victim.end().catch(() => undefined);
                }
            });
        });

        await check('database/acl', async () => {
            await withClient(batch8, async (client) => {
                const privileges = await client.query(
                    "SELECT has_database_privilege('postgres','template1','CONNECT') AS owner_connect, " +
                        "has_database_privilege('postgres','template1','TEMP') AS owner_temp, " +
                        "has_database_privilege('pg_database_owner','template1','CONNECT') AS public_connect, " +
                        "has_database_privilege('pg_database_owner','template1','TEMP') AS public_temp, " +
                        "has_database_privilege('pg_database_owner','postgres','TEMP') AS default_temp, " +
                        "has_database_privilege('template1','CONNECT') AS current_user_connect",
                );
                assert(
                    JSON.stringify(privileges.rows[0]) ===
                        '{"owner_connect":true,"owner_temp":true,"public_connect":true,"public_temp":false,"default_temp":true,"current_user_connect":true}',
                    `privileges are ${JSON.stringify(privileges.rows[0])}`,
                );
                const role = await failureOf(client.query("SELECT has_database_privilege('nobody','postgres','CONNECT')"));
                assert(role?.code === '42704' && role.message === 'role "nobody" does not exist', `unknown role is ${role?.code}`);
                const database = await failureOf(client.query("SELECT has_database_privilege('postgres','b8_nodb','CONNECT')"));
                assert(database?.code === '3D000' && database.message === 'database "b8_nodb" does not exist', `unknown database is ${database?.code}`);
                const privilege = await failureOf(client.query("SELECT has_database_privilege('postgres','postgres','NOPE')"));
                assert(
                    privilege?.code === '22023' && privilege.message === 'unrecognized privilege type: "NOPE"',
                    `unknown privilege is ${privilege?.code}`,
                );
            });
        });

        const connectAs = async (server, user, database) => {
            const client = new pg.Client({ host: server.host, port: server.port, user, database });
            await client.connect();
            return client;
        };

        await check('roles/ddl', async () => {
            await withClient(batch9, async (client) => {
                const created = await client.query('CREATE ROLE b9_alice LOGIN');
                assert(created.command === 'CREATE', `create role tag is ${created.command}`);
                const bob = await client.query('CREATE ROLE b9_bob NOLOGIN CONNECTION LIMIT 3');
                assert(bob.command === 'CREATE', `create bob tag is ${bob.command}`);
                const duplicate = await failureOf(client.query('CREATE ROLE b9_alice'));
                assert(
                    duplicate?.code === '42710' && duplicate.message === 'role "b9_alice" already exists',
                    `duplicate role is ${duplicate?.code}/${duplicate?.message}`,
                );
                const missing = await failureOf(client.query('ALTER ROLE b9_nope NOLOGIN'));
                assert(missing?.code === '42704' && missing.message === 'role "b9_nope" does not exist', `missing role is ${missing?.code}`);
                const noticePromise = new Promise((resolve) => client.once('notice', resolve));
                const skipped = await client.query('DROP ROLE IF EXISTS b9_nope');
                assert(skipped.command === 'DROP', `drop role if exists tag is ${skipped.command}`);
                const notice = await noticePromise;
                assert(
                    notice.code === '00000' && notice.message === 'role "b9_nope" does not exist, skipping',
                    `drop role notice is ${notice.code}/${notice.message}`,
                );
                await client.query('ALTER ROLE b9_bob LOGIN CONNECTION LIMIT 5');
                await client.query('CREATE ROLE b9_root SUPERUSER LOGIN');
                const rows = await client.query(
                    'SELECT rolname, rolsuper, rolcanlogin, rolconnlimit FROM pg_roles ORDER BY rolname',
                );
                const createdRoles = rows.rows.filter((row) => row.rolname.startsWith('b9_'));
                assert(
                    JSON.stringify(createdRoles) ===
                        '[{"rolname":"b9_alice","rolsuper":false,"rolcanlogin":true,"rolconnlimit":-1},' +
                            '{"rolname":"b9_bob","rolsuper":false,"rolcanlogin":true,"rolconnlimit":5},' +
                            '{"rolname":"b9_root","rolsuper":true,"rolcanlogin":true,"rolconnlimit":-1}]',
                    `pg_roles rows are ${JSON.stringify(createdRoles)}`,
                );
                await client.query('DROP ROLE b9_root');
            });
        });

        await check('roles/startup', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE ROLE b9_nologin NOLOGIN');
                const denied = await failureOf(connectAs(batch9, 'b9_nologin', 'postgres'));
                assert(
                    denied?.code === '28000' && denied.message === 'role "b9_nologin" is not permitted to log in',
                    `nologin startup is ${denied?.code}/${denied?.message}`,
                );
                const unknown = await failureOf(connectAs(batch9, 'b9_nobody', 'postgres'));
                assert(
                    unknown?.code === '28000' && unknown.message === 'role "b9_nobody" does not exist',
                    `unknown role startup is ${unknown?.code}/${unknown?.message}`,
                );
                const alice = await connectAs(batch9, 'b9_alice', 'postgres');
                try {
                    const isSuper = await alice.query('SHOW is_superuser');
                    assert(isSuper.rows[0].is_superuser === 'off', `alice is_superuser is ${isSuper.rows[0].is_superuser}`);
                    const forbidden = await failureOf(alice.query('CREATE ROLE b9_forbidden'));
                    assert(
                        forbidden?.code === '42501' && forbidden.message === 'permission denied to create role',
                        `alice create role is ${forbidden?.code}/${forbidden?.message}`,
                    );
                } finally {
                    await alice.end();
                }
                const admin = await connectAs(batch9, 'postgres', 'postgres');
                try {
                    const isSuper = await admin.query('SHOW is_superuser');
                    assert(isSuper.rows[0].is_superuser === 'on', `postgres is_superuser is ${isSuper.rows[0].is_superuser}`);
                } finally {
                    await admin.end();
                }
            });
        });

        await check('roles/acl-catalog', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE DATABASE b9_acl OWNER b9_alice');
                await client.query('GRANT CONNECT, CREATE, TEMP ON DATABASE b9_acl TO b9_bob');
                const datacl = await client.query("SELECT datacl::text FROM pg_database WHERE datname = 'b9_acl'");
                assert(
                    datacl.rows[0].datacl === '{=Tc/b9_alice,b9_alice=CTc/b9_alice,b9_bob=CTc/b9_alice}',
                    `datacl is ${datacl.rows[0].datacl}`,
                );
                await client.query('GRANT USAGE, CREATE ON SCHEMA public TO b9_bob');
                const nspacl = await client.query("SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public'");
                assert(
                    nspacl.rows[0].nspacl === '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner,b9_bob=UC/pg_database_owner}',
                    `nspacl is ${nspacl.rows[0].nspacl}`,
                );
                await client.query('CREATE TABLE b9_acl_t (id int, note text)');
                await client.query('ALTER TABLE b9_acl_t OWNER TO b9_alice');
                await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON b9_acl_t TO b9_bob');
                const relacl = await client.query("SELECT relacl::text FROM pg_class WHERE relname = 'b9_acl_t'");
                assert(
                    relacl.rows[0].relacl === '{b9_alice=arwdDxt/b9_alice,b9_bob=arwd/b9_alice}',
                    `relacl is ${relacl.rows[0].relacl}`,
                );
                await client.query('REVOKE SELECT ON b9_acl_t FROM b9_bob');
                const revoked = await client.query("SELECT relacl::text FROM pg_class WHERE relname = 'b9_acl_t'");
                assert(
                    revoked.rows[0].relacl === '{b9_alice=arwdDxt/b9_alice,b9_bob=awd/b9_alice}',
                    `revoked relacl is ${revoked.rows[0].relacl}`,
                );
                await client.query('REVOKE CONNECT ON DATABASE b9_acl FROM PUBLIC');
                const noConnect = await client.query("SELECT datacl::text FROM pg_database WHERE datname = 'b9_acl'");
                assert(
                    noConnect.rows[0].datacl === '{=T/b9_alice,b9_alice=CTc/b9_alice,b9_bob=CTc/b9_alice}',
                    `revoked datacl is ${noConnect.rows[0].datacl}`,
                );
                await client.query('REVOKE ALL ON SCHEMA public FROM b9_bob');
                const reset = await client.query("SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public'");
                assert(
                    reset.rows[0].nspacl === '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}',
                    `reset nspacl is ${reset.rows[0].nspacl}`,
                );
                await client.query('DROP TABLE b9_acl_t');
                await client.query('DROP DATABASE b9_acl');
            });
        });

        await check('roles/connect-revoked', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE DATABASE b9_rev');
                await client.query('REVOKE CONNECT ON DATABASE b9_rev FROM PUBLIC');
                const privileges = await client.query(
                    "SELECT has_database_privilege('postgres','b9_rev','CONNECT') AS owner_connect, " +
                        "has_database_privilege('b9_alice','b9_rev','CONNECT') AS public_connect",
                );
                assert(
                    JSON.stringify(privileges.rows[0]) === '{"owner_connect":true,"public_connect":false}',
                    `revoked privileges are ${JSON.stringify(privileges.rows[0])}`,
                );
                const denied = await failureOf(connectAs(batch9, 'b9_alice', 'b9_rev'));
                assert(
                    denied?.code === '42501' &&
                        denied.message === 'permission denied for database "b9_rev"' &&
                        denied.detail === 'User does not have CONNECT privilege.',
                    `revoked connect is ${denied?.code}/${denied?.message}/${denied?.detail}`,
                );
                await client.query('DROP DATABASE b9_rev');
            });
        });

        await check('roles/connection-limit', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE DATABASE b9_lim OWNER b9_alice CONNECTION LIMIT 1');
                const first = await connectAs(batch9, 'b9_alice', 'b9_lim');
                try {
                    const second = await failureOf(connectAs(batch9, 'b9_alice', 'b9_lim'));
                    assert(
                        second?.code === '53300' && second.message === 'too many connections for database "b9_lim"',
                        `connection limit is ${second?.code}/${second?.message}`,
                    );
                    // Superusers are exempt even while another session holds the slot.
                    const admin = await connectAs(batch9, 'postgres', 'b9_lim');
                    await admin.end();
                } finally {
                    await first.end();
                }
                await client.query('DROP DATABASE b9_lim');
            });
        });

        await check('roles/enforcement', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE DATABASE b9_rw OWNER b9_alice');
                const alice = await connectAs(batch9, 'b9_alice', 'b9_rw');
                const bob = await connectAs(batch9, 'b9_bob', 'b9_rw');
                try {
                    const schemaDenied = await failureOf(bob.query('CREATE TABLE b9_bob_t (id int)'));
                    assert(
                        schemaDenied?.code === '42501' && schemaDenied.message === 'permission denied for schema public',
                        `schema create is ${schemaDenied?.code}/${schemaDenied?.message}`,
                    );
                    await alice.query('GRANT CREATE ON SCHEMA public TO b9_bob');
                    const created = await bob.query('CREATE TABLE b9_bob_t (id int)');
                    assert(created.command === 'CREATE', `bob create table tag is ${created.command}`);
                    await alice.query('CREATE TABLE b9_secret (id int, note text)');
                    await alice.query("INSERT INTO b9_secret VALUES (1, 'x')");
                    for (const [sql, privilege] of [
                        ['SELECT * FROM b9_secret', 'SELECT'],
                        ["INSERT INTO b9_secret VALUES (2, 'y')", 'INSERT'],
                        ["UPDATE b9_secret SET note = 'z'", 'UPDATE'],
                        ['DELETE FROM b9_secret', 'DELETE'],
                    ]) {
                        const denied = await failureOf(bob.query(sql));
                        assert(
                            denied?.code === '42501' && denied.message === 'permission denied for table b9_secret',
                            `${privilege} is ${denied?.code}/${denied?.message}`,
                        );
                    }
                    const dropDenied = await failureOf(bob.query('DROP TABLE b9_secret'));
                    assert(
                        dropDenied?.code === '42501' && dropDenied.message === 'must be owner of table b9_secret',
                        `drop table is ${dropDenied?.code}/${dropDenied?.message}`,
                    );
                    await alice.query('GRANT SELECT, INSERT, UPDATE, DELETE ON b9_secret TO b9_bob');
                    const selected = await bob.query('SELECT * FROM b9_secret');
                    assert(selected.rowCount === 1, `bob select row count is ${selected.rowCount}`);
                    await bob.query("INSERT INTO b9_secret VALUES (2, 'y')");
                    await bob.query("UPDATE b9_secret SET note = 'z' WHERE id = 2");
                    await bob.query('DELETE FROM b9_secret WHERE id = 2');
                    await alice.query('REVOKE SELECT ON b9_secret FROM b9_bob');
                    const revoked = await failureOf(bob.query('SELECT * FROM b9_secret'));
                    assert(
                        revoked?.code === '42501' && revoked.message === 'permission denied for table b9_secret',
                        `revoked select is ${revoked?.code}/${revoked?.message}`,
                    );
                } finally {
                    await alice.end();
                    await bob.end();
                }
            });
        });

        await check('roles/rollback', async () => {
            await withClient(batch9, async (client) => {
                await client.query('CREATE DATABASE b9_txn OWNER b9_alice');
                const before = await client.query("SELECT datacl::text FROM pg_database WHERE datname = 'b9_txn'");
                await client.query('BEGIN');
                await client.query('GRANT CONNECT ON DATABASE b9_txn TO b9_bob');
                const during = await client.query("SELECT datacl::text FROM pg_database WHERE datname = 'b9_txn'");
                assert(
                    during.rows[0].datacl === '{=Tc/b9_alice,b9_alice=CTc/b9_alice,b9_bob=c/b9_alice}',
                    `in-transaction datacl is ${during.rows[0].datacl}`,
                );
                await client.query('ROLLBACK');
                const after = await client.query("SELECT datacl::text FROM pg_database WHERE datname = 'b9_txn'");
                assert(after.rows[0].datacl === before.rows[0].datacl, `rolled back datacl is ${after.rows[0].datacl}`);
                await client.query('DROP DATABASE b9_txn');
            });
        });

        // Batch 5: COPY, cursors, SQL-level PREPARE and LISTEN/NOTIFY.
        const setupB5 = fs.readFileSync(path.join(harnessDir, 'fixtures', 'b5-setup.sql'), 'utf8');
        await withClient(batch5, async (client) => {
            for (const statement of setupB5.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
                await client.query(statement);
            }
        });

        const copyFromText = (client, sql, text) =>
            new Promise((resolve) => {
                const stream = client.query(copyStreams.from(sql));
                let settled = false;
                const done = (error) => {
                    if (settled) return;
                    settled = true;
                    resolve(error ?? null);
                };
                stream.on('error', done);
                stream.on('finish', () => done(null));
                stream.end(text);
            });

        const copyToText = (client, sql) =>
            new Promise((resolve, reject) => {
                const stream = client.query(copyStreams.to(sql));
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                stream.on('error', reject);
            });

        const waitFor = async (predicate, timeout = 3000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (predicate()) return true;
                await new Promise((rest) => setTimeout(rest, 25));
            }
            return predicate();
        };

        await check('b5/copy-streams', async () => {
            await withClient(batch5, async (client) => {
                await client.query('CREATE TABLE b5_stream (id int PRIMARY KEY, v text)');
                const inserted = await copyFromText(client, 'COPY b5_stream FROM STDIN WITH (FORMAT csv)', '1,alpha\n2,"beta,gamma"\n3,\n');
                assert(inserted === null, `COPY FROM failed: ${inserted?.message}`);
                const csv = await copyToText(client, 'COPY b5_stream TO STDOUT WITH (FORMAT csv)');
                assert(csv === '1,alpha\n2,"beta,gamma"\n3,\n', `COPY TO csv is ${JSON.stringify(csv)}`);
                const text = await copyToText(client, 'COPY b5_stream TO STDOUT');
                assert(text === '1\talpha\n2\tbeta,gamma\n3\t\\N\n', `COPY TO text is ${JSON.stringify(text)}`);
                const failed = await copyFromText(client, 'COPY b5_stream FROM STDIN', '4\tok\n5\tok\nxx\tbad\n');
                assert(failed && failed.code === '22P02', `COPY failure is ${failed?.code}`);
                const count = await client.query('SELECT count(*) AS n FROM b5_stream');
                assert(String(count.rows[0].n) === '3', `rows after failed COPY: ${count.rows[0].n}`);
            });
        });

        await check('b5/cursors', async () => {
            await withClient(batch5, async (client) => {
                await client.query('CREATE TABLE b5_pgcur (id int, v text)');
                await client.query("INSERT INTO b5_pgcur VALUES (1,'one'),(2,'two'),(3,'three')");
                const outside = await capture(client.query('DECLARE lone CURSOR FOR SELECT id FROM b5_pgcur'));
                assert(outside?.code === '25P01', `DECLARE outside a transaction: ${outside?.code}`);
                const outsideHold = await capture(client.query('DECLARE early CURSOR WITH HOLD FOR SELECT id FROM b5_pgcur ORDER BY id'));
                assert(outsideHold === null, `WITH HOLD outside a transaction: ${outsideHold?.code}`);
                await client.query('CLOSE early');
                await client.query('BEGIN');
                await client.query('DECLARE c SCROLL CURSOR FOR SELECT id FROM b5_pgcur ORDER BY id');
                const first = await client.query('FETCH 2 FROM c');
                assert(JSON.stringify(first.rows) === '[{"id":1},{"id":2}]', `FETCH 2 is ${JSON.stringify(first.rows)}`);
                assert(first.rowCount === 2, `FETCH 2 row count is ${first.rowCount}`);
                const all = await client.query('FETCH ALL FROM c');
                assert(JSON.stringify(all.rows) === '[{"id":3}]', `FETCH ALL is ${JSON.stringify(all.rows)}`);
                const prior = await client.query('FETCH PRIOR FROM c');
                assert(JSON.stringify(prior.rows) === '[{"id":3}]', `FETCH PRIOR is ${JSON.stringify(prior.rows)}`);
                const moved = await client.query('MOVE BACKWARD 2 IN c');
                assert(moved.rowCount === 2, `MOVE BACKWARD 2 row count is ${moved.rowCount}`);
                await client.query('CLOSE c');
                await client.query('COMMIT');
                const closed = await capture(client.query('FETCH 1 FROM c'));
                assert(closed?.code === '34000', `FETCH after CLOSE: ${closed?.code}`);
                await client.query('BEGIN');
                await client.query('DECLARE dup CURSOR FOR SELECT 1');
                const duplicate = await capture(client.query('DECLARE dup CURSOR FOR SELECT 1'));
                assert(duplicate?.code === '42P03', `duplicate DECLARE: ${duplicate?.code}`);
                await client.query('ROLLBACK');
                await client.query('BEGIN');
                await client.query('DECLARE fwd NO SCROLL CURSOR FOR SELECT id FROM b5_pgcur ORDER BY id');
                await client.query('FETCH 2 FROM fwd');
                const backward = await capture(client.query('FETCH PRIOR FROM fwd'));
                assert(backward?.code === '55000', `NO SCROLL backward: ${backward?.code}`);
                assert(backward?.hint === 'Declare it with SCROLL option to enable backward scan.', `hint is ${backward?.hint}`);
                await client.query('ROLLBACK');
                const held = await capture(client.query('FETCH 1 FROM fwd'));
                assert(held?.code === '34000', `cursor survived ROLLBACK: ${held?.code}`);
                await client.query('DECLARE hold CURSOR WITH HOLD FOR SELECT id FROM b5_pgcur ORDER BY id');
                await client.query('FETCH 2 FROM hold');
                await client.query('COMMIT');
                const afterCommit = await client.query('FETCH ALL FROM hold');
                assert(JSON.stringify(afterCommit.rows) === '[{"id":3}]', `WITH HOLD after COMMIT is ${JSON.stringify(afterCommit.rows)}`);
                await client.query('CLOSE hold');
            });
        });

        await check('b5/prepare', async () => {
            await withClient(batch5, async (client) => {
                await client.query('CREATE TABLE b5_pgprep (id int, v text)');
                await client.query("INSERT INTO b5_pgprep VALUES (1,'one'),(2,'two')");
                await client.query('PREPARE p1 AS SELECT id, v FROM b5_pgprep WHERE id = $1');
                const hit = await client.query("EXECUTE p1('2')");
                assert(JSON.stringify(hit.rows) === '[{"id":2,"v":"two"}]', `EXECUTE p1 is ${JSON.stringify(hit.rows)}`);
                const duplicate = await capture(client.query('PREPARE p1 AS SELECT 1'));
                assert(duplicate?.code === '42P05', `duplicate PREPARE: ${duplicate?.code}`);
                const missing = await capture(client.query('EXECUTE nope(1)'));
                assert(missing?.code === '26000', `missing EXECUTE: ${missing?.code}`);
                await client.query('PREPARE typed (int) AS SELECT $1 AS n');
                const typed = await client.query("EXECUTE typed('7')");
                assert(typed.rows[0].n === 7, `typed EXECUTE returned ${JSON.stringify(typed.rows[0])}`);
                const removed = await capture(client.query('DEALLOCATE nope'));
                assert(removed?.code === '26000', `missing DEALLOCATE: ${removed?.code}`);
                await client.query('DEALLOCATE ALL');
                const gone = await capture(client.query('EXECUTE p1(1)'));
                assert(gone?.code === '26000', `EXECUTE after DEALLOCATE ALL: ${gone?.code}`);
            });
        });

        await check('b5/notify', async () => {
            await withClient(batch5, async (listener) => {
                await withClient(batch5, async (sender) => {
                    const received = [];
                    const selfReceived = [];
                    listener.on('notification', (message) => received.push(message));
                    sender.on('notification', (message) => selfReceived.push(message));
                    await listener.query('LISTEN chan_l');
                    await sender.query("NOTIFY chan_l, 'auto'");
                    assert(await waitFor(() => received.length === 1), 'cross-connection NOTIFY was not delivered');
                    assert(received[0].channel === 'chan_l' && received[0].payload === 'auto', `notification is ${JSON.stringify(received[0])}`);
                    assert(typeof received[0].processId === 'number', `notification pid is ${received[0].processId}`);
                    received.length = 0;
                    await sender.query('BEGIN');
                    await sender.query("NOTIFY chan_l, 'deferred'");
                    await new Promise((rest) => setTimeout(rest, 200));
                    assert(received.length === 0, 'NOTIFY inside a transaction was delivered before COMMIT');
                    await sender.query('COMMIT');
                    assert(await waitFor(() => received.length === 1), 'deferred NOTIFY was not delivered at COMMIT');
                    received.length = 0;
                    await sender.query('BEGIN');
                    await sender.query("NOTIFY chan_l, 'rolled'");
                    await sender.query('ROLLBACK');
                    await new Promise((rest) => setTimeout(rest, 200));
                    assert(received.length === 0, 'NOTIFY on a rolled-back transaction was delivered');
                    received.length = 0;
                    await sender.query('LISTEN chan_l');
                    await sender.query("NOTIFY chan_l, 'self'");
                    assert(await waitFor(() => selfReceived.length === 1), 'self NOTIFY was not delivered');
                    received.length = 0;
                    selfReceived.length = 0;
                    await sender.query('UNLISTEN chan_l');
                    await sender.query("NOTIFY chan_l, 'gone'");
                    await new Promise((rest) => setTimeout(rest, 200));
                    assert(selfReceived.length === 0, 'UNLISTEN still delivered to the sender');
                    assert(received.length === 1 && received[0].payload === 'gone', 'UNLISTEN removed the receiver');
                    const tooLong = await capture(sender.query(`NOTIFY chan_l, '${'x'.repeat(8000)}'`));
                    assert(tooLong?.code === '22023' && tooLong.message === 'payload string too long', `long payload is ${tooLong?.code}`);
                });
            });
        });

        await check('b10/numeric-special', async () => {
            await withClient(batch10, async (client) => {
                const values = await client.query(
                    "SELECT 'NaN'::numeric > 'Infinity'::numeric AS nan_gt_inf, 'NaN'::numeric = 'NaN'::float8 AS nan_eq_f8, '1.234567890123456789'::numeric = 1.2345678901234567::float8 AS lossy, 'NaN'::numeric + 1 AS nan_plus",
                );
                assert(
                    JSON.stringify(values.rows) === '[{"nan_gt_inf":true,"nan_eq_f8":true,"lossy":true,"nan_plus":"NaN"}]',
                    `numeric specials are ${JSON.stringify(values.rows)}`,
                );
                const invalid = await capture(client.query("SELECT 'abc'::numeric"));
                assert(invalid?.code === '22P02', `invalid numeric is ${invalid?.code}`);
                assert(invalid.message === 'invalid input syntax for type numeric: "abc"', `invalid numeric message is ${invalid?.message}`);
                const overflow = await capture(client.query("SELECT 'Infinity'::numeric(10,2)"));
                assert(overflow?.code === '22003' && overflow.message === 'numeric field overflow', `numeric overflow is ${overflow?.code}/${overflow?.message}`);
                assert(overflow.detail === 'A field with precision 10, scale 2 cannot hold an infinite value.', `overflow detail is ${overflow?.detail}`);
            });
        });

        await check('b10/check-fields', async () => {
            await withClient(batch10, async (client) => {
                await client.query('CREATE TABLE b10e_ck (id int, v int CHECK (v > 0), w int, CONSTRAINT ck_w CHECK (w < v))');
                const first = await capture(client.query('INSERT INTO b10e_ck VALUES (1, -1, 0)'));
                assert(first?.code === '23514', `check code is ${first?.code}`);
                assert(first.constraint === 'b10e_ck_v_check', `check constraint is ${first?.constraint}`);
                assert(first.detail === 'Failing row contains (1, -1, 0).', `check detail is ${first?.detail}`);
                const table = await capture(client.query('INSERT INTO b10e_ck VALUES (2, 1, 2)'));
                assert(table?.code === '23514' && table.constraint === 'ck_w', `table check is ${table?.code}/${table?.constraint}`);
            });
        });

        await check('b10/identity', async () => {
            await withClient(batch10, async (client) => {
                await client.query('CREATE TABLE b10e_id (id int GENERATED ALWAYS AS IDENTITY, v text)');
                const inserted = await client.query("INSERT INTO b10e_id (v) VALUES ('a') RETURNING id");
                assert(inserted.rows[0].id === 1, `identity first is ${inserted.rows[0].id}`);
                const explicit = await capture(client.query("INSERT INTO b10e_id (id, v) VALUES (5, 'b')"));
                assert(explicit?.code === '428C9', `identity code is ${explicit?.code}`);
                assert(explicit.message === 'cannot insert a non-DEFAULT value into column "id"', `identity message is ${explicit?.message}`);
                assert(explicit.detail === 'Column "id" is an identity column defined as GENERATED ALWAYS.', `identity detail is ${explicit?.detail}`);
                assert(explicit.hint === 'Use OVERRIDING SYSTEM VALUE to override.', `identity hint is ${explicit?.hint}`);
                const overridden = await client.query("INSERT INTO b10e_id (id, v) OVERRIDING SYSTEM VALUE VALUES (5, 'b') RETURNING id");
                assert(overridden.rows[0].id === 5, `overriding id is ${overridden.rows[0].id}`);
                const next = await client.query("INSERT INTO b10e_id (v) VALUES ('c') RETURNING id");
                assert(next.rows[0].id === 2, `identity next is ${next.rows[0].id}`);
                const updated = await capture(client.query('UPDATE b10e_id SET id = 7 WHERE id = 1'));
                assert(updated?.code === '428C9' && updated.message === 'column "id" can only be updated to DEFAULT', `identity update is ${updated?.code}/${updated?.message}`);
            });
        });

        await check('b10/foreign-keys', async () => {
            await withClient(batch10, async (client) => {
                await client.query('CREATE TABLE b10e_p (id int PRIMARY KEY)');
                await client.query('CREATE TABLE b10e_c (id int PRIMARY KEY, pid int REFERENCES b10e_p(id))');
                const inserted = await client.query('INSERT INTO b10e_p VALUES (1), (2)');
                assert(inserted.rowCount === 2, `parent rows are ${inserted.rowCount}`);
                const missing = await capture(client.query('INSERT INTO b10e_c VALUES (10, 9)'));
                assert(missing?.code === '23503', `foreign key code is ${missing?.code}`);
                assert(missing.constraint === 'b10e_c_pid_fkey', `foreign key constraint is ${missing?.constraint}`);
                assert(missing.detail === 'Key (pid)=(9) is not present in table "b10e_p".', `foreign key detail is ${missing?.detail}`);
                await client.query('INSERT INTO b10e_c VALUES (10, 1)');
                const restrict = await capture(client.query('DELETE FROM b10e_p WHERE id = 1'));
                assert(restrict?.code === '23503', `restrict code is ${restrict?.code}`);
                assert(restrict.message === 'update or delete on table "b10e_p" violates foreign key constraint "b10e_c_pid_fkey" on table "b10e_c"');
                assert(restrict.detail === 'Key (id)=(1) is still referenced from table "b10e_c".', `restrict detail is ${restrict?.detail}`);
                await client.query('CREATE TABLE b10e_pp (a int, b int, UNIQUE (a, b))');
                await client.query(
                    'CREATE TABLE b10e_m (id int PRIMARY KEY, a int, b int, FOREIGN KEY (a, b) REFERENCES b10e_pp(a, b) MATCH FULL DEFERRABLE INITIALLY DEFERRED)',
                );
                const match = await capture(client.query('INSERT INTO b10e_m VALUES (20, 1, NULL)'));
                assert(match?.code === '23503', `match full code is ${match?.code}`);
                assert(match.detail === 'MATCH FULL does not allow mixing of null and nonnull key values.', `match full detail is ${match?.detail}`);
                assert(match.constraint === 'b10e_m_a_b_fkey', `match full constraint is ${match?.constraint}`);
                const stored = await client.query(
                    "SELECT confmatchtype, condeferrable, condeferred FROM pg_constraint WHERE conname = 'b10e_m_a_b_fkey'",
                );
                assert(
                    JSON.stringify(stored.rows) === '[{"confmatchtype":"f","condeferrable":true,"condeferred":true}]',
                    `stored foreign key is ${JSON.stringify(stored.rows)}`,
                );
            });
        });

        if (process.env.PSQL_BIN) {
            const runFixture = (server, file) =>
                new Promise((resolve, reject) => {
                    const child = spawn(
                        psql,
                        ['-h', server.host, '-p', String(server.port), '-U', 'postgres', '-d', 'postgres', '-f', file],
                        {
                            cwd: path.join(harnessDir, 'fixtures'),
                            env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C', PGCLIENTENCODING: 'UTF8' },
                            stdio: ['ignore', 'pipe', 'pipe'],
                        },
                    );
                    const stdout = [];
                    const stderr = [];
                    child.stdout.on('data', (chunk) => stdout.push(chunk));
                    child.stderr.on('data', (chunk) => stderr.push(chunk));
                    child.once('error', reject);
                    child.once('close', (status) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status: status ?? 1 }));
                });
            const checkFixture = async (name, prefix, script, server = batch5) => {
                await check(name, async () => {
                    const result = await runFixture(server, script);
                    const expectedOut = fs.readFileSync(path.join(harnessDir, 'fixtures', `${prefix}.out.txt`));
                    const expectedErr = fs.readFileSync(path.join(harnessDir, 'fixtures', `${prefix}.err.txt`));
                    assert(result.status === 0, `${script} exited with ${result.status}: ${result.stderr.toString('utf8')}`);
                    assert(
                        Buffer.compare(result.stdout, expectedOut) === 0,
                        `${script} stdout differs: ${JSON.stringify(result.stdout.toString('utf8').slice(0, 200))}`,
                    );
                    assert(
                        Buffer.compare(result.stderr, expectedErr) === 0,
                        `${script} stderr differs: ${JSON.stringify(result.stderr.toString('utf8').slice(0, 200))}`,
                    );
                });
            };
            await checkFixture('psql/b5-copy-to', 'b5-copy-to', 'b5-copy-to.sql');
            await checkFixture('psql/b5-copy-from', 'b5-copy-from', 'b5-copy-from.sql');
            await checkFixture('psql/b5-copy-dup', 'b5-copy-dup', 'b5-copy-dup.sql');
            await checkFixture('psql/b5-copy-bad', 'b5-copy-bad', 'b5-copy-bad.sql');
            await checkFixture('psql/b5-cursors', 'b5-cursors', 'b5-cursors.sql');
            await checkFixture('psql/b5-prepare', 'b5-prepare', 'b5-prepare.sql');
            await checkFixture('psql/b6-l', 'b6-l', 'b6-l.sql');
            await checkFixture('psql/b6-datacl', 'b6-datacl', 'b6-datacl.sql');
            await checkFixture('psql/b6-pg-database', 'b6-pg-database', 'b6-pg-database.sql');
            await checkFixture('psql/b7-database', 'b7-database', 'b7-database.sql', batch7);
            await checkFixture('psql/b8-options', 'b8-options', 'b8-options.sql', batch8);
            await checkFixture('psql/b9-roles', 'b9-roles', 'b9-roles.sql', batch9fixture);
            await checkFixture('psql/b10-numeric', 'b10-numeric', 'b10-numeric.sql', batch10);
            await checkFixture('psql/b10-identity', 'b10-identity', 'b10-identity.sql', batch10);
            await checkFixture('psql/b10-check', 'b10-check', 'b10-check.sql', batch10);
            await checkFixture('psql/b10-foreign', 'b10-foreign', 'b10-foreign.sql', batch10);

            // Batch 12: transactions. The transcripts below were captured from
            // PostgreSQL 16.9 through the same psql on stdin, so stdout and
            // stderr have to match byte for byte.
            const runStdinOn = (server, script, extraArgs = []) =>
                new Promise((resolve, reject) => {
                    const child = spawn(
                        psql,
                        ['-X', '-h', server.host, '-p', String(server.port), '-U', 'postgres', '-d', 'postgres', ...extraArgs, '-f', '-'],
                        { env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] },
                    );
                    let stdout = '';
                    let stderr = '';
                    child.stdout.on('data', (chunk) => {
                        stdout += chunk;
                    });
                    child.stderr.on('data', (chunk) => {
                        stderr += chunk;
                    });
                    child.once('error', reject);
                    child.once('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
                    child.stdin.end(script);
                });
            const sameStreams = async (server, script, prefix, extraArgs = []) => {
                const result = await runStdinOn(server, script, extraArgs);
                const expectedOut = fs.readFileSync(path.join(harnessDir, 'fixtures', `${prefix}.out.txt`));
                const expectedErr = fs.readFileSync(path.join(harnessDir, 'fixtures', `${prefix}.err.txt`));
                assert(result.status === 0, `${prefix} exited with ${result.status}: ${result.stderr}`);
                assert(
                    Buffer.compare(Buffer.from(result.stdout, 'utf8'), expectedOut) === 0,
                    `${prefix} stdout differs:\n${result.stdout}`,
                );
                assert(
                    Buffer.compare(Buffer.from(result.stderr, 'utf8'), expectedErr) === 0,
                    `${prefix} stderr differs:\n${result.stderr}`,
                );
            };
            const visibilityScript = (server) =>
                fs
                    .readFileSync(path.join(harnessDir, 'fixtures', 'tx-visibility.sql'), 'utf8')
                    .replaceAll('{{PSQL}}', `"${psql}"`)
                    .replaceAll('{{PORT}}', String(server.port))
                    .replaceAll('{{DB}}', 'postgres');

            await check('psql/tx-script', async () => {
                await sameStreams(batchTx, fs.readFileSync(path.join(harnessDir, 'fixtures', 'tx-script.sql'), 'utf8'), 'psql-tx');
                lines.push('  tx transcript matches pg16 byte for byte');
            });

            await check('psql/join-script', async () => {
                await sameStreams(batchJoin, fs.readFileSync(path.join(harnessDir, 'fixtures', 'join-script.sql'), 'utf8'), 'psql-join');
                lines.push('  join transcript matches pg16 byte for byte');
            });

            await check('psql/agg-script', async () => {
                await sameStreams(batchAgg, fs.readFileSync(path.join(harnessDir, 'fixtures', 'agg-script.sql'), 'utf8'), 'psql-agg');
                lines.push('  aggregate transcript matches pg16 byte for byte');
            });

            await check('psql/tx-visibility', async () => {
                await sameStreams(batchTxVis, visibilityScript(batchTxVis), 'psql-tx-vis');
                lines.push('  read committed and repeatable read visibility matches pg16 byte for byte');
            });

            await check('psql/tx-40001', async () => {
                const result = await runStdinOn(batchTxVerbose, visibilityScript(batchTxVerbose), ['-v', 'VERBOSITY=verbose']);
                assert(result.status === 0, `verbose visibility exited ${result.status}: ${result.stderr}`);
                const report = result.stderr.trimEnd().split(/\r?\n/);
                assert(report.length === 2, `serialization output has ${report.length} lines: ${result.stderr}`);
                assert(
                    report[0] === 'psql:<stdin>:21: ERROR:  40001: could not serialize access due to concurrent update',
                    `serialization error is ${report[0]}`,
                );
                assert(/^LOCATION:  \S/.test(report[1]), `serialization report lacks LOCATION: ${result.stderr}`);
            });

            await check('psql/tx-deadlock', async () => {
                const sleep = '\\! powershell -NoProfile -Command "Start-Sleep -Milliseconds 400"';
                const body = (label, first, second) =>
                    `BEGIN;\nUPDATE dl SET v = '${label}' WHERE id = ${first};\n${sleep}\nUPDATE dl SET v = '${label}' WHERE id = ${second};\nCOMMIT;\n`;
                const setup = await runStdinOn(
                    batchTxDeadlock,
                    "CREATE TABLE dl (id int, v text);\nINSERT INTO dl VALUES (1, 'seed');\nINSERT INTO dl VALUES (2, 'seed');\n",
                );
                assert(setup.status === 0, `deadlock setup exited ${setup.status}: ${setup.stderr}`);
                const first = runStdinOn(batchTxDeadlock, body('from-a', 1, 2), ['-v', 'VERBOSITY=verbose']);
                await new Promise((resolve) => setTimeout(resolve, 150));
                const second = runStdinOn(batchTxDeadlock, body('from-b', 2, 1), ['-v', 'VERBOSITY=verbose']);
                const [ra, rb] = await Promise.all([first, second]);
                const winners = [ra, rb].filter((result) => !result.stderr.includes('deadlock detected'));
                assert(winners.length === 1, `expected exactly one surviving session, received ${winners.length}`);
                const loser = ra === winners[0] ? rb : ra;
                const winner = winners[0];
                assert(winner.stderr === '', `the surviving session reported ${winner.stderr}`);
                const masked = loser.stderr
                    .replace(/\r\n/g, '\n')
                    .replace(/Process \d+/g, 'Process <pid>')
                    .replace(/blocked by process \d+/g, 'blocked by process <pid>')
                    .replace(/transaction \d+/g, 'transaction <tid>')
                    .replace(/\(0,\d+\)/g, '(0,<tuple>)')
                    .replace(/^LOCATION:  .*$/m, 'LOCATION:  <location>');
                const expected = [
                    'psql:<stdin>:4: ERROR:  40P01: deadlock detected',
                    'DETAIL:  Process <pid> waits for ShareLock on transaction <tid>; blocked by process <pid>.',
                    'Process <pid> waits for ShareLock on transaction <tid>; blocked by process <pid>.',
                    'HINT:  See server log for query details.',
                    'CONTEXT:  while updating tuple (0,<tuple>) in relation "dl"',
                    'LOCATION:  <location>',
                    '',
                ].join('\n');
                assert(masked === expected, `deadlock report differs:\n${masked}`);
                await withClient(batchTxDeadlock, async (client) => {
                    const rows = await client.query('SELECT id, v FROM dl ORDER BY id');
                    const label = ra === winner ? 'from-a' : 'from-b';
                    assert(
                        JSON.stringify(rows.rows) ===
                            JSON.stringify([
                                { id: 1, v: label },
                                { id: 2, v: label },
                            ]),
                        `deadlock left ${JSON.stringify(rows.rows)} instead of the surviving transaction`,
                    );
                });
                lines.push('  40P01 report matches pg16 modulo process, transaction and tuple ids');
            });
        }

        // Batch 12: a client that dies mid-transaction must not leave rows
        // behind, and a commit already on the wire must complete exactly once.
        await check('tx/disconnect-rollback', async () => {
            const wire = await openTrustSession(batchTxDisc.host, batchTxDisc.port);
            requireTags(await wire.query('CREATE TABLE tx_disc (id int)'), 'CZ');
            await wire.query('BEGIN');
            await wire.query('INSERT INTO tx_disc VALUES (1)');
            wire.socket.destroy();
            await new Promise((resolve) => setTimeout(resolve, 300));
            const verify = await openTrustSession(batchTxDisc.host, batchTxDisc.port);
            const rows = await verify.query('SELECT count(*) FROM tx_disc');
            assert(JSON.stringify(firstRow(rows)) === '["0"]', `an interrupted transaction left ${JSON.stringify(firstRow(rows))}`);
            verify.close();
        });

        await check('tx/disconnect-commit', async () => {
            const wire = await openTrustSession(batchTxDisc.host, batchTxDisc.port);
            await wire.query('BEGIN');
            await wire.query('INSERT INTO tx_disc VALUES (2)');
            wire.send(frame('Q', Buffer.concat([Buffer.from('COMMIT'), Buffer.from([0])])));
            await new Promise((resolve) => setTimeout(resolve, 30));
            wire.socket.destroy();
            let count = null;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const verify = await openTrustSession(batchTxDisc.host, batchTxDisc.port);
                const rows = await verify.query('SELECT count(*) FROM tx_disc');
                count = firstRow(rows)[0];
                verify.close();
                if (count === '1') break;
            }
            assert(count === '1', `a commit in flight applied ${count} rows`);
            const again = await openTrustSession(batchTxDisc.host, batchTxDisc.port);
            const rows = await again.query('SELECT count(*) FROM tx_disc WHERE id = 2');
            assert(JSON.stringify(firstRow(rows)) === '["1"]', `the commit was applied ${JSON.stringify(firstRow(rows))} times`);
            again.close();
        });

        return {
            name: 'server',
            output: lines.join('\n'),
            counts: { executed, skipped: 0, failed },
            // 98 before batch 11, plus the GUC, binary, `pg_cursors`, temp-table
            // and structured-error checks, the system-catalog meta sweep, the
            // transaction transcript, visibility, serialization, deadlock and
            // disconnect checks, and the join and aggregate transcripts.
            floor: 116,
        };
    } finally {
        await trust.close();
        await password.close();
        await batch2.close();
        await batch3.close();
        await batch4.close();
        await batch5.close();
        await batch7.close();
        await batch8.close();
        await batch9.close();
        await batch9fixture.close();
        await batch10.close();
        await batchMeta.close();
        await batchTx.close();
        await batchTxVis.close();
        await batchTxVerbose.close();
        await batchTxDeadlock.close();
        await batchTxDisc.close();
        await batchJoin.close();
        await batchAgg.close();
    }
}
