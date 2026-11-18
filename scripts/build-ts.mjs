// Builds the TypeScript package from a clean `dist`.
//
// `tsc` never deletes emit for a module that was removed, so a rebuild would
// keep shipping the stale files of deleted sources. Clearing `dist` first keeps
// the packed tarball to exactly what `src/` contains today.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repo, 'projects', 'postgres.ts', 'packages', 'postgres');

rmSync(join(packageDir, 'dist'), { recursive: true, force: true });
execFileSync('node', [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(packageDir, 'tsconfig.json')], {
    cwd: repo,
    stdio: 'inherit',
});
