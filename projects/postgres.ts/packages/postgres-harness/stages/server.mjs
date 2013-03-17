import net from 'node:net';
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
            const messages = await wire.query('CREATE TABLE batch_one (a int)');
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
                const failure = await client.query('CREATE TABLE batch_one (a int)').then(
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

        const psql = process.env.PSQL_BIN;
        if (psql) {
            const run = (sql, password = '') =>
                new Promise((resolve, reject) => {
                    const child = spawn(
                        psql,
                        ['-h', trust.host, '-p', String(trust.port), '-U', 'postgres', '-d', 'postgres', '-c', sql],
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
                const failure = await run('CREATE TABLE batch_one (a int)');
                assert(failure.status === 1, `psql exited ${failure.status}`);
                assert(failure.stderr.includes('ERROR:') && failure.stderr.includes('feature not supported'), `psql stderr ${failure.stderr}`);
                const recovery = await run('SELECT 1');
                assert(recovery.status === 0, 'a second psql connection reaches the same server');
                lines.push(`  psql stderr:\n${failure.stderr.trimEnd().replace(/^/gm, '    ')}`);
            });
        }

        return {
            name: 'server',
            output: lines.join('\n'),
            counts: { executed, skipped: 0, failed },
            floor: 14,
        };
    } finally {
        await trust.close();
        await password.close();
    }
}
