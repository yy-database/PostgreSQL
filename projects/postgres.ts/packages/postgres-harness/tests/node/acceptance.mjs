import fs from 'node:fs';
import path from 'node:path';

import { loadNative } from '@yydb/postgres';

const native = loadNative();

const corpusDir = process.env.POSTGRES_CASES_DIR;
const resultFile = process.env.POSTGRES_RESULT_FILE;
const storeRoot = process.env.POSTGRES_STORE_ROOT;
const config = {
    host: process.env.POSTGRES_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.POSTGRES_TEST_PORT ?? 5432),
    user: process.env.POSTGRES_TEST_USER ?? 'postgres',
    database: process.env.POSTGRES_TEST_DATABASE ?? 'postgres',
};

const counters = { executed: 0, skipped: 0, failed: 0 };
const failures = [];
const actual = {};

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function check(name, run) {
    counters.executed += 1;
    try {
        run();
    } catch (error) {
        counters.failed += 1;
        failures.push(`${name}: ${error.message}`);
    }
}

function expectEqual(name, value, expected) {
    check(name, () => {
        if (!same(value, expected)) throw new Error(`expected ${JSON.stringify(expected)} got ${JSON.stringify(value)}`);
    });
}

function expectError(name, run, expectedMessage) {
    check(name, () => {
        try {
            run();
        } catch (error) {
            if (expectedMessage !== undefined && error.message !== expectedMessage) {
                throw new Error(`expected error '${expectedMessage}' got '${error.message}'`);
            }
            return;
        }
        throw new Error('expected an error, none was raised');
    });
}

function loadCase(file) {
    return JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
}

function text(value) {
    return value === null ? null : value;
}

// -------------------------------------------------------------------------------
// SQL statement surface, executed against the live PostgreSQL core of the harness.
// --------------------------------------------------------------------------
const sqlCases = loadCase('sql.json');
const connection = native.connect(config);

for (const item of sqlCases) {
    const key = `sql/${item.name}`;
    try {
        for (const statement of item.setup ?? []) connection.execute(statement);
        const results = connection.execute(item.sql);
        const normalized = results.map((result) => ({
            columns: result.columns.map((column) => column.name),
            rows: result.rows.map((row) => row.values.map(text)),
            tag: result.tag,
        }));
        actual[key] = normalized;
        expectEqual(`${key}/result-count`, normalized.length, item.expect.length);
        item.expect.forEach((expected, index) => {
            const result = normalized[index];
            expectEqual(`${key}/${index}/columns`, result?.columns, expected.columns);
            expectEqual(`${key}/${index}/rows`, result?.rows, expected.rows);
            expectEqual(`${key}/${index}/tag`, result?.tag, expected.tag);
        });
        for (const statement of item.teardown ?? []) connection.execute(statement);
    } catch (error) {
        actual[key] = { error: error.message };
        check(`${key}/run`, () => {
            throw new Error(error.message);
        });
    }
}

const sqlExecuted = counters.executed;

// -------------------------------------------------------------------------------
// Server errors and recovery on a still-open connection.
// --------------------------------------------------------------------------
for (const item of loadCase('errors.json')) {
    const key = `errors/${item.name}`;
    try {
        for (const statement of item.setup ?? []) connection.execute(statement);
        try {
            connection.execute(item.sql);
            throw new Error('expected an error, none was raised');
        } catch (error) {
            if (error.message === 'expected an error, none was raised') throw error;
            actual[key] = { code: error.message.slice(0, 5), message: error.message };
            check(`${key}/code`, () => {
                if (error.message.slice(0, 5) !== item.code) {
                    throw new Error(`expected ${item.code} got ${error.message.slice(0, 5)}`);
                }
            });
            check(`${key}/message`, () => {
                if (!error.message.includes(item.messageContains)) {
                    throw new Error(`expected '${item.messageContains}' in '${error.message}'`);
                }
            });
            if (item.recovery) {
                const results = connection.execute('SELECT 1 AS n');
                expectEqual(`${key}/recovery`, results[0]?.rows[0]?.values, ['1']);
            }
        }
        for (const statement of item.teardown ?? []) connection.execute(statement);
    } catch (error) {
        actual[key] = { error: error.message };
        check(`${key}/run`, () => {
            throw new Error(error.message);
        });
    }
}
const errorsExecuted = counters.executed;
connection.close();

// -------------------------------------------------------------------------------
// Parameter binding, extended-protocol frames and prepared statement lifecycle.
// --------------------------------------------------------------------------
const params = loadCase('params.json');
const paramsConnection = native.connect(config);

function typeOids(names) {
    return names.map((name) => {
        const oid = native.parameterTypeOid(name);
        if (oid === null) throw new Error(`unknown parameter type ${name}`);
        return oid;
    });
}

function normalizeResults(results) {
    return results.map((result) => ({
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => row.values.map(text)),
        tag: result.tag,
    }));
}

function splitError(message) {
    const separator = message.indexOf(': ');
    return separator > 0 ? message.slice(0, separator) : 'client';
}

function countPrepared() {
    const results = paramsConnection.execute('SELECT count(*) AS n FROM pg_prepared_statements');
    return Number(results[0].rows[0].values[0]);
}

function encodeMessage(item) {
    switch (item.kind) {
        case 'parse':
            return native.encodeParseMessage(item.name0, item.sql, item.types);
        case 'bind':
            return native.encodeBindMessage(item.portal, item.statement, item.params, item.resultFormat);
        case 'describe':
            return native.encodeDescribeMessage(item.target, item.name0);
        case 'execute':
            return native.encodeExecuteMessage(item.portal, item.maxRows);
        case 'sync':
            return native.encodeSyncMessage();
        case 'close':
            return native.encodeCloseMessage(item.target, item.name0);
        default:
            throw new Error(`unknown message kind ${item.kind}`);
    }
}

function rejectMessage(item) {
    if (item.count !== undefined) {
        if (item.kind === 'parse') return native.encodeParseMessage('', 'SELECT 1', Array(item.count).fill(23));
        return native.encodeBindMessage('', '', Array(item.count).fill(null), 0);
    }
    return encodeMessage(item);
}

for (const item of params.messages.encode) {
    const key = `params/message/${item.name}`;
    const packet = encodeMessage(item);
    actual[key] = { hex: packet.toString('hex'), length: packet.length };
    expectEqual(`${key}/bytes`, packet.toString('hex'), item.expectHex);
    expectEqual(`${key}/length`, packet.length, item.expectHex.length / 2);
    expectEqual(`${key}/length-field`, packet.readUInt32BE(1), packet.length - 1);
}

for (const item of params.messages.decode) {
    const key = `params/parameter-description/${item.name}`;
    const payload = Buffer.from(item.payloadHex, 'hex');
    try {
        const oids = native.decodeParameterDescription(payload);
        actual[key] = { oids };
        expectEqual(`${key}/oids`, oids, item.expect);
    } catch (error) {
        actual[key] = { error: error.message };
        expectEqual(`${key}/error`, error.message, item.expectError);
    }
}

for (const item of params.messages.reject) {
    const key = `params/reject/${item.name}`;
    let raised = null;
    try {
        rejectMessage(item);
    } catch (error) {
        raised = error.message;
    }
    actual[key] = { error: raised };
    expectEqual(`${key}/error`, raised, item.expectError);
}

for (const item of params.messages.types) {
    const key = `params/type-oid/${item.name}`;
    const oid = native.parameterTypeOid(item.type);
    actual[key] = oid;
    expectEqual(`${key}/oid`, oid, item.oid);
}

for (const item of params.messages.bytea) {
    const key = `params/bytea/${item.name}`;
    const encoded = native.encodeBytea(Buffer.from(item.bytes));
    actual[key] = encoded;
    expectEqual(`${key}/text`, encoded, item.expect);
}

for (const item of params.binding) {
    const key = `params/binding/${item.name}`;
    try {
        for (const statement of item.setup ?? []) paramsConnection.execute(statement);
        const results = normalizeResults(paramsConnection.executeWithParams(item.sql, item.params, typeOids(item.types)));
        actual[key] = results;
        expectEqual(`${key}/result-count`, results.length, item.expect.length);
        item.expect.forEach((expected, index) => {
            expectEqual(`${key}/${index}/columns`, results[index]?.columns, expected.columns);
            expectEqual(`${key}/${index}/rows`, results[index]?.rows, expected.rows);
            expectEqual(`${key}/${index}/tag`, results[index]?.tag, expected.tag);
        });
        for (const statement of item.teardown ?? []) paramsConnection.execute(statement);
    } catch (error) {
        actual[key] = { error: error.message };
        check(`${key}/run`, () => {
            throw new Error(error.message);
        });
    }
}

for (const item of params.errors) {
    const key = `params/error/${item.name}`;
    let raised = null;
    try {
        paramsConnection.executeWithParams(item.sql, item.params, typeOids(item.types));
    } catch (error) {
        raised = error;
    }
    if (!raised) {
        actual[key] = { error: 'expected an error, none was raised' };
        check(`${key}/run`, () => {
            throw new Error('expected an error, none was raised');
        });
    } else {
        actual[key] = { code: splitError(raised.message) };
        expectEqual(`${key}/code`, splitError(raised.message), item.error.code);
        check(`${key}/message`, () => {
            if (!raised.message.includes(item.error.messageContains)) {
                throw new Error(`expected '${item.error.messageContains}' in '${raised.message}'`);
            }
        });
        check(`${key}/recovery`, () => {
            const rows = normalizeResults(paramsConnection.execute('SELECT 1 AS n'))[0].rows;
            if (!same(rows, [['1']])) throw new Error(`recovery returned ${JSON.stringify(rows)}`);
        });
    }
}

for (const item of params.prepare) {
    const key = `params/prepare/${item.name}`;
    for (const statement of item.setup ?? []) paramsConnection.execute(statement);
    try {
        const prepared = paramsConnection.prepare(item.sql, typeOids(item.types));
        const metadata = { parameters: prepared.parameters(), columns: prepared.columns().map((column) => column.name) };
        actual[key] = metadata;
        expectEqual(`${key}/parameters`, metadata.parameters, item.expectParameters);
        expectEqual(`${key}/columns`, metadata.columns, item.expectColumns);
        prepared.close();
        expectEqual(`${key}/closed`, prepared.isClosed(), true);
    } catch (error) {
        actual[key] = { code: splitError(error.message) };
        if (!item.expectError) {
            check(`${key}/run`, () => {
                throw new Error(error.message);
            });
        } else {
            expectEqual(`${key}/code`, splitError(error.message), item.expectError.code);
            check(`${key}/message`, () => {
                if (!error.message.includes(item.expectError.messageContains)) {
                    throw new Error(`expected '${item.expectError.messageContains}' in '${error.message}'`);
                }
            });
        }
    }
    for (const statement of item.teardown ?? []) paramsConnection.execute(statement);
}

function expectResults(key, results, expected) {
    expectEqual(`${key}/result-count`, results.length, expected.length);
    expected.forEach((entry, index) => {
        expectEqual(`${key}/${index}/columns`, results[index]?.columns, entry.columns);
        expectEqual(`${key}/${index}/rows`, results[index]?.rows, entry.rows);
        expectEqual(`${key}/${index}/tag`, results[index]?.tag, entry.tag);
    });
}

for (const item of params.lifecycle) {
    for (const statement of item.setup ?? []) paramsConnection.execute(statement);
    const statements = [];
    item.ops.forEach((op, index) => {
        const key = `params/lifecycle/${item.name}/${index}-${op.op}`;
        try {
            switch (op.op) {
                case 'prepare': {
                    const prepared = paramsConnection.prepare(op.sql, typeOids(op.types));
                    statements.push(prepared);
                    const metadata = { parameters: prepared.parameters(), columns: prepared.columns().map((column) => column.name) };
                    actual[key] = metadata;
                    expectEqual(`${key}/parameters`, metadata.parameters, op.expectParameters);
                    expectEqual(`${key}/columns`, metadata.columns, op.expectColumns);
                    break;
                }
                case 'execute': {
                    const results = normalizeResults(statements[op.stmt].execute(op.params));
                    actual[key] = results;
                    expectResults(key, results, op.expect);
                    break;
                }
                case 'close': {
                    statements[op.stmt].close();
                    actual[key] = { closed: statements[op.stmt].isClosed() };
                    expectEqual(`${key}/closed`, statements[op.stmt].isClosed(), true);
                    break;
                }
                case 'executeError': {
                    let raised = null;
                    try {
                        statements[op.stmt].execute(op.params);
                    } catch (error) {
                        raised = error.message;
                    }
                    actual[key] = { error: raised };
                    expectEqual(`${key}/error`, raised, op.message);
                    break;
                }
                case 'executePreparedError': {
                    let raised = null;
                    try {
                        paramsConnection.executePrepared(statements[op.stmt].name(), op.params);
                    } catch (error) {
                        raised = error;
                    }
                    actual[key] = { code: raised === null ? null : splitError(raised.message) };
                    expectEqual(`${key}/code`, raised === null ? null : splitError(raised.message), op.code);
                    check(`${key}/message`, () => {
                        if (raised === null || !raised.message.includes(op.messageContains)) {
                            throw new Error(`expected '${op.messageContains}' in '${raised?.message}'`);
                        }
                    });
                    break;
                }
                case 'closeNamed': {
                    paramsConnection.closePrepared(op.name);
                    actual[key] = { closed: true };
                    break;
                }
                case 'query': {
                    const results = normalizeResults(paramsConnection.execute(op.sql));
                    actual[key] = results;
                    expectResults(key, results, op.expect);
                    break;
                }
                default:
                    throw new Error(`unknown lifecycle op ${op.op}`);
            }
        } catch (error) {
            actual[key] = { error: error.message };
            check(`${key}/run`, () => {
                throw new Error(error.message);
            });
        }
    });
    for (const statement of item.teardown ?? []) paramsConnection.execute(statement);
}

// A statement outliving its connection fails locally instead of writing to a
// closed socket.
{
    const key = 'params/lifecycle/connection-close';
    const temporary = native.connect(config);
    const prepared = temporary.prepare('SELECT $1::int4 AS v', [23]);
    temporary.close();
    let executeError = null;
    try {
        prepared.execute(['1']);
    } catch (error) {
        executeError = error.message;
    }
    let prepareError = null;
    try {
        temporary.prepare('SELECT 1', []);
    } catch (error) {
        prepareError = error.message;
    }
    prepared.close();
    actual[key] = { executeError, prepareError, statementClosed: prepared.isClosed() };
    expectEqual(`${key}/execute`, executeError, 'connection is closed');
    expectEqual(`${key}/prepare`, prepareError, 'connection is closed');
    expectEqual(`${key}/closed`, prepared.isClosed(), true);
}

// Unnamed one-shot statements never stay in `pg_prepared_statements`; named
// ones do until they are closed.
{
    const key = 'params/leak';
    const baseline = countPrepared();
    const statements = [0, 1, 2].map(() => paramsConnection.prepare(params.leak.sql, typeOids(params.leak.types)));
    const preparedDelta = countPrepared() - baseline;
    statements[0].execute(params.leak.boundParams);
    const afterUnnamedDelta = countPrepared() - baseline;
    for (const statement of statements) statement.close();
    const closedDelta = countPrepared() - baseline;
    actual[key] = { preparedDelta, afterUnnamedDelta, closedDelta };
    expectEqual(`${key}/prepared`, preparedDelta, params.leak.preparedDelta);
    expectEqual(`${key}/unnamed`, afterUnnamedDelta, params.leak.afterUnnamedDelta);
    expectEqual(`${key}/closed`, closedDelta, params.leak.closedDelta);
}

paramsConnection.close();
const paramsExecuted = counters.executed;

// -------------------------------------------------------------------------------
// Command line parsing and rendering.
// --------------------------------------------------------------------------
const psql = loadCase('psql.json');
for (const item of psql.parse) {
    const key = `psql/${item.name}`;
    const options = native.parsePsqlArguments(item.args);
    actual[key] = options;
    for (const field of Object.keys(psql.defaults)) {
        expectEqual(`${key}/${field}`, options[field], item.expect[field]);
    }
}
for (const item of psql.parseErrors) {
    const key = `psql-error/${item.name}`;
    expectError(key, () => native.parsePsqlArguments(item.args), item.message);
    actual[key] = item.message;
}
for (const item of psql.format) {
    const key = `format/${item.name}`;
    const options = { ...psql.defaults, ...item.options };
    const lines = native.formatPsqlResults(item.results, options);
    actual[key] = lines;
    expectEqual(`${key}/lines`, lines, item.expect);
    expectEqual(`${key}/line-count`, lines.length, item.expect.length);
}

const cliExecuted = counters.executed;

// -------------------------------------------------------------------------------
// Protocol framing and decoding.
// --------------------------------------------------------------------------
const protocol = loadCase('protocol.json');
expectEqual('protocol/version', native.protocolVersion(), protocol.version);
expectEqual('protocol/max-message-bytes', native.maxMessageBytes(), protocol.maxMessageBytes);

for (const item of protocol.encodeStartup) {
    const key = `protocol/startup/${item.name}`;
    const packet = native.encodeStartupPacket(item.user, item.database);
    actual[key] = packet.toString('hex');
    expectEqual(`${key}/bytes`, packet.toString('hex'), item.expectHex);
    expectEqual(`${key}/length`, packet.length, item.expectHex.length / 2);
    expectEqual(`${key}/version`, packet.readUInt32BE(4), protocol.version);
    expectEqual(`${key}/terminator`, packet[packet.length - 1], 0);
}

for (const item of protocol.encodeQuery) {
    const key = `protocol/query/${item.name}`;
    const packet = native.encodeQueryPacket(item.sql);
    actual[key] = packet.toString('hex');
    if (item.structural) {
        expectEqual(`${key}/tag`, packet[0], 0x51);
        expectEqual(`${key}/length`, packet.readUInt32BE(1), packet.length - 1);
        expectEqual(`${key}/terminator`, packet[packet.length - 1], 0);
        expectEqual(`${key}/sql`, packet.subarray(5, packet.length - 1), Buffer.from(item.sql, 'utf8'));
    } else {
        expectEqual(`${key}/bytes`, packet.toString('hex'), item.expectHex);
        expectEqual(`${key}/length`, packet.length, item.expectHex.length / 2);
        expectEqual(`${key}/tag`, packet[0], 0x51);
    }
}

for (const item of protocol.decodeError) {
    const key = `protocol/error/${item.name}`;
    if (item.expectError) {
        expectError(key, () => native.decodeErrorResponse(Buffer.from(item.payloadHex, 'hex')), item.expectError);
        actual[key] = item.expectError;
    } else {
        const decoded = native.decodeErrorResponse(Buffer.from(item.payloadHex, 'hex'));
        actual[key] = decoded;
        expectEqual(`${key}/code`, decoded.code, item.expect.code);
        expectEqual(`${key}/message`, decoded.message, item.expect.message);
    }
}

for (const item of protocol.decodeRowDescription) {
    const key = `protocol/row/${item.name}`;
    if (item.expectError) {
        expectError(key, () => native.decodeRowDescription(Buffer.from(item.payloadHex, 'hex')), item.expectError);
        actual[key] = item.expectError;
    } else {
        const names = native.decodeRowDescription(Buffer.from(item.payloadHex, 'hex'));
        actual[key] = names;
        expectEqual(`${key}/names`, names, item.expect);
    }
}

for (const item of protocol.decodeDataRow) {
    const key = `protocol/data/${item.name}`;
    if (item.expectError) {
        expectError(key, () => native.decodeDataRow(Buffer.from(item.payloadHex, 'hex'), item.columns), item.expectError);
        actual[key] = item.expectError;
    } else {
        const values = native.decodeDataRow(Buffer.from(item.payloadHex, 'hex'), item.columns);
        actual[key] = values;
        expectEqual(`${key}/values`, values, item.expect);
    }
}

for (const item of protocol.decodeCommandTag) {
    const key = `protocol/tag/${item.name}`;
    if (item.expectError) {
        expectError(key, () => native.decodeCommandTag(Buffer.from(item.payloadHex, 'hex')), item.expectError);
        actual[key] = item.expectError;
    } else {
        const tag = native.decodeCommandTag(Buffer.from(item.payloadHex, 'hex'));
        actual[key] = tag;
        expectEqual(`${key}/tag`, tag, item.expect);
    }
}

const protocolExecuted = counters.executed;

// -------------------------------------------------------------------------------
// `.yyds`/`.yykv` persistence. The shard is parsed below from the documented
// byte layout with an independent FNV-1a implementation.
// --------------------------------------------------------------------------
const storeCases = loadCase('store.json');

function fnv1a(bytes) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash;
}

function parseShard(file) {
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 5).toString() !== 'YYKV\u0003') throw new Error('bad shard magic');
    const checksum = bytes.readBigUInt64LE(5);
    const body = bytes.subarray(13);
    if (fnv1a(body) !== checksum) throw new Error('bad shard checksum');
    let offset = 0;
    const nextRevision = Number(body.readBigUInt64LE(offset));
    offset += 8;
    const count = body.readUInt32LE(offset);
    offset += 4;
    const records = [];
    for (let index = 0; index < count; index += 1) {
        const namespaceLength = body.readUInt32LE(offset);
        offset += 4;
        const namespace = body.subarray(offset, offset + namespaceLength).toString();
        offset += namespaceLength;
        const keyLength = body.readUInt32LE(offset);
        offset += 4;
        const key = body.subarray(offset, offset + keyLength).toString();
        offset += keyLength;
        const revision = Number(body.readBigUInt64LE(offset));
        offset += 8;
        const deadline = Number(body.readBigUInt64LE(offset));
        offset += 8;
        const tag = body[offset];
        offset += 1;
        const valueLength = body.readUInt32LE(offset);
        offset += 4;
        const value = body.subarray(offset, offset + valueLength).toString();
        offset += valueLength;
        records.push({ namespace, key, value, revision, deadline, tag });
    }
    if (offset !== body.length) throw new Error('trailing shard bytes');
    return { nextRevision, records };
}

function readText(value) {
    return Buffer.from(value).toString();
}

for (const item of storeCases.cases) {
    const dir = path.join(storeRoot, item.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    let store = null;
    const record = {};
    actual[`store/${item.name}`] = record;
    for (const op of item.ops) {
        try {
            switch (op.op) {
                case 'open':
                case 'reopen':
                    store = new native.Store(dir);
                    break;
                case 'put': {
                    const key = Buffer.from(op.key, 'utf8');
                    const value = Buffer.from(op.value, 'utf8');
                    if (op.expectError) {
                        expectError(`store/${item.name}/put`, () => store.put(op.namespace, key, value), op.expectError);
                    } else {
                        store.put(op.namespace, key, value);
                    }
                    break;
                }
                case 'get': {
                    const value = store.get(op.namespace, Buffer.from(op.key, 'utf8'));
                    const text = value === null ? null : readText(value);
                    record[`get:${op.namespace}:${op.key}`] = text;
                    expectEqual(`store/${item.name}/get/${op.key}`, text, op.expect);
                    break;
                }
                case 'delete': {
                    const deleted = store.delete(op.namespace, Buffer.from(op.key, 'utf8'));
                    expectEqual(`store/${item.name}/delete`, deleted, op.expectDeleted);
                    break;
                }
                case 'keys': {
                    const keys = store.keys(op.namespace, Buffer.from(op.prefix ?? '', 'utf8')).map(readText);
                    expectEqual(`store/${item.name}/keys/${op.prefix ?? ''}`, keys, op.expectKeys);
                    break;
                }
                case 'scan': {
                    const pairs = store
                        .scan(op.namespace, Buffer.from(op.prefix ?? '', 'utf8'))
                        .map((row) => [readText(row.key), readText(row.value)]);
                    expectEqual(`store/${item.name}/scan/${op.prefix ?? ''}`, pairs, op.expectPairs);
                    break;
                }
                case 'namespaces': {
                    const namespaces = store.namespaces();
                    expectEqual(`store/${item.name}/namespaces`, namespaces, op.expectNamespaces);
                    break;
                }
                case 'len': {
                    const length = store.len(op.namespace);
                    expectEqual(`store/${item.name}/len`, length, op.expectLen);
                    break;
                }
                case 'flush': {
                    const removed = store.flush(op.namespace);
                    expectEqual(`store/${item.name}/flush`, removed, op.expectRemoved);
                    break;
                }
                case 'expectFiles': {
                    expectEqual(`store/${item.name}/catalog-exists`, fs.existsSync(store.catalogPath()), true);
                    expectEqual(`store/${item.name}/shard-exists`, fs.existsSync(store.shardPath()), true);
                    break;
                }
                case 'verifyShard': {
                    const parsed = parseShard(store.shardPath());
                    record.verifyShard = parsed;
                    expectEqual(
                        `store/${item.name}/shard/records`,
                        { nextRevision: parsed.nextRevision, records: parsed.records.map(({ namespace, key, value, revision }) => ({ namespace, key, value, revision })) },
                        { nextRevision: op.nextRevision, records: op.records },
                    );
                    break;
                }
                case 'writeShard':
                case 'writeCatalog': {
                    const target = op.op === 'writeShard' ? store.shardPath() : store.catalogPath();
                    fs.writeFileSync(target, Buffer.from(op.hex, 'hex'));
                    break;
                }
                case 'removeShard':
                    fs.rmSync(store.shardPath());
                    break;
                case 'removeCatalog':
                    fs.rmSync(store.catalogPath());
                    break;
                case 'openExpectError': {
                    expectError(`store/${item.name}/open`, () => new native.Store(dir), op.expectError);
                    record.openError = op.expectError;
                    break;
                }
                default:
                    throw new Error(`unknown store op ${op.op}`);
            }
        } catch (error) {
            counters.failed += 1;
            counters.executed += 1;
            failures.push(`store/${item.name}/${op.op}: ${error.message}`);
        }
    }
}

// Store scale ladder: 1000 rows, reopen, scan.
{
    const dir = path.join(storeRoot, 'scale');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    let store = new native.Store(dir);
    for (let index = 0; index < 1000; index += 1) {
        store.put('public.scale', Buffer.from(`k${index}`), Buffer.from(`v${index}`));
    }
    const inserted = store.len('public.scale');
    expectEqual('store-stress/inserted', inserted, 1000);
    const pairs = store.scan('public.scale', Buffer.from('k1'));
    expectEqual('store-stress/prefix-count', pairs.length, 111);
    expectEqual('store-stress/last-key', readText(pairs[pairs.length - 1].key), 'k199');
    store = new native.Store(dir);
    expectEqual('store-stress/reopen-len', store.len('public.scale'), 1000);
    const elapsed = Date.now() - started;
    console.log(`METRIC store-scale rows=1000 bytes=${fs.statSync(store.shardPath()).size} ms=${elapsed}`);
    check('store-stress/budget', () => {
        if (elapsed > 15_000) throw new Error(`1000 rows took ${elapsed}ms`);
    });
    actual['store-stress'] = { inserted, prefixCount: pairs.length, reopened: 1000 };
}

const storeExecuted = counters.executed;

// -------------------------------------------------------------------------------
// Stress ladder through the client.
// --------------------------------------------------------------------------
const stressConnection = native.connect(config);
for (const item of loadCase('stress.json')) {
    const key = `stress/${item.name}`;
    const started = Date.now();
    try {
        for (const statement of item.setup ?? []) stressConnection.execute(statement);
        const results = stressConnection.execute(item.sql);
        const elapsed = Date.now() - started;
        const normalized = results.map((result) => ({
            columns: result.columns.map((column) => column.name),
            rows: result.rows.map((row) => row.values.map(text)),
            tag: result.tag,
        }));
        actual[key] = {
            resultCount: normalized.length,
            rowCounts: normalized.map((result) => result.rows.length),
            values: normalized.map((result) => result.rows[0] ?? []),
        };
        const final = normalized[normalized.length - 1];
        if (item.expectResults !== undefined) expectEqual(`${key}/result-count`, normalized.length, item.expectResults);
        if (item.expectRows !== undefined) expectEqual(`${key}/row-count`, final?.rows.length, item.expectRows);
        if (item.columns !== undefined) expectEqual(`${key}/columns`, final?.columns, item.columns);
        if (item.first !== undefined) expectEqual(`${key}/first`, final?.rows[0], [item.first]);
        if (item.last !== undefined) expectEqual(`${key}/last`, final?.rows[final.rows.length - 1], [item.last]);
        if (item.valueLength !== undefined) expectEqual(`${key}/value-length`, final?.rows[0]?.[0]?.length, item.valueLength);
        if (item.expectedValues !== undefined) {
            expectEqual(`${key}/values`, normalized.map((result) => result.rows[0] ?? []), item.expectedValues.map((value) => [value]));
        }
        check(`${key}/budget`, () => {
            if (elapsed > item.budgetMs) throw new Error(`took ${elapsed}ms over ${item.budgetMs}ms`);
        });
        console.log(`METRIC ${item.name} rows=${normalized.reduce((total, result) => total + result.rows.length, 0)} ms=${elapsed}`);
        for (const statement of item.teardown ?? []) stressConnection.execute(statement);
    } catch (error) {
        actual[key] = { error: error.message };
        check(`${key}/run`, () => {
            throw new Error(error.message);
        });
    }
}
stressConnection.close();

// -------------------------------------------------------------------------------
// Result.
// -------------------------------------------------------------------------
const summary = {
    ...counters,
    sections: {
        sql: sqlExecuted,
        errors: errorsExecuted - sqlExecuted,
        params: paramsExecuted - errorsExecuted,
        cli: cliExecuted - paramsExecuted,
        protocol: protocolExecuted - cliExecuted,
        store: storeExecuted - protocolExecuted,
        stress: counters.executed - storeExecuted,
    },
    cases: actual,
    failures,
};
fs.writeFileSync(resultFile, JSON.stringify(summary));
console.log(`RESULT executed=${counters.executed} skipped=${counters.skipped} failed=${counters.failed}`);
if (failures.length > 0) {
    console.log(failures.slice(0, 40).join('\n'));
}
process.exitCode = counters.failed === 0 ? 0 : 1;
