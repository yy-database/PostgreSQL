import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const manifest = path.join(repositoryRoot, 'projects', 'postgres.rs', 'Cargo.toml');

const targets = {
    'win32-x64': { artifact: 'postgres_napi.dll', binding: 'postgres-win32-x64-msvc.node' },
    'linux-x64': { artifact: 'libpostgres_napi.so', binding: 'postgres-linux-x64-gnu.node' },
    'darwin-x64': { artifact: 'libpostgres_napi.dylib', binding: 'postgres-darwin-x64.node' },
    'darwin-arm64': { artifact: 'libpostgres_napi.dylib', binding: 'postgres-darwin-arm64.node' },
};

const key = process.env.POSTGRES_NATIVE_PLATFORM?.trim() ?? `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) throw new Error(`no native binding target for ${key}`);

execFileSync('cargo', ['build', '--manifest-path', manifest, '-p', 'postgres-napi', '--release'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
});

const source = path.join(repositoryRoot, 'projects', 'postgres.rs', 'target', 'release', target.artifact);
if (!fs.existsSync(source)) throw new Error(`native artifact is missing: ${source}`);

const destinationDir = path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${key}`, 'lib');
fs.mkdirSync(destinationDir, { recursive: true });
const destination = path.join(destinationDir, target.binding);
fs.copyFileSync(source, destination);
console.log(`native binding: ${path.relative(repositoryRoot, destination)}`);
