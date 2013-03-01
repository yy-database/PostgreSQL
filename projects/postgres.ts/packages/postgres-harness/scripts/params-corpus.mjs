/**
 * Regenerates `cases/params.json` from a real PostgreSQL backend.
 *
 * Every expectation is measured, not derived from this repository: the script
 * opens a PGlite instance, connects over TCP, and sends exactly the extended
 * protocol frames documented in `postgres-client::protocol`. Run it from
 * `projects/postgres.ts/packages/postgres-harness`:
 *
 *     node scripts/params-corpus.mjs
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = path.join(harnessDir, 'cases', 'params.json');

// -------------------------------------------------------------------------------
// Independent wire builder. The layout follows the PostgreSQL protocol chapter.
// -------------------------------------------------------------------------------
const cstr = (value) => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
const i32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
};
const u16 = (value) => {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value);
    return buffer;
};
const frame = (tag, payload) => Buffer.concat([Buffer.from(tag), i32(payload.length + 4), payload]);

const parseMsg = (name, sql, types = []) =>
    frame('P', Buffer.concat([cstr(name), cstr(sql), u16(types.length), ...types.map(i32)]));
const bindMsg = (portal, statement, params) => {
    const parts = [cstr(portal), cstr(statement), u16(0), u16(params.length)];
    for (const value of params) {
        if (value === null) parts.push(i32(-1));
        else {
            const bytes = Buffer.from(value, 'utf8');
            parts.push(i32(bytes.length), bytes);
        }
    }
    parts.push(u16(0));
    return frame('B', Buffer.concat(parts));
};
const describeMsg = (target, name) => frame('D', Buffer.concat([Buffer.from(target), cstr(name)]));
const executeMsg = (portal, maxRows = 0) => frame('E', Buffer.concat([cstr(portal), i32(maxRows)]));
const syncMsg = () => frame('S', Buffer.alloc(0));
const closeMsg = (target, name) => frame('C', Buffer.concat([Buffer.from(target), cstr(name)]));
const queryMsg = (sql) => frame('Q', cstr(sql));

// -------------------------------------------------------------------------------
// Response decoding.
// -------------------------------------------------------------------------------
function parsePayloads(buffer) {
    const messages = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
        const tag = String.fromCharCode(buffer[offset]);
        const length = buffer.readInt32BE(offset + 1);
        if (length < 4 || offset + 1 + length > buffer.length) break;
        messages.push({ tag, payload: buffer.subarray(offset + 5, offset + 1 + length) });
        offset += 1 + length;
    }
    return messages;
}

function cstrings(payload) {
    const values = [];
    let start = 0;
    for (let index = 0; index < payload.length; index += 1) {
        if (payload[index] === 0) {
            values.push(payload.subarray(start, index).toString('utf8'));
            start = index + 1;
        }
    }
    return values;
}

function columnNames(payload) {
    if (payload.length < 2) throw new Error('truncated RowDescription');
    const count = payload.readUInt16BE(0);
    const names = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const end = payload.indexOf(0, offset);
        names.push(payload.subarray(offset, end).toString('utf8'));
        offset = end + 1 + 18;
    }
    return names;
}

function dataRow(payload, columns) {
    const count = payload.readUInt16BE(0);
    if (count !== columns) throw new Error(`DataRow has ${count} values for ${columns} columns`);
    const values = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const length = payload.readInt32BE(offset);
        offset += 4;
        if (length < 0) values.push(null);
        else {
            values.push(payload.subarray(offset, offset + length).toString('utf8'));
            offset += length;
        }
    }
    return values;
}

function errorPayload(payload) {
    const fields = {};
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
        const kind = String.fromCharCode(payload[offset]);
        offset += 1;
        const end = payload.indexOf(0, offset);
        fields[kind] = payload.subarray(offset, end).toString('utf8');
        offset = end + 1;
    }
    return { code: fields.C ?? '', message: fields.M ?? '' };
}

function collect(messages) {
    const results = [];
    let current = null;
    let described = [];
    let parameters = [];
    let error = null;
    for (const message of messages) {
        switch (message.tag) {
            case 't':
                parameters = [];
                for (let index = 0; index < message.payload.readUInt16BE(0); index += 1) {
                    parameters.push(message.payload.readUInt32BE(2 + index * 4));
                }
                break;
            case 'T':
                current = { columns: columnNames(message.payload), rows: [] };
                described = current.columns;
                break;
            case 'n':
                current = { columns: [], rows: [] };
                break;
            case 'D':
                if (!current) throw new Error('DataRow without RowDescription');
                current.rows.push(dataRow(message.payload, current.columns.length));
                break;
            case 'C':
                results.push({ ...(current ?? { columns: described, rows: [] }), tag: cstrings(message.payload)[0] });
                current = null;
                break;
            case 'E':
                error = errorPayload(message.payload);
                break;
            default:
                break;
        }
    }
    return { results, described, parameters, error };
}

// -------------------------------------------------------------------------------
// Server.
// -------------------------------------------------------------------------------
async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

const db = new PGlite();
await db.waitReady;
const port = await freePort();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 4 });
await server.start();

const socket = net.connect(port, '127.0.0.1');
socket.setNoDelay(true);
await new Promise((resolve) => socket.once('connect', resolve));

let pending = Buffer.alloc(0);
const readyWaiters = [];

socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (readyWaiters.length > 0) {
        const messages = parsePayloads(pending);
        const last = messages[messages.length - 1];
        if (last && last.tag === 'Z') {
            const consumed = messages.reduce((total, message) => total + 5 + message.payload.length, 0);
            pending = pending.subarray(consumed);
            readyWaiters.shift()(messages);
            continue;
        }
        break;
    }
});

function ready() {
    return new Promise((resolve) => readyWaiters.push(resolve));
}

async function send(...frames) {
    socket.write(Buffer.concat(frames));
    return collect(await ready());
}

const startupPayload = Buffer.concat([
    i32(196608),
    cstr('user'),
    cstr('postgres'),
    cstr('database'),
    cstr('postgres'),
    cstr('client_encoding'),
    cstr('UTF8'),
    Buffer.from([0]),
]);
socket.write(Buffer.concat([i32(startupPayload.length + 4), startupPayload]));
await ready();

async function simple(sql) {
    const outcome = await send(queryMsg(sql));
    if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    return outcome.results;
}

// -------------------------------------------------------------------------------
// Case definitions. Each entry is replayed by both acceptance suites.
// -------------------------------------------------------------------------------
const binding = [
    { name: 'int4', sql: 'SELECT $1::int4 AS v', params: ['42'], types: [] },
    { name: 'int2', sql: 'SELECT $1::int2 AS v', params: ['-7'], types: [] },
    { name: 'int8', sql: 'SELECT $1::int8 AS v', params: ['9223372036854775807'], types: [] },
    { name: 'float4', sql: 'SELECT $1::float4 AS v', params: ['1.5'], types: [] },
    { name: 'float8', sql: 'SELECT $1::float8 AS v', params: ['1.5e300'], types: [] },
    { name: 'numeric', sql: 'SELECT $1::numeric AS v', params: ['1.234567890123456789'], types: [] },
    { name: 'text-unicode', sql: 'SELECT $1::text AS v', params: ['héllo 世界'], types: [] },
    { name: 'text-empty', sql: 'SELECT $1::text AS v', params: [''], types: [] },
    { name: 'bool-true', sql: 'SELECT $1::bool AS v', params: ['true'], types: [] },
    { name: 'bool-false', sql: 'SELECT $1::bool AS v', params: ['false'], types: [] },
    { name: 'null-int4', sql: 'SELECT $1::int4 AS v', params: [null], types: [] },
    { name: 'bytea', sql: 'SELECT $1::bytea AS v', params: ['\\x0041FF'], types: [] },
    { name: 'date', sql: 'SELECT $1::date AS v', params: ['2024-02-29'], types: [] },
    { name: 'time', sql: 'SELECT $1::time AS v', params: ['12:34:56.789'], types: [] },
    { name: 'timestamp', sql: 'SELECT $1::timestamp AS v', params: ['2024-02-29 12:34:56.789'], types: [] },
    { name: 'timestamptz', sql: 'SELECT $1::timestamptz AS v', params: ['2024-02-29 12:34:56.789+00'], types: [] },
    { name: 'varchar', sql: 'SELECT $1::varchar AS v', params: ['abc'], types: [] },
    { name: 'uuid', sql: 'SELECT $1::uuid AS v', params: ['0f8fad5b-d9cb-469f-a165-70867728950e'], types: [] },
    { name: 'jsonb', sql: 'SELECT $1::jsonb AS v', params: ['{"a":1,"b":[2,3]}'], types: [] },
    { name: 'declared-int4', sql: 'SELECT $1 AS v', params: ['42'], types: ['int4'] },
    { name: 'declared-int8', sql: 'SELECT $1 AS v', params: ['9223372036854775807'], types: ['int8'] },
    { name: 'declared-bool', sql: 'SELECT $1 AS v', params: ['true'], types: ['bool'] },
    { name: 'declared-bytea', sql: 'SELECT $1 AS v', params: ['\\x0041FF'], types: ['bytea'] },
    { name: 'declared-text', sql: 'SELECT $1 AS v', params: ['héllo'], types: ['text'] },
    { name: 'declared-numeric', sql: 'SELECT $1 AS v', params: ['1.234567890123456789'], types: ['numeric'] },
    { name: 'declared-timestamptz', sql: 'SELECT $1 AS v', params: ['2024-02-29 12:34:56.789+00'], types: ['timestamptz'] },
    { name: 'two-values', sql: 'SELECT $1::int4 + $2::int4 AS total', params: ['2', '3'], types: [] },
    { name: 'repeated-param', sql: 'SELECT $1::int4 AS a, $1::int4 + 1 AS b', params: ['5'], types: [] },
    { name: 'null-and-value', sql: 'SELECT $1::text AS a, $2::int4 AS b', params: [null, '7'], types: [] },
    { name: 'text-concat', sql: 'SELECT $1::text || $2::text AS v', params: ['ab', 'cd'], types: [] },
    { name: 'gap-second', sql: 'SELECT $2::text AS v', params: ['a', 'b'], types: ['text', 'text'] },
    { name: 'gap-second-null', sql: 'SELECT $2::text AS v', params: ['a', null], types: ['text', 'text'] },
    { name: 'gap-second-declared', sql: 'SELECT $2 AS v', params: ['a', 'b'], types: ['text', 'text'] },
    { name: 'gap-third', sql: 'SELECT $3::int4 AS v', params: ['a', 'b', '9'], types: ['text', 'text', 'int4'] },
    { name: 'literal-lookalike', sql: "SELECT '$1' AS lit, $1::int4 AS bound", params: ['7'], types: [] },
    { name: 'dollar-quoted-lookalike', sql: 'SELECT $$abc $1$$ AS lit, $1::int4 AS bound', params: ['7'], types: [] },
    { name: 'comment-lookalike', sql: 'SELECT $1::int4 AS v /* $2 */', params: ['3'], types: [] },
    { name: 'untyped-select', sql: 'SELECT $1 AS v', params: ['x'], types: [] },
    { name: 'values-rows', sql: 'SELECT * FROM (VALUES ($1::int4), ($2::int4)) AS t(x)', params: ['1', '2'], types: [] },
    { name: 'empty-statement', sql: '', params: [], types: [] },
    {
        name: 'insert-params',
        setup: ['DROP TABLE IF EXISTS pg_param_case', 'CREATE TABLE pg_param_case (id int4 PRIMARY KEY, name text)'],
        sql: 'INSERT INTO pg_param_case (id, name) VALUES ($1, $2)',
        params: ['1', 'alice'],
        types: [],
        teardown: ['DROP TABLE pg_param_case'],
    },
    {
        name: 'update-params',
        setup: ['DROP TABLE IF EXISTS pg_param_case', 'CREATE TABLE pg_param_case (id int4 PRIMARY KEY, name text)', "INSERT INTO pg_param_case VALUES (1, 'alice'), (2, 'bob')"],
        sql: 'UPDATE pg_param_case SET name = $2 WHERE id = $1',
        params: ['1', 'carol'],
        types: [],
        teardown: ['DROP TABLE pg_param_case'],
    },
    {
        name: 'delete-params',
        setup: ['DROP TABLE IF EXISTS pg_param_case', 'CREATE TABLE pg_param_case (id int4 PRIMARY KEY, name text)', "INSERT INTO pg_param_case VALUES (1, 'alice'), (2, 'bob')"],
        sql: 'DELETE FROM pg_param_case WHERE id = $1',
        params: ['2'],
        types: [],
        teardown: ['DROP TABLE pg_param_case'],
    },
    {
        name: 'select-from-table',
        setup: ['DROP TABLE IF EXISTS pg_param_case', 'CREATE TABLE pg_param_case (id int4 PRIMARY KEY, name text)', "INSERT INTO pg_param_case VALUES (1, 'alice'), (2, 'bob')"],
        sql: 'SELECT name FROM pg_param_case WHERE id = $1',
        params: ['1'],
        types: [],
        teardown: ['DROP TABLE pg_param_case'],
    },
];

const errors = [
    { name: 'too-few', sql: 'SELECT $1::int4, $2::int4', params: ['1'], types: [] },
    { name: 'too-many', sql: 'SELECT $1::int4', params: ['1', '2'], types: [] },
    { name: 'position-zero', sql: 'SELECT $0::int4', params: [], types: [] },
    { name: 'position-negative', sql: 'SELECT $-1::int4', params: [], types: [] },
    { name: 'position-huge', sql: 'SELECT $100000::int4', params: [], types: [] },
    { name: 'literal-only', sql: "SELECT '$1' AS lit", params: ['9'], types: [] },
    { name: 'int4-mismatch', sql: 'SELECT $1::int4', params: ['abc'], types: [] },
    { name: 'bool-mismatch', sql: 'SELECT $1::bool', params: ['maybe'], types: [] },
    { name: 'int4-overflow', sql: 'SELECT $1::int4', params: ['9999999999'], types: [] },
    { name: 'date-invalid', sql: 'SELECT $1::date', params: ['2024-02-30'], types: [] },
    { name: 'numeric-invalid', sql: 'SELECT $1::numeric', params: ['1.2.3'], types: [] },
    { name: 'gap-undeclared', sql: 'SELECT $2::text AS v', params: [], types: [] },
    { name: 'gap-too-few', sql: 'SELECT $2::text AS v', params: ['a'], types: ['text', 'text'] },
];

const prepare = [
    { name: 'select-expression', sql: 'SELECT $1::int4 + 1 AS v', types: [] },
    { name: 'declared-parameter', sql: 'SELECT $1 AS v', types: ['text'] },
    { name: 'gap-parameters', sql: 'SELECT $2::text AS v', types: ['text', 'text'] },
    { name: 'gap-declared', sql: 'SELECT $2 AS v', types: ['text', 'text'] },
    { name: 'no-parameters', sql: 'SELECT 1 AS v', types: [] },
    { name: 'empty-statement', sql: '', types: [] },
    {
        name: 'insert-without-result-set',
        setup: ['DROP TABLE IF EXISTS pg_param_case', 'CREATE TABLE pg_param_case (id int4 PRIMARY KEY, name text)'],
        sql: 'INSERT INTO pg_param_case (id) VALUES ($1)',
        types: [],
        teardown: ['DROP TABLE pg_param_case'],
    },
    { name: 'inferred-text', sql: 'SELECT $1 AS v', types: [] },
    { name: 'multi-statement', sql: 'SELECT 1; SELECT 2', types: [], error: true },
];

const lifecycle = [
    {
        name: 'repeated-and-closed',
        ops: [
            { op: 'prepare', sql: 'SELECT $1::int4 * 2 AS v', types: [] },
            { op: 'execute', stmt: 0, params: ['21'] },
            { op: 'execute', stmt: 0, params: ['4'] },
            { op: 'execute', stmt: 0, params: [null] },
            { op: 'close', stmt: 0 },
            { op: 'close', stmt: 0 },
            { op: 'executeError', stmt: 0, params: [], message: 'statement is closed' },
            { op: 'executePreparedError', stmt: 0, params: [] },
            { op: 'query', sql: 'SELECT 1 AS n' },
        ],
    },
    {
        name: 'interleaved',
        ops: [
            { op: 'prepare', sql: 'SELECT $1::text || $2::text AS v', types: [] },
            { op: 'prepare', sql: 'SELECT $1::int4 * 10 AS v', types: [] },
            { op: 'execute', stmt: 0, params: ['x', '-a'] },
            { op: 'execute', stmt: 1, params: ['4'] },
            { op: 'execute', stmt: 0, params: ['y', '-b'] },
            { op: 'execute', stmt: 1, params: ['12'] },
            { op: 'close', stmt: 0 },
            { op: 'close', stmt: 1 },
        ],
    },
    {
        name: 'same-sql-twice',
        ops: [
            { op: 'prepare', sql: 'SELECT $1::int4 AS v', types: [] },
            { op: 'prepare', sql: 'SELECT $1::int4 AS v', types: [] },
            { op: 'execute', stmt: 0, params: ['1'] },
            { op: 'execute', stmt: 1, params: ['2'] },
            { op: 'close', stmt: 1 },
            { op: 'execute', stmt: 0, params: ['3'] },
            { op: 'close', stmt: 0 },
        ],
    },
    {
        name: 'dml-lifecycle',
        setup: ['DROP TABLE IF EXISTS pg_param_life', 'CREATE TABLE pg_param_life (id int4 PRIMARY KEY, name text)'],
        teardown: ['DROP TABLE pg_param_life'],
        ops: [
            { op: 'prepare', sql: 'INSERT INTO pg_param_life (id, name) VALUES ($1, $2)', types: [] },
            { op: 'execute', stmt: 0, params: ['1', 'alice'] },
            { op: 'execute', stmt: 0, params: ['2', 'bob'] },
            { op: 'prepare', sql: 'UPDATE pg_param_life SET name = $2 WHERE id = $1', types: [] },
            { op: 'execute', stmt: 1, params: ['1', 'carol'] },
            { op: 'query', sql: 'SELECT name FROM pg_param_life ORDER BY id' },
            { op: 'close', stmt: 0 },
            { op: 'close', stmt: 1 },
        ],
    },
    {
        name: 'close-unknown',
        ops: [{ op: 'closeNamed', name: 'pg_missing_statement' }],
    },
];

function buildMessage(spec) {
    switch (spec.kind) {
        case 'parse':
            return parseMsg(spec.name0, spec.sql, spec.types);
        case 'bind':
            return bindMsg(spec.portal, spec.statement, spec.params);
        case 'describe':
            return describeMsg(spec.target === 'statement' ? 'S' : 'P', spec.name0);
        case 'execute':
            return executeMsg(spec.portal, spec.maxRows);
        case 'sync':
            return syncMsg();
        case 'close':
            return closeMsg(spec.target === 'statement' ? 'S' : 'P', spec.name0);
        default:
            throw new Error(`unknown message kind ${spec.kind}`);
    }
}

// -------------------------------------------------------------------------------
// Measure.
// -------------------------------------------------------------------------------
function oidsOf(types) {
    const catalog = {
        bool: 16,
        bytea: 17,
        int8: 20,
        int2: 21,
        int4: 23,
        text: 25,
        varchar: 1043,
        float4: 700,
        float8: 701,
        numeric: 1700,
        date: 1082,
        time: 1083,
        timestamp: 1114,
        timestamptz: 1184,
        uuid: 2950,
        json: 114,
        jsonb: 3802,
    };
    return types.map((name) => {
        if (!(name in catalog)) throw new Error(`unknown type ${name}`);
        return catalog[name];
    });
}

async function measureBinding(item) {
    for (const statement of item.setup ?? []) await simple(statement);
    const outcome = await send(
        parseMsg('', item.sql, oidsOf(item.types)),
        bindMsg('', '', item.params),
        describeMsg('P', ''),
        executeMsg(''),
        syncMsg(),
    );
    for (const statement of item.teardown ?? []) await simple(statement);
    const measured = { ...item };
    if (outcome.error) measured.error = { code: outcome.error.code, messageContains: outcome.error.message.split(' at character')[0] };
    else measured.expect = outcome.results;
    return measured;
}

async function measurePrepare(item) {
    for (const statement of item.setup ?? []) await simple(statement);
    const name = `corpus_${item.name}`;
    const outcome = await send(parseMsg(name, item.sql, oidsOf(item.types)), describeMsg('S', name), syncMsg());
    await send(closeMsg('S', name), syncMsg());
    for (const statement of item.teardown ?? []) await simple(statement);
    const measured = { ...item };
    if (item.error) {
        measured.expectError = {
            code: outcome.error?.code ?? '',
            messageContains: (outcome.error?.message ?? '').split(' at character')[0],
        };
        delete measured.error;
    } else {
        measured.expectParameters = outcome.parameters;
        measured.expectColumns = outcome.described;
    }
    return measured;
}

async function measureLifecycle(item) {
    for (const statement of item.setup ?? []) await simple(statement);
    const names = [];
    const ops = [];
    for (const [index, op] of item.ops.entries()) {
        const measured = { ...op };
        if (op.op === 'prepare') {
            const name = `corpus_${item.name}_${names.length}`;
            names.push(name);
            const outcome = await send(parseMsg(name, op.sql, oidsOf(op.types)), describeMsg('S', name), syncMsg());
            measured.expectParameters = outcome.parameters;
            measured.expectColumns = outcome.described;
        } else if (op.op === 'execute') {
            const outcome = await send(
                bindMsg('', names[op.stmt], op.params),
                describeMsg('P', ''),
                executeMsg(''),
                syncMsg(),
            );
            if (outcome.error) throw new Error(`${item.name}: ${outcome.error.code} ${outcome.error.message}`);
            measured.expect = outcome.results;
        } else if (op.op === 'executePreparedError') {
            const outcome = await send(bindMsg('', names[op.stmt], op.params), executeMsg(''), syncMsg());
            if (!outcome.error) throw new Error(`${item.name}: expected the server to reject a closed statement`);
            measured.code = outcome.error.code;
            measured.messageContains = 'does not exist';
        } else if (op.op === 'close') {
            await send(closeMsg('S', names[op.stmt]), syncMsg());
        } else if (op.op === 'closeNamed') {
            await send(closeMsg('S', op.name), syncMsg());
        } else if (op.op === 'query') {
            const outcome = await send(queryMsg(op.sql));
            if (outcome.error) throw new Error(`${item.name}: ${outcome.error.code} ${outcome.error.message}`);
            measured.expect = outcome.results;
        } else if (op.op !== 'executeError') {
            throw new Error(`${item.name}: unknown op ${op.op}`);
        }
        ops.push(measured);
    }
    for (const statement of item.teardown ?? []) await simple(statement);
    return { name: item.name, setup: item.setup ?? [], teardown: item.teardown ?? [], ops };
}

async function countPrepared() {
    const outcome = await send(queryMsg('SELECT count(*) AS n FROM pg_prepared_statements'));
    if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    return Number(outcome.results[0].rows[0][0]);
}

async function measureLeak() {
    const statement = 'SELECT $1::int4 AS v';
    const baseline = await countPrepared();
    const names = [];
    for (let index = 0; index < 3; index += 1) {
        const name = `corpus_leak_${index}`;
        names.push(name);
        await send(parseMsg(name, statement, [23]), syncMsg());
    }
    const afterPrepare = (await countPrepared()) - baseline;
    await send(bindMsg('', '', ['7']), describeMsg('P', ''), executeMsg(''), syncMsg());
    const afterUnnamedExecute = (await countPrepared()) - baseline;
    for (const name of names) await send(closeMsg('S', name), syncMsg());
    const afterClose = (await countPrepared()) - baseline;
    return {
        sql: statement,
        types: [],
        boundParams: ['7'],
        preparedDelta: afterPrepare,
        afterUnnamedDelta: afterUnnamedExecute,
        closedDelta: afterClose,
    };
}

// -------------------------------------------------------------------------------
// Message-level expectations come from the same independent builder that the
// server accepted above, so they are not derived from the Rust encoder.
// -------------------------------------------------------------------------------
function hex(bytes) {
    return bytes.toString('hex');
}

const messages = {
    encode: [
        { name: 'parse-empty', kind: 'parse', name0: '', sql: 'SELECT 1', types: [] },
        { name: 'parse-typed', kind: 'parse', name0: '', sql: 'SELECT $1::int4, $2::text', types: [23, 25] },
        { name: 'parse-named-unicode', kind: 'parse', name0: 's1', sql: "SELECT 'héllo 世界'", types: [] },
        { name: 'bind-empty', kind: 'bind', portal: '', statement: '', params: [], resultFormat: 0 },
        { name: 'bind-null-and-text', kind: 'bind', portal: '', statement: '', params: [null, '42'], resultFormat: 0 },
        { name: 'bind-empty-and-unicode', kind: 'bind', portal: '', statement: '', params: ['', 'héllo 世界'], resultFormat: 0 },
        { name: 'bind-named-portal', kind: 'bind', portal: 'p1', statement: 's1', params: [null], resultFormat: 0 },
        { name: 'describe-statement', kind: 'describe', target: 'statement', name0: 's1' },
        { name: 'describe-portal', kind: 'describe', target: 'portal', name0: '' },
        { name: 'execute-all-rows', kind: 'execute', portal: '', maxRows: 0 },
        { name: 'sync', kind: 'sync' },
        { name: 'close-statement', kind: 'close', target: 'statement', name0: 's1' },
    ],
    decode: [
        { name: 'no-parameters', payloadHex: '0000', expect: [] },
        { name: 'two-parameters', payloadHex: '000200000017000006a4', expect: [23, 1700] },
        { name: 'truncated', payloadHex: '000200000017', expectError: 'invalid ParameterDescription length' },
        { name: 'empty', payloadHex: '', expectError: 'truncated ParameterDescription' },
    ],
    reject: [
        { name: 'binary-result-format', kind: 'bind', portal: '', statement: '', params: [], resultFormat: 1, expectError: 'unsupported: binary-result-format' },
        { name: 'row-limit', kind: 'execute', portal: '', maxRows: 5, expectError: 'unsupported: execute-row-limit' },
        { name: 'too-many-types', kind: 'parse', count: 65536, expectError: 'at most 65535 parameter types can be declared' },
        { name: 'too-many-params', kind: 'bind', count: 65536, expectError: 'at most 65535 parameters can be bound' },
        { name: 'bad-describe-target', kind: 'describe', target: 'x', name0: 's1', expectError: 'describe target must be S or P' },
        { name: 'negative-row-limit', kind: 'execute', portal: '', maxRows: -1, expectError: 'execute row limit cannot be negative' },
    ],
    types: [
        { name: 'bool', type: 'bool', oid: 16 },
        { name: 'bytea', type: 'bytea', oid: 17 },
        { name: 'int8', type: 'int8', oid: 20 },
        { name: 'int2', type: 'int2', oid: 21 },
        { name: 'int4', type: 'int4', oid: 23 },
        { name: 'text', type: 'text', oid: 25 },
        { name: 'float4', type: 'float4', oid: 700 },
        { name: 'float8', type: 'float8', oid: 701 },
        { name: 'numeric', type: 'numeric', oid: 1700 },
        { name: 'date', type: 'date', oid: 1082 },
        { name: 'timestamp', type: 'timestamp', oid: 1114 },
        { name: 'timestamptz', type: 'timestamptz', oid: 1184 },
        { name: 'unknown', type: 'nope', oid: null },
    ],
    bytea: [
        { name: 'mixed-bytes', bytes: [0x00, 0x41, 0xff], expect: '\\x0041ff' },
        { name: 'empty', bytes: [], expect: '\\x' },
    ],
};

// Verify the OID table against the catalog of this backend.
for (const item of messages.types) {
    if (item.oid === null) continue;
    const rows = await simple(`SELECT oid FROM pg_type WHERE typname = '${item.type}'`);
    const measured = Number(rows[0].rows[0][0]);
    if (measured !== item.oid) throw new Error(`catalog says ${item.type} is ${measured}, corpus says ${item.oid}`);
}

const corpus = {
    source: 'PGlite 0.5.15 (real PostgreSQL backend) through the protocol-v3 extended path',
    messages,
    binding: [],
    errors: [],
    prepare: [],
    lifecycle: [],
    leak: null,
};

for (const item of binding) corpus.binding.push(await measureBinding(item));
for (const item of errors) corpus.errors.push(await measureBinding(item));
for (const item of prepare) corpus.prepare.push(await measurePrepare(item));
for (const item of lifecycle) corpus.lifecycle.push(await measureLifecycle(item));
for (const item of corpus.messages.encode) item.expectHex = hex(buildMessage(item));
corpus.leak = await measureLeak();

fs.writeFileSync(outputFile, `${JSON.stringify(corpus, null, 4)}\n`);
console.log(`wrote ${path.relative(harnessDir, outputFile)}: ${corpus.binding.length} binding, ${corpus.errors.length} errors, ${corpus.prepare.length} prepare, ${corpus.lifecycle.length} lifecycle`);

socket.end();
await server.stop();
await db.close();
process.exit(0);
