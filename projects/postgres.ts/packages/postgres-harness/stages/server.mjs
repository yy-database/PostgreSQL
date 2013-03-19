import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import pg from 'pg';

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
    const result = { severity: '', code: '', message: '', detail: '' };
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
            requireTags(set, 'CZ');
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

        return {
            name: 'server',
            output: lines.join('\n'),
            counts: { executed, skipped: 0, failed },
            floor: 38,
        };
    } finally {
        await trust.close();
        await password.close();
        await batch2.close();
        await batch3.close();
    }
}
