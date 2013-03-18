import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { mustRun } from './process.mjs';

/** Builds the release binding, copies it into the platform package and probes `ServerStore`. */
export async function runNative(repositoryRoot) {
    const result = await mustRun('node', [path.join(repositoryRoot, 'scripts', 'build-napi.mjs')], {
        cwd: repositoryRoot,
    });
    const lines = [`${result.stdout}${result.stderr}`];
    let failed = 0;
    let executed = 1;
    const check = (name, body) => {
        executed += 1;
        try {
            body();
            lines.push(`ok ${name}`);
        } catch (error) {
            failed += 1;
            lines.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const key = process.env.POSTGRES_NATIVE_PLATFORM?.trim() ?? `${process.platform}-${process.arch}`;
    const require = createRequire(import.meta.url);
    const binding = require(path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${key}`, 'index.js')).default;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-native-store-'));
    const store = new binding.ServerStore(dataDir);
    const namespace = 'pg_data.16384';
    check('store/atomic-batch', () => {
        store.commitChanges([
            { kind: 'put', namespace, key: Buffer.from('0000000001'), value: Buffer.from('[1]') },
            { kind: 'put', namespace, key: Buffer.from('0000000002'), value: Buffer.from('[2]') },
        ]);
        const rows = store.scan(namespace, Buffer.alloc(0), null, null, 0);
        if (rows.length !== 2) throw new Error(`scan returned ${rows.length} rows`);
        if (rows[0].key.toString() !== '0000000001') throw new Error(`first key is ${rows[0].key}`);
        if (!store.durableAtomicCommit()) throw new Error('durableAtomicCommit returned false');
    });
    check('store/lock-exclusive', () => {
        let rejected = false;
        try {
            new binding.ServerStore(dataDir);
        } catch (error) {
            rejected = /already exists/.test(error.message);
        }
        if (!rejected) throw new Error('a second handle opened the same data directory');
    });
    check('store/reopen', () => {
        store.close();
        const reopened = new binding.ServerStore(dataDir);
        try {
            const rows = reopened.scan(namespace, Buffer.alloc(0), null, null, 0);
            if (rows.length !== 2) throw new Error(`reopened scan returned ${rows.length} rows`);
        } finally {
            reopened.close();
        }
    });

    return { name: 'native', output: lines.join('\n'), counts: { executed, skipped: 0, failed }, floor: 4 };
}
