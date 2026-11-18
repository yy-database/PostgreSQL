import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import pg from 'pg';

import { mustRun } from './process.mjs';

/**
 * Restart, locking and rollback behaviour of the native engine's data
 * directory.
 *
 * Every check opens the same directory with a fresh `LocalEngine`, so the
 * durable state — not an in-process cache — is what the assertions observe.
 */
export async function runDurability(repositoryRoot) {
    const lines = [];
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

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-durability-stage-'));

    const open = () => new binding.LocalEngine({ dataDir, database: 'postgres' });
    const withClient = async (engine, body) => {
        const listener = engine.listen('127.0.0.1', 0);
        const client = new pg.Client({ host: '127.0.0.1', port: listener.port, user: 'postgres', database: 'postgres' });
        await client.connect();
        try {
            return await body(client);
        } finally {
            await client.end();
            engine.closeListener(listener.id);
        }
    };
    const query = (engine, sql) => withClient(engine, (client) => client.query(sql));

    try {
        await check('durability/ddl-and-rows-survive-restart', async () => {
            const first = open();
            try {
                await query(first, 'CREATE TABLE kept (id BIGINT PRIMARY KEY, name TEXT)');
                await query(first, "INSERT INTO kept (id, name) VALUES (1, 'durable')");
            } finally {
                first.close();
            }
            const second = open();
            try {
                const { rows } = await query(second, 'SELECT name FROM kept WHERE id = 1');
                if (rows[0]?.name !== 'durable') throw new Error(`restart returned ${JSON.stringify(rows)}`);
            } finally {
                second.close();
            }
        });

        await check('durability/schema-document', async () => {
            const document = JSON.parse(fs.readFileSync(path.join(dataDir, 'schema.json'), 'utf8'));
            if (document.contract !== 'yyds-sql-schema/v0') throw new Error(`unexpected contract ${document.contract}`);
        });

        await check('durability/rollback-survives-restart', async () => {
            const engine = open();
            try {
                await withClient(engine, async (client) => {
                    await client.query('BEGIN');
                    await client.query('CREATE TABLE discarded (id BIGINT PRIMARY KEY)');
                    await client.query('ROLLBACK');
                });
            } finally {
                engine.close();
            }
            const reopened = open();
            try {
                let rejected = false;
                try {
                    await query(reopened, 'SELECT * FROM discarded');
                } catch (error) {
                    rejected = error.code === '42P01';
                }
                if (!rejected) throw new Error('a rolled-back CREATE was persisted');
            } finally {
                reopened.close();
            }
        });

        await check('durability/exclusive-directory-lock', async () => {
            const holder = open();
            try {
                let rejected = false;
                try {
                    open();
                } catch (error) {
                    rejected = /exists|lock|already/i.test(error.message);
                }
                if (!rejected) throw new Error('a second engine opened the same data directory');
            } finally {
                holder.close();
            }
        });

        await check('durability/prepared-statements-are-session-state', async () => {
            const engine = open();
            try {
                await query(engine, 'PREPARE stored AS SELECT 1');
            } finally {
                engine.close();
            }
            const reopened = open();
            try {
                let rejected = false;
                try {
                    await query(reopened, 'EXECUTE stored');
                } catch (error) {
                    rejected = error.code === '26000';
                }
                if (!rejected) throw new Error('a prepared statement survived its session');
            } finally {
                reopened.close();
            }
        });
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    return { name: 'durability', output: lines.join('\n'), counts: { executed, skipped: 0, failed }, floor: 5 };
}
