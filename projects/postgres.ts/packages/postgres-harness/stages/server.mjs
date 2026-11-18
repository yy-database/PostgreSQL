import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { mustRun } from './process.mjs';

/**
 * Drives the native engine through the public protocol surface.
 *
 * The old stage scripted the retired TypeScript engine. This one builds the
 * native binding, starts a `LocalEngine`, and talks to it with a stock `pg`
 * client, so every assertion is observable PostgreSQL behaviour rather than an
 * internal call.
 */
export async function runServer(repositoryRoot) {
    const build = await mustRun('node', [path.join(repositoryRoot, 'scripts', 'build-napi.mjs')], { cwd: repositoryRoot });
    const lines = [`${build.stdout}${build.stderr}`];
    let failed = 0;
    let executed = 1;
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

    const platformKey = process.env.POSTGRES_NATIVE_PLATFORM?.trim() ?? `${process.platform}-${process.arch}`;
    const require = createRequire(import.meta.url);
    const binding = require(path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${platformKey}`));

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-server-stage-'));
    const engine = new binding.LocalEngine({ dataDir, database: 'postgres' });
    const listener = engine.listen('127.0.0.1', 0);
    const connect = async () => {
        const client = new pg.Client({ host: '127.0.0.1', port: listener.port, user: 'postgres', database: 'postgres' });
        await client.connect();
        return client;
    };
    const withClient = async (body) => {
        const client = await connect();
        try {
            return await body(client);
        } finally {
            await client.end();
        }
    };
    const expectSqlstate = async (client, sql, code) => {
        try {
            await client.query(sql);
        } catch (error) {
            if (error.code !== code) throw new Error(`${sql} reported ${error.code}, expected ${code}: ${error.message}`);
            return;
        }
        throw new Error(`${sql} unexpectedly succeeded, expected SQLSTATE ${code}`);
    };

    try {
        await withClient(async (client) => {
            await client.query('CREATE TABLE items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT UNIQUE, score BIGINT)');

            await check('server/identity', async () => {
                await client.query("INSERT INTO items (name, score) VALUES ('a', 10), ('b', 20)");
                const { rows } = await client.query('SELECT id, name FROM items ORDER BY id');
                if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
                if (rows[1].id !== '2') throw new Error(`identity allocation returned ${rows[1].id}`);
            });

            await check('server/cast', async () => {
                const { rows } = await client.query("SELECT '41'::int8 + 1 AS value");
                if (rows[0].value !== '42') throw new Error(`cast produced ${rows[0].value}`);
            });

            await check('server/prepared', async () => {
                await client.query('PREPARE pick (bigint) AS SELECT name FROM items WHERE id = $1');
                const { rows } = await client.query('EXECUTE pick (2)');
                if (rows[0]?.name !== 'b') throw new Error(`PREPARE/EXECUTE returned ${JSON.stringify(rows)}`);
                await client.query('DEALLOCATE pick');
                await expectSqlstate(client, 'EXECUTE pick (1)', '26000');
            });

            await check('server/cursor', async () => {
                await client.query('BEGIN');
                await client.query('DECLARE walk CURSOR FOR SELECT id FROM items ORDER BY id');
                const first = await client.query('FETCH NEXT FROM walk');
                if (first.rows[0]?.id !== '1') throw new Error(`first fetch returned ${JSON.stringify(first.rows)}`);
                const rest = await client.query('FETCH ALL FROM walk');
                if (rest.rows.length !== 1) throw new Error(`FETCH ALL returned ${rest.rows.length} rows`);
                await client.query('CLOSE walk');
                await expectSqlstate(client, 'FETCH ALL FROM walk', '34000');
                await client.query('COMMIT');
            });

            await check('server/explain', async () => {
                const plan = await client.query('EXPLAIN SELECT name FROM items');
                if (!plan.rows.some((row) => row['QUERY PLAN'].includes('items'))) {
                    throw new Error(`plan does not name the table: ${JSON.stringify(plan.rows)}`);
                }
                const analyzed = await client.query('EXPLAIN ANALYZE SELECT name FROM items');
                if (!analyzed.rows[0]['QUERY PLAN'].includes('actual rows=2')) {
                    throw new Error(`ANALYZE did not report rows: ${JSON.stringify(analyzed.rows)}`);
                }
            });

            await check('server/copy-in', async () => {
                const stream = client.query(copyFrom('COPY items (name, score) FROM STDIN WITH (FORMAT csv)'));
                await new Promise((resolve, reject) => {
                    stream.on('error', reject);
                    stream.on('finish', resolve);
                    stream.end('c,30\nd,40\n');
                });
                const { rows } = await client.query('SELECT COUNT(*)::int8 AS total FROM items');
                if (rows[0].total !== '4') throw new Error(`COPY left ${rows[0].total} rows`);
            });

            await check('server/add-constraint', async () => {
                await client.query('ALTER TABLE items ADD CONSTRAINT items_score_check CHECK (score > 0)');
                await expectSqlstate(client, "INSERT INTO items (name, score) VALUES ('e', -1)", '23514');
                await expectSqlstate(client, "INSERT INTO items (name, score) VALUES ('a', 50)", '23505');
            });

            await check('server/error-sqlstate', async () => {
                await expectSqlstate(client, 'SELECT * FROM missing_table', '42P01');
                const alive = await client.query('SELECT 1 AS ok');
                if (alive.rows[0].ok !== '1') throw new Error('the connection did not stay usable after an error');
            });
        });

        await check('server/notify', async () => {
            const subscriber = await connect();
            try {
                await subscriber.query('LISTEN events');
                await withClient(async (publisher) => {
                    await publisher.query("NOTIFY events, 'payload'");
                });
                const received = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('no NotificationResponse arrived')), 3000);
                    subscriber.on('notification', (message) => {
                        clearTimeout(timer);
                        resolve(message);
                    });
                    subscriber.query('SELECT 1').catch(reject);
                });
                if (received.channel !== 'events' || received.payload !== 'payload') {
                    throw new Error(`unexpected notification ${JSON.stringify(received)}`);
                }
            } finally {
                await subscriber.end();
            }
        });

        await check('server/concurrent-connections', async () => {
            const first = await connect();
            const second = await connect();
            try {
                await first.query("INSERT INTO items (name, score) VALUES ('f', 60)");
                const { rows } = await second.query("SELECT score FROM items WHERE name = 'f'");
                if (rows[0]?.score !== '60') throw new Error('a committed row was not visible to the second connection');
                await expectSqlstate(second, 'SELECT * FROM missing_table', '42P01');
                await first.query('SELECT 1');
            } finally {
                await first.end();
                await second.end();
            }
        });

        await check('server/schema-persisted', async () => {
            if (!fs.existsSync(path.join(dataDir, 'schema.json'))) throw new Error('schema.json is missing from the data directory');
        });
    } finally {
        engine.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    return { name: 'server', output: lines.join('\n'), counts: { executed, skipped: 0, failed }, floor: 10 };
}
