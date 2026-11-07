import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

import pg from 'pg';

import { startPostgresServer } from '../../postgres/dist/server/server.js';

const SERVER_BIN = '../postgres/bin/postgres-server.mjs';

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
    if (process.platform === 'win32') {
        const shard = path.join(directory, 'local-0.yykv');
        execFileSync('attrib', ['+R', shard]);
        return () => execFileSync('attrib', ['-R', shard]);
    }
    const mode = fs.statSync(directory).mode & 0o777;
    fs.chmodSync(directory, mode & ~0o222);
    return () => fs.chmodSync(directory, mode);
}

export async function runDurabilityStage(_repositoryRoot, harnessDir) {
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
            assert(fs.existsSync(lockPath), 'a hard kill must leave postmaster.pid for the operator');
            let refused = false;
            try {
                await start({ dataDir: directory });
            } catch (error) {
                refused = true;
                const message = error instanceof Error ? error.message : String(error);
                assert(/postmaster\.pid|locked|lock/.test(message), `unexpected lock refusal: ${message}`);
            }
            assert(refused, 'a second opener must not silently take a killed data directory');

            // The operator removes the stale pid file once the old process is gone.
            fs.unlinkSync(lockPath);
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
