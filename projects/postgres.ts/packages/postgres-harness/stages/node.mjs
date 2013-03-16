import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mustRun, run } from './process.mjs';

/**
 * Packs the published file sets, installs them into a throwaway application,
 * and runs the assertion suite through the public package entry point.
 */
export async function runNodeSuite(repositoryRoot, harnessDir, env) {
    await mustRun('pnpm', ['run', 'build:ts'], { cwd: repositoryRoot, env });

    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-install-'));
    const packed = path.join(installRoot, 'tarballs');
    const appDir = path.join(installRoot, 'app');
    fs.mkdirSync(packed);
    fs.mkdirSync(appDir);

    const platformKey = `${process.platform}-${process.arch}`;
    for (const packageDir of [
        path.join(repositoryRoot, 'projects', 'postgres.ts', 'packages', 'postgres'),
        path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${platformKey}`),
    ]) {
        await mustRun('pnpm', ['pack', '--pack-destination', packed], { cwd: packageDir, env });
    }

    const tarballs = fs
        .readdirSync(packed)
        .filter((name) => name.endsWith('.tgz'))
        .map((name) => path.join(packed, name));
    fs.writeFileSync(
        path.join(appDir, 'package.json'),
        `${JSON.stringify({ name: 'postgres-acceptance', private: true, type: 'module' }, null, 4)}\n`,
    );
    await mustRun('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs], {
        cwd: appDir,
        env,
    });

    fs.copyFileSync(
        path.join(harnessDir, 'tests', 'node', 'acceptance.mjs'),
        path.join(appDir, 'acceptance.mjs'),
    );
    const resultFile = path.join(env.POSTGRES_RESULT_DIR, 'ts.json');
    const nodeEnv = {
        ...env,
        POSTGRES_CASES_DIR: path.join(harnessDir, 'cases'),
        POSTGRES_RESULT_FILE: resultFile,
        POSTGRES_STORE_ROOT: path.join(installRoot, 'stores'),
    };
    fs.mkdirSync(nodeEnv.POSTGRES_STORE_ROOT, { recursive: true });

    const result = await run('node', ['acceptance.mjs'], { cwd: appDir, env: nodeEnv, timeout: 600_000 });
    const output = `${result.stdout}${result.stderr}`;
    let summary = { executed: 0, skipped: 0, failed: 1 };
    try {
        summary = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch {
        // The suite crashed before writing its counters; the stage fails below.
    }
    const failed = summary.failed + (result.status === 0 ? 0 : 1);
    return {
        name: 'node',
        output,
        counts: { executed: summary.executed, skipped: summary.skipped ?? 0, failed },
        floor: 1145,
    };
}
