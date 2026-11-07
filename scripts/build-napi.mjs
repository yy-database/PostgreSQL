// Builds `postgres-napi` and drops the addon into the matching platform package.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repo, 'projects', 'postgres.rs');
const platform = process.env.POSTGRES_NATIVE_PLATFORM?.trim() || `${process.platform}-${process.arch}`;
const packageDir = join(repo, 'projects', 'postgres.ts', 'platforms', `postgres-${platform}`);
const nodeName = `postgres.${platform}.node`;

const artifact = {
    'win32-x64': { name: 'postgres_napi.dll' },
    'linux-x64': { name: 'libpostgres_napi.so' },
    'darwin-x64': { name: 'libpostgres_napi.dylib' },
    'darwin-arm64': { name: 'libpostgres_napi.dylib' },
}[platform];

if (!artifact) {
    throw new Error(`unsupported platform ${platform}`);
}

execFileSync('cargo', ['build', '--release', '-p', 'postgres-napi'], {
    cwd: crateDir,
    stdio: 'inherit',
});

const source = join(resolve(crateDir, process.env.CARGO_TARGET_DIR ?? 'target'), 'release', artifact.name);
if (!existsSync(source)) {
    throw new Error(`missing build artifact ${source}`);
}

const dest = join(packageDir, nodeName);
copyFileSync(source, dest);
console.log(`napi addon -> ${dest}`);
