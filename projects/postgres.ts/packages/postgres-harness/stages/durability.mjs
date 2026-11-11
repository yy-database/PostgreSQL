import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';

import pg from 'pg';

import { startPostgresServer } from '../../postgres/dist/server/server.js';

const SERVER_BIN = '../postgres/bin/postgres-server.mjs';

const requireNative = createRequire(import.meta.url);

/** The platform binding, so a case can seed and probe raw `.yykv` stores. */
function nativeBinding(repositoryRoot) {
    const key = process.env.POSTGRES_NATIVE_PLATFORM?.trim() ?? `${process.platform}-${process.arch}`;
    return requireNative(path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${key}`));
}

/** Rows of one flat `scanFlat` payload: `u32le` count, then per row lengths and bytes. */
function readShardRows(payload) {
    const count = payload.readUInt32LE(0);
    const rows = [];
    let offset = 4;
    for (let index = 0; index < count; index += 1) {
        const keyLength = payload.readUInt32LE(offset);
        const valueLength = payload.readUInt32LE(offset + 4);
        offset += 8;
        rows.push({ key: payload.subarray(offset, offset + keyLength), value: payload.subarray(offset + keyLength, offset + keyLength + valueLength) });
        offset += keyLength + valueLength;
    }
    return rows;
}

/**
 * Rewrites one sharded data directory into the pre-sharding layout: every
 * namespace of the `postgres` database inside the primary `local-0.yykv`, no
 * `shards/` directories. This is exactly what an old release left behind.
 */
function seedLegacyDirectory(binding, sourceDir, targetDir) {
    const source = new binding.ServerStore(sourceDir);
    const catalogRow = readShardRows(source.scanFlat('db:postgres:pg_catalog', Buffer.alloc(0), null, null, 1)).find((row) => row.key.toString() === 'catalog');
    const catalog = JSON.parse(catalogRow.value.toString('utf8'));
    const changes = [];
    for (const namespace of ['pg_cluster', 'db:postgres:pg_catalog', 'db:postgres:pg_sequence_state']) {
        for (const row of readShardRows(source.scanFlat(namespace, Buffer.alloc(0), null, null, 0))) {
            changes.push({ kind: 'put', namespace, key: Buffer.from(row.key), value: Buffer.from(row.value) });
        }
    }
    const hex = Buffer.from('postgres', 'utf8').toString('hex');
    for (const relation of catalog.relations.filter((candidate) => candidate.relkind === 'r')) {
        const shardId = `local-${relation.oid}-${hex}`;
        const tails = [
            `pg_data.${relation.oid}`,
            ...catalog.indexes.filter((index) => index.relid === relation.oid).map((index) => `pg_index.${index.oid}`),
        ];
        for (const tail of tails) {
            const namespace = `db:postgres:${tail}`;
            for (const row of readShardRows(source.scanShardFlat(shardId, namespace, Buffer.alloc(0), null, null, 0))) {
                changes.push({ kind: 'put', namespace, key: Buffer.from(row.key), value: Buffer.from(row.value) });
            }
        }
    }
    source.close();
    const legacy = new binding.ServerStore(targetDir);
    if (changes.length > 0) legacy.commitChanges(changes);
    legacy.close();
    return catalog;
}

function temporaryDirectory(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDirectory(directory) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** SHA-256 of every regular file in the data directory, keyed by relative path. */
function snapshot(directory, base = directory) {
    const result = {};
    for (const entry of fs.readdirSync(directory).sort()) {
        const absolute = path.join(directory, entry);
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) Object.assign(result, snapshot(absolute, base));
        else if (stat.isFile()) result[path.relative(base, absolute)] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
    return result;
}

function psqlBinary() {
    if (process.env.PSQL_BIN) return process.env.PSQL_BIN;
    const windows = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
    return fs.existsSync(windows) ? windows : 'psql';
}

/** Runs a real psql session over stdin and returns its transcript. */
function psqlSession(binary, port, script) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(script);
    });
}

/** Waits for the child server's `listening on host:port` line. */
function listening(child) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}${stderr}`)), 10_000);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            const match = /listening on (\S+):(\d+)/.exec(stdout);
            if (match === null) return;
            clearTimeout(timer);
            resolve({ host: match[1], port: Number(match[2]) });
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited early with ${code}: ${stdout}${stderr}`));
        });
    });
}

async function connect(port, database = 'postgres') {
    const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database });
    await client.connect();
    return client;
}

/** Drops a client without a Terminate message, like a killed application. */
function abandon(client) {
    client.on('error', () => {});
    client.connection.stream.destroy();
}

/** Makes the next commit fail and returns the undo step. */
function denyCommit(directory) {
    // A plain DML commit lands in the table-group shard of the written table,
    // not in the primary shard, so every shard file the commit could touch is
    // denied: the primary one and one per existing group directory.
    const shardFiles = [path.join(directory, 'local-0.yykv')];
    const shardRoot = path.join(directory, 'shards');
    if (fs.existsSync(shardRoot)) {
        for (const entry of fs.readdirSync(shardRoot)) {
            const shardFile = path.join(shardRoot, entry, 'local-0.yykv');
            if (fs.existsSync(shardFile)) shardFiles.push(shardFile);
        }
    }
    if (process.platform === 'win32') {
        for (const shard of shardFiles) execFileSync('attrib', ['+R', shard]);
        return () => {
            for (const shard of shardFiles) execFileSync('attrib', ['-R', shard]);
        };
    }
    const directories = [directory, ...shardFiles.slice(1).map((shard) => path.dirname(shard))];
    const modes = new Map(directories.map((target) => [target, fs.statSync(target).mode & 0o777]));
    for (const [target, mode] of modes) fs.chmodSync(target, mode & ~0o222);
    return () => {
        for (const [target, mode] of modes) fs.chmodSync(target, mode);
    };
}

export async function runDurabilityStage(repositoryRoot, harnessDir) {
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
    const directories = [];
    const servers = [];
    const temporary = (prefix) => {
        const directory = temporaryDirectory(prefix);
        directories.push(directory);
        return directory;
    };
    const start = async (options) => {
        const server = await startPostgresServer(options);
        servers.push(server);
        return server;
    };
    const stop = async (server) => {
        servers.splice(servers.indexOf(server), 1);
        await server.close();
    };

    try {
        await check('artifacts/restart-identical', async () => {
            const directory = temporary('postgres-durable-restart-');
            const created = await start({ dataDir: directory });
            const client = await connect(created.port);
            await client.query(
                'CREATE TABLE audit (id serial PRIMARY KEY, name varchar(32) NOT NULL, note text, active boolean DEFAULT true)',
            );
            await client.query('CREATE UNIQUE INDEX audit_name ON audit (name)');
            await client.query("INSERT INTO audit (name, note) VALUES ('one', 'first'), ('two', null), ('three', 'third')");
            const rows = await client.query('SELECT id, name, note FROM audit ORDER BY id');
            assert(JSON.stringify(rows.rows) === JSON.stringify([{ id: 1, name: 'one', note: 'first' }, { id: 2, name: 'two', note: null }, { id: 3, name: 'three', note: 'third' }]), `rows are ${JSON.stringify(rows.rows)}`);
            await client.end();
            await stop(created);

            const before = snapshot(directory);
            assert(Object.keys(before).includes('local-0.yyds'), `catalog is missing from ${JSON.stringify(before)}`);
            assert(Object.keys(before).includes('local-0.yykv'), `shard is missing from ${JSON.stringify(before)}`);
            assert(Object.keys(before).includes('sql-schema.v0.json'), `schema projection is missing from ${JSON.stringify(before)}`);

            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            const again = await reader.query('SELECT id, name, note FROM audit ORDER BY id');
            assert(JSON.stringify(again.rows) === JSON.stringify([{ id: 1, name: 'one', note: 'first' }, { id: 2, name: 'two', note: null }, { id: 3, name: 'three', note: 'third' }]), `rows after restart are ${JSON.stringify(again.rows)}`);
            await reader.end();
            await stop(reopened);

            const after = snapshot(directory);
            assert(JSON.stringify(before) === JSON.stringify(after), `artifacts changed across restart: ${JSON.stringify({ before, after })}`);
        });

        await check('artifacts/schema-projection', async () => {
            const directory = temporary('postgres-durable-projection-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE projected (id serial PRIMARY KEY, label varchar(10) NOT NULL, payload text)');
            await client.query('CREATE INDEX projected_label ON projected (label)');
            await client.query("INSERT INTO projected (label) VALUES ('a'), ('b')");
            await client.end();
            await stop(server);

            const document = JSON.parse(fs.readFileSync(path.join(directory, 'sql-schema.v0.json'), 'utf8'));
            assert(document.contract === 'yyds-sql-schema/v0', `contract is ${document.contract}`);
            assert(Number.isInteger(document.revision) && document.revision > 0, `revision is ${document.revision}`);
            const table = document.tables.find((candidate) => candidate.name === 'postgres.public.projected');
            assert(table !== undefined, `tables are ${JSON.stringify(document.tables.map((candidate) => candidate.name))}`);
            assert(!('database' in table) && !('schema' in table), 'projection must stay inside the registry contract');
            const label = table.fields.find((field) => field.name === 'label');
            assert(label.type === 'string' && label.nullable === false && label.capacity === 10, `label field is ${JSON.stringify(label)}`);
            const id = table.fields.find((field) => field.name === 'id');
            assert(id.auto_increment === true && id.next_value === 3, `id field is ${JSON.stringify(id)}`);
            const index = document.indexes.find((candidate) => candidate.name === 'postgres.public.projected_label');
            assert(index !== undefined && index.unique === false && JSON.stringify(index.columns) === '["label"]', `index is ${JSON.stringify(index)}`);
        });

        await check('artifacts/multi-database', async () => {
            const directory = temporary('postgres-durable-multi-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE DATABASE app');
            await client.query('CREATE TABLE primary_notes (id int PRIMARY KEY, note text)');
            await client.query("INSERT INTO primary_notes VALUES (1, 'primary')");
            await client.end();
            const app = await connect(server.port, 'app');
            await app.query('CREATE TABLE app_items (id int PRIMARY KEY, label text NOT NULL)');
            await app.query("INSERT INTO app_items VALUES (1, 'item')");
            await app.end();
            await stop(server);

            const document = JSON.parse(fs.readFileSync(path.join(directory, 'sql-schema.v0.json'), 'utf8'));
            const names = document.tables.map((candidate) => candidate.name);
            assert(names.includes('postgres.public.primary_notes'), `projection tables are ${JSON.stringify(names)}`);
            assert(names.includes('app.public.app_items'), `projection tables are ${JSON.stringify(names)}`);

            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port, 'app');
            assert(JSON.stringify((await reader.query('SELECT id, label FROM app_items')).rows) === '[{"id":1,"label":"item"}]', 'app rows did not survive restart');
            await reader.end();
            await stop(reopened);
        });

        await check('psql/real-session', async () => {
            const binary = psqlBinary();
            const server = await start({ dataDir: temporary('postgres-durable-psql-') });
            const session = await psqlSession(
                binary,
                server.port,
                [
                    '\\conninfo',
                    'DROP TABLE IF EXISTS psql_session;',
                    'CREATE TABLE psql_session (id int PRIMARY KEY, note text NOT NULL);',
                    "INSERT INTO psql_session VALUES (1, 'one'), (2, 'two'), (3, 'three');",
                    'SELECT id, note FROM psql_session ORDER BY id;',
                    'SELECT * FROM psql_missing_relation;',
                    'SELECT count(*) AS survivors FROM psql_session;',
                    '\\dt',
                    '\\q',
                ].join('\n'),
            );
            assert(session.code === 0, `psql exited with ${session.code}: ${session.stderr}`);
            assert(session.stdout.includes(String(server.port)) && session.stdout.includes('127.0.0.1'), `missing conninfo: ${session.stdout}`);
            assert(session.stdout.includes('one') && session.stdout.includes('three'), `missing rows: ${session.stdout}`);
            assert(/^\s*3\s*$/m.test(session.stdout), `failed statement did not recover: ${session.stdout}`);
            assert(session.stdout.includes('psql_session'), `\\dt did not list the table: ${session.stdout}`);
            assert(session.stderr.includes('psql_missing_relation'), `error was swallowed: ${session.stderr}`);
            await stop(server);
        });

        await check('crash/killed-mid-write', async () => {
            const directory = temporary('postgres-durable-kill-');
            const binary = path.resolve(harnessDir, SERVER_BIN);
            const child = spawn(process.execPath, [binary, '--host', '127.0.0.1', '--port', '0', '--data-dir', directory], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const address = await listening(child);
            const client = await connect(address.port);
            await client.query('CREATE TABLE crashy (id int PRIMARY KEY, note text NOT NULL)');
            const base = Array.from({ length: 5000 }, (_, index) => `(${index}, 'base')`).join(',');
            await client.query(`INSERT INTO crashy VALUES ${base}`);
            assert((await client.query('SELECT count(*) AS total FROM crashy')).rows[0].total === '5000', 'the pre-kill rows did not commit');
            // A one-row UPDATE still rewrites the whole shard snapshot, so a kill
            // in this window lands inside the commit path.
            client.query("UPDATE crashy SET note = 'rewritten' WHERE id = 2500").catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 5));
            client.on('error', () => {});
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
            client.connection.stream.destroy();

            const lockPath = path.join(directory, 'postmaster.pid');
            assert(fs.existsSync(lockPath), 'a hard kill must leave postmaster.pid behind');
            const holder = fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0];
            assert(holder === String(child.pid), `postmaster.pid records ${holder}, child is ${child.pid}`);

            // The stale lock is reclaimed automatically: the recorded process is
            // gone, so the restart takes the directory without operator help.
            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            const all = await reader.query('SELECT id, note FROM crashy ORDER BY id');
            assert(all.rows.length === 5000, `torn write left ${all.rows.length} rows`);
            const untouched = all.rows.slice(0, 2500).every((row) => row.id <= 2500 && row.note === 'base');
            assert(untouched, 'rows before the rewritten row were damaged');
            const rewritten = all.rows[2500];
            assert(rewritten.id === 2500 && (rewritten.note === 'base' || rewritten.note === 'rewritten'), `row 2500 is ${JSON.stringify(rewritten)}`);
            assert(all.rows.slice(2501).every((row) => row.id > 2500 && row.note === 'base'), 'rows after the rewritten row were damaged');
            await reader.query("INSERT INTO crashy VALUES (6000, 'after')");
            assert((await reader.query('SELECT count(*) AS total FROM crashy')).rows[0].total === '5001', 'restarted server is not writable');
            await reader.end();
            await stop(reopened);
        });

        await check('crash/stale-lock', async () => {
            const directory = temporary('postgres-durable-lock-');
            const first = await start({ dataDir: directory });
            const client = await connect(first.port);
            let concurrent = false;
            try {
                await start({ dataDir: directory });
            } catch (error) {
                concurrent = true;
                const message = error instanceof Error ? error.message : String(error);
                assert(/postmaster\.pid|locked|lock/.test(message), `unexpected concurrent refusal: ${message}`);
            }
            assert(concurrent, 'a live data directory must refuse a second opener');
            await client.query('CREATE TABLE locked (id int PRIMARY KEY)');
            await client.end();
            await stop(first);
            assert(!fs.existsSync(path.join(directory, 'postmaster.pid')), 'a clean shutdown must release postmaster.pid');
            const second = await start({ dataDir: directory });
            const reader = await connect(second.port);
            assert((await reader.query('SELECT count(*) FROM locked')).rows[0].count === '0', 'data directory is not usable after a clean shutdown');
            await reader.end();
            await stop(second);
        });

        await check('lock/clean-exit', async () => {
            const directory = temporary('postgres-durable-clean-');
            const binary = path.resolve(harnessDir, SERVER_BIN);
            const child = spawn(process.execPath, [binary, '--host', '127.0.0.1', '--port', '0', '--data-dir', directory, '--stop-on-stdin-close'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const address = await listening(child);
            const client = await connect(address.port);
            await client.query('CREATE TABLE clean_exit (id int PRIMARY KEY)');
            await client.query('INSERT INTO clean_exit VALUES (1)');
            await client.end();
            const lockPath = path.join(directory, 'postmaster.pid');
            assert(fs.existsSync(lockPath), 'the running child holds postmaster.pid');
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.stdin.end();
            const code = await exited;
            assert(code === 0, `clean shutdown exited with ${code}`);
            assert(!fs.existsSync(lockPath), 'a clean process exit removes postmaster.pid');
            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            assert((await reader.query('SELECT count(*) AS total FROM clean_exit')).rows[0].total === '1', 'data did not survive the clean restart');
            await reader.end();
            await stop(reopened);
        });

        await check('timeout/statement', async () => {
            const server = await start({ dataDir: temporary('postgres-durable-timeout-') });
            const client = await connect(server.port);
            await client.query('CREATE TABLE timeout_rows (id int PRIMARY KEY, note text)');
            const rows = Array.from({ length: 700 }, (_, index) => `(${index}, 'x')`).join(',');
            await client.query(`INSERT INTO timeout_rows VALUES ${rows}`);
            await client.query("SET statement_timeout = '50ms'");
            const shown = await client.query('SHOW statement_timeout');
            assert(shown.rows[0].statement_timeout === '50ms', `SHOW reports ${JSON.stringify(shown.rows[0])}`);
            const heavy = 'SELECT count(*) AS total FROM timeout_rows a, timeout_rows b';
            const timeout = await client.query(heavy).then(() => null, (error) => error);
            assert(timeout !== null && timeout.code === '57014', `heavy query returned ${timeout === null ? 'success' : timeout.code}`);
            assert(/canceling statement due to statement timeout/.test(timeout.message), `timeout message is ${timeout.message}`);
            const units = await client.query("SET statement_timeout = '1s'");
            assert(units.command === 'SET', `SET with a unit returned ${units.command}`);
            assert((await client.query('SHOW statement_timeout')).rows[0].statement_timeout === '1s', 'SET 1s did not round-trip');
            await client.query('SET statement_timeout = 250');
            assert((await client.query('SHOW statement_timeout')).rows[0].statement_timeout === '250', 'bare milliseconds did not round-trip');
            const invalid = await client.query("SET statement_timeout = '5 fortnights'").then(() => null, (error) => error);
            assert(invalid !== null && invalid.code === '22023', `bad unit returned ${invalid === null ? 'success' : invalid.code}`);
            const garbage = await client.query("SET statement_timeout = 'abc'").then(() => null, (error) => error);
            assert(garbage !== null && garbage.code === '22023', `garbage value returned ${garbage === null ? 'success' : garbage.code}`);
            // An open transaction block enters the aborted state and stays there
            // until ROLLBACK, exactly like PostgreSQL.
            await client.query("SET statement_timeout = '50ms'");
            await client.query('BEGIN');
            const inTransaction = await client.query(heavy).then(() => null, (error) => error);
            assert(inTransaction !== null && inTransaction.code === '57014', `in-transaction timeout is ${inTransaction === null ? 'success' : inTransaction.code}`);
            const refused = await client.query('SELECT 1').then(() => null, (error) => error);
            assert(refused !== null && refused.code === '25P02', `aborted block reports ${refused === null ? 'success' : refused.code}`);
            await client.query('ROLLBACK');
            const recovered = await client.query('SELECT 1 AS one');
            assert(Number(recovered.rows[0].one) === 1, 'session did not recover after ROLLBACK');
            await client.end();
            await stop(server);
        });

        await check('timeout/disabled', async () => {
            const server = await start({ dataDir: temporary('postgres-durable-notimeout-') });
            const client = await connect(server.port);
            await client.query('CREATE TABLE idle_rows (id int PRIMARY KEY)');
            const rows = Array.from({ length: 500 }, (_, index) => `(${index})`).join(',');
            await client.query(`INSERT INTO idle_rows VALUES ${rows}`);
            const shown = await client.query('SHOW statement_timeout');
            assert(shown.rows[0].statement_timeout === '0', `default statement_timeout is ${JSON.stringify(shown.rows[0])}`);
            const heavy = 'SELECT count(*) AS total FROM idle_rows a, idle_rows b';
            const result = await client.query(heavy);
            assert(result.rows[0].total === '250000', `default timeout throttled the query: ${JSON.stringify(result.rows)}`);
            await client.query("SET statement_timeout = '50ms'");
            await client.query('SET statement_timeout = 0');
            const again = await client.query(heavy);
            assert(again.rows[0].total === '250000', 'reset to 0 did not remove the deadline');
            await client.end();
            await stop(server);
        });

        await check('leak/abandoned-connections', async () => {
            const server = await start({ dataDir: temporary('postgres-durable-leak-') });
            const clients = [];
            for (let index = 0; index < 24; index += 1) {
                const client = await connect(server.port);
                if (index < 8) {
                    await client.query(`CREATE TEMP TABLE leak_temp_${index} (value int)`);
                    await client.query(`INSERT INTO leak_temp_${index} VALUES (${index})`);
                }
                clients.push(client);
            }
            for (const client of clients) abandon(client);
            const probe = await connect(server.port);
            let remaining = null;
            for (let attempt = 0; attempt < 60; attempt += 1) {
                remaining = Number(
                    (await probe.query("SELECT count(*) AS total FROM pg_catalog.pg_class WHERE relpersistence = 't'")).rows[0].total,
                );
                if (remaining === 0) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert(remaining === 0, `server kept ${remaining} temporary relations after abandoned sessions`);
            assert(Number((await probe.query("SELECT count(*) AS total FROM pg_catalog.pg_class WHERE relname = 'leak_temp_0'")).rows[0].total) === 0, 'leaked temporary table is still visible');
            await probe.query('CREATE TABLE after_leak (id int PRIMARY KEY)');
            await probe.end();
            const started = Date.now();
            await stop(server);
            assert(Date.now() - started < 5000, `close waited ${Date.now() - started}ms on abandoned sockets`);
        });

        await check('errors/not-fake-success', async () => {
            const directory = temporary('postgres-durable-errors-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE guarded (id int PRIMARY KEY, name text NOT NULL)');
            await client.query("INSERT INTO guarded VALUES (1, 'kept')");
            const nullName = await client.query('INSERT INTO guarded VALUES (2, NULL)').then(
                () => null,
                (error) => error,
            );
            assert(nullName !== null && nullName.code === '23502', `NOT NULL insert returned ${nullName === null ? 'success' : nullName.code}`);
            const duplicate = await client.query("INSERT INTO guarded VALUES (1, 'copy')").then(
                () => null,
                (error) => error,
            );
            assert(duplicate !== null && duplicate.code === '23505', `duplicate insert returned ${duplicate === null ? 'success' : duplicate.code}`);
            assert((await client.query('SELECT count(*) AS total FROM guarded')).rows[0].total === '1', 'a rejected insert changed the table');
            await client.end();
            await stop(server);

            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            const rows = await reader.query('SELECT id, name FROM guarded');
            assert(JSON.stringify(rows.rows) === '[{"id":1,"name":"kept"}]', `rejected inserts survived restart: ${JSON.stringify(rows.rows)}`);
            await reader.end();
            await stop(reopened);
        });

        await check('errors/commit-failure', async () => {
            const directory = temporary('postgres-durable-commit-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE durable (id int PRIMARY KEY, note text)');
            await client.query("INSERT INTO durable VALUES (1, 'kept')");
            const restore = denyCommit(directory);
            try {
                const failure = await client.query("INSERT INTO durable VALUES (2, 'lost')").then(
                    () => null,
                    (error) => error,
                );
                assert(failure !== null, 'a failed commit reported success');
                assert(failure.code === '58030', `failed commit code is ${failure.code}`);
                assert((await client.query('SELECT count(*) AS total FROM durable')).rows[0].total === '1', 'a failed commit leaked rows into the session');
                assert((await client.query('SELECT * FROM durable WHERE id = 2')).rows.length === 0, 'a failed commit leaked the row back');
            } finally {
                restore();
            }
            await client.query("INSERT INTO durable VALUES (3, 'after')");
            assert((await client.query('SELECT count(*) AS total FROM durable')).rows[0].total === '2', 'storage did not recover after a failed commit');
            await client.end();
            await stop(server);

            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            const rows = await reader.query('SELECT id, note FROM durable ORDER BY id');
            assert(JSON.stringify(rows.rows) === '[{"id":1,"note":"kept"},{"id":3,"note":"after"}]', `durability after a failed commit is ${JSON.stringify(rows.rows)}`);
            await reader.end();
            await stop(reopened);
        });

        await check('shard/migrate-on-open', async () => {
            const binding = nativeBinding(repositoryRoot);
            const directory = temporary('postgres-durable-shard-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE legacy (id serial PRIMARY KEY, name varchar(32) NOT NULL)');
            await client.query('CREATE UNIQUE INDEX legacy_name ON legacy (name)');
            await client.query("INSERT INTO legacy (name) VALUES ('one'), ('two'), ('three')");
            await client.end();
            await stop(server);

            const legacyDir = temporary('postgres-durable-legacy-');
            const catalog = seedLegacyDirectory(binding, directory, legacyDir);
            const relOid = catalog.relations.find((candidate) => candidate.relkind === 'r').oid;
            const hex = Buffer.from('postgres', 'utf8').toString('hex');
            const shardFile = path.join(legacyDir, 'shards', `local-${relOid}-${hex}`, 'local-0.yykv');
            assert(!fs.existsSync(shardFile), 'the seeded directory must be the pre-sharding layout');

            const migrated = await start({ dataDir: legacyDir });
            const reader = await connect(migrated.port);
            const rows = await reader.query('SELECT id, name FROM legacy ORDER BY id');
            assert(JSON.stringify(rows.rows) === JSON.stringify([{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }]), `migrated rows are ${JSON.stringify(rows.rows)}`);
            await reader.end();
            await stop(migrated);
            assert(fs.existsSync(shardFile), `migration did not create ${shardFile}`);

            const probe = new binding.ServerStore(legacyDir);
            const leftover = readShardRows(probe.scanFlat(`db:postgres:pg_data.${relOid}`, Buffer.alloc(0), null, null, 0));
            probe.close();
            assert(leftover.length === 0, `the primary shard still holds ${leftover.length} data rows`);

            const again = await start({ dataDir: legacyDir });
            const second = await connect(again.port);
            assert((await second.query('SELECT count(*) AS total FROM legacy')).rows[0].total === '3', 'the second open re-migrated and lost rows');
            await second.end();
            await stop(again);
        });

        await check('shard/migrate-hard-kill', async () => {
            const binding = nativeBinding(repositoryRoot);
            const sourceDir = temporary('postgres-durable-kill-src-');
            const server = await start({ dataDir: sourceDir });
            const client = await connect(server.port);
            for (let table = 0; table < 6; table += 1) {
                await client.query(`CREATE TABLE mig_${table} (id int PRIMARY KEY, note text NOT NULL)`);
                const base = Array.from({ length: 1500 }, (_, index) => `(${index}, 'base')`).join(',');
                await client.query(`INSERT INTO mig_${table} VALUES ${base}`);
            }
            await client.end();
            await stop(server);

            const legacyDir = temporary('postgres-durable-kill-legacy-');
            seedLegacyDirectory(binding, sourceDir, legacyDir);

            const binary = path.resolve(harnessDir, SERVER_BIN);
            const child = spawn(process.execPath, [binary, '--host', '127.0.0.1', '--port', '0', '--data-dir', legacyDir], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            // SIGKILL as soon as the first table-group shard appears: the kill
            // lands inside the migration window, before every group is copied
            // and before the primary flip. If migration finishes first, the
            // kill lands in the running server instead — the assertions below
            // hold for either interleaving.
            const shardsRoot = path.join(legacyDir, 'shards');
            const deadline = Date.now() + 30_000;
            while (!fs.existsSync(shardsRoot) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;

            const reopened = await start({ dataDir: legacyDir });
            const reader = await connect(reopened.port);
            for (let table = 0; table < 6; table += 1) {
                const count = (await reader.query(`SELECT count(*) AS total FROM mig_${table}`)).rows[0].total;
                assert(count === '1500', `mig_${table} holds ${count} rows after the killed migration`);
                const sample = await reader.query(`SELECT note FROM mig_${table} WHERE id = 749`);
                assert(sample.rows.length === 1 && sample.rows[0].note === 'base', `a mig_${table} row was damaged by the killed migration`);
            }
            await reader.query("INSERT INTO mig_0 VALUES (9999, 'after')");
            assert((await reader.query('SELECT count(*) AS total FROM mig_0')).rows[0].total === '1501', 'the restarted server is not writable');
            await reader.end();
            await stop(reopened);
        });

        await check('shard/orphan-sweep', async () => {
            const binding = nativeBinding(repositoryRoot);
            const directory = temporary('postgres-durable-sweep-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE survivor (id int PRIMARY KEY)');
            await client.query('INSERT INTO survivor VALUES (1)');
            await client.query('CREATE TABLE dropped (id int PRIMARY KEY, note text)');
            await client.query("INSERT INTO dropped VALUES (1, 'gone'), (2, 'gone')");
            const oids = await client.query("SELECT oid, relname FROM pg_catalog.pg_class WHERE relname IN ('survivor', 'dropped')");
            const oidOf = (name) => Number(oids.rows.find((row) => row.relname === name).oid);
            await client.query('DROP TABLE dropped');
            await client.end();
            await stop(server);

            const hex = Buffer.from('postgres', 'utf8').toString('hex');
            const droppedDir = path.join(directory, 'shards', `local-${oidOf('dropped')}-${hex}`);
            assert(fs.existsSync(droppedDir), 'a dropped table keeps its shard directory until the next open');
            const stray = new binding.Store(path.join(directory, 'shards', `local-99999-${hex}`));
            assert(stray.dataDir().length > 0, 'the stray shard directory must be a standard store directory');

            const reopened = await start({ dataDir: directory });
            const reader = await connect(reopened.port);
            assert((await reader.query('SELECT count(*) AS total FROM survivor')).rows[0].total === '1', 'the sweep damaged a survivor');
            await reader.end();
            await stop(reopened);
            assert(!fs.existsSync(droppedDir), 'the sweep must remove the dropped table shard');
            assert(!fs.existsSync(path.join(directory, 'shards', `local-99999-${hex}`)), 'the sweep must remove an orphan shard directory');
            assert(fs.existsSync(path.join(directory, 'shards', `local-${oidOf('survivor')}-${hex}`)), 'the sweep must keep referenced shards');
        });

        await check('shard/commit-isolation', async () => {
            const directory = temporary('postgres-durable-isolation-');
            const server = await start({ dataDir: directory });
            const client = await connect(server.port);
            await client.query('CREATE TABLE small (id int PRIMARY KEY, note text)');
            await client.query('CREATE TABLE big (id int PRIMARY KEY, note text)');
            const bigRows = Array.from({ length: 10_000 }, (_, index) => `(${index}, 'x')`).join(',');
            await client.query(`INSERT INTO big VALUES ${bigRows}`);
            const smallRows = Array.from({ length: 10 }, (_, index) => `(${index}, 'y')`).join(',');
            await client.query(`INSERT INTO small VALUES ${smallRows}`);
            const before = snapshot(directory);
            await client.query("INSERT INTO small VALUES (99, 'late')");
            const after = snapshot(directory);
            await client.end();
            await stop(server);

            const changed = Object.keys(after).filter((file) => before[file] !== after[file]);
            assert(changed.length === 1, `a small-table commit rewrote ${JSON.stringify(changed)}`);
            assert(changed[0].startsWith(`shards${path.sep}`) && changed[0].endsWith('local-0.yykv'), `the rewritten file is ${changed[0]}`);
            assert(before['local-0.yykv'] === after['local-0.yykv'], 'plain DML must not touch the primary shard');
        });

        return {
            name: 'durability',
            output: lines.join('\n'),
            counts: { executed, skipped: 0, failed },
            floor: 9,
        };
    } finally {
        for (const server of servers.splice(0)) await server.close().catch(() => {});
        for (const directory of directories) {
            try {
                removeDirectory(directory);
            } catch {
                // A killed child may hold the directory for a moment on Windows.
            }
        }
    }
}
