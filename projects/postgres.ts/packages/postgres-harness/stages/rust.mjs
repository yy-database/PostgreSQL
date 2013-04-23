import path from 'node:path';

import { run } from './process.mjs';

/** Runs the Rust unit and live-server smoke tests against the launched server. */
export async function runRust(repositoryRoot, env) {
    const manifest = path.join(repositoryRoot, 'projects', 'postgres.rs', 'Cargo.toml');
    const result = await run('cargo', ['test', '--manifest-path', manifest, '-p', 'postgres-client', '--', '--test-threads=1'], {
        cwd: repositoryRoot,
        env,
        timeout: 300_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    let executed = 0;
    let failed = 0;
    let skipped = 0;
    for (const match of output.matchAll(/test result: .*?(\d+) passed; (\d+) failed; (\d+) ignored/g)) {
        executed += Number(match[1]);
        failed += Number(match[2]);
        skipped += Number(match[3]);
    }
    return {
        name: 'rust',
        output,
        counts: { executed, skipped, failed: failed + (result.status === 0 ? 0 : 1) },
        // 58 before the client re-export. docs/pgsql-client-test-migration.md
        // attributes all 25 removed tests to the upstream crates and the 18
        // integration tests to `database.client/tests`.
        floor: 18,
    };
}
