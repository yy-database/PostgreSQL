import path from 'node:path';

import { mustRun } from './process.mjs';

/** Builds the release binding and copies it into the platform package. */
export async function runNative(repositoryRoot) {
    const result = await mustRun('node', [path.join(repositoryRoot, 'scripts', 'build-napi.mjs')], {
        cwd: repositoryRoot,
    });
    return { name: 'native', output: `${result.stdout}${result.stderr}`, counts: { executed: 1, skipped: 0, failed: 0 }, floor: 1 };
}
