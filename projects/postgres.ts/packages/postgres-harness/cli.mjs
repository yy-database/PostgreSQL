#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from './server.mjs';
import { runNative } from './stages/native.mjs';
import { runNodeSuite } from './stages/node.mjs';
import { runPythonSuite } from './stages/python.mjs';
import { runRust } from './stages/rust.mjs';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(harnessDir, '..', '..', '..', '..');
const TAIL_LINES = 40;

function tail(output) {
    const lines = `${output}`.trimEnd().split(/\r?\n/);
    return lines.slice(-TAIL_LINES).join('\n');
}

function report(stage) {
    const { executed, skipped, failed } = stage.counts;
    const ok = failed === 0 && skipped === 0 && executed >= stage.floor;
    const reason = [];
    if (failed > 0) reason.push(`${failed} failed`);
    if (skipped > 0) reason.push(`${skipped} skipped`);
    if (executed < stage.floor) reason.push(`${executed} executed below floor ${stage.floor}`);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${stage.name}: executed=${executed} skipped=${skipped} failed=${failed} floor=${stage.floor}`);
    if (!ok) console.log(tail(stage.output));
    return { ok, name: stage.name, executed, skipped, failed, floor: stage.floor, reason: reason.join(', ') };
}

function readCases(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).cases ?? {};
    } catch {
        return {};
    }
}

function compare(runs) {
    const left = readCases(path.join(runs.resultDir, 'ts.json'));
    const right = readCases(path.join(runs.resultDir, 'py.json'));
    const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    const lines = [];
    let failed = 0;
    for (const name of names) {
        const ts = left[name];
        const py = right[name];
        const same = JSON.stringify(ts) === JSON.stringify(py);
        if (!same) {
            failed += 1;
            lines.push(`case ${name}\n  TS ${JSON.stringify(ts)}\n  PY ${JSON.stringify(py)}`);
        }
    }
    return {
        name: 'consistency',
        output: lines.join('\n'),
        counts: { executed: names.length, skipped: 0, failed },
        floor: 0,
    };
}

const command = process.argv[2] ?? 'test';
if (command !== 'test') {
    console.error(`unknown command '${command}'`);
    process.exit(2);
}

const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-results-'));
const server = await startServer();
const env = {
    ...process.env,
    POSTGRES_TEST_HOST: '127.0.0.1',
    POSTGRES_TEST_PORT: String(server.port),
    POSTGRES_TEST_USER: 'postgres',
    POSTGRES_TEST_DATABASE: 'postgres',
    POSTGRES_RESULT_DIR: resultDir,
};

const stages = [];
try {
    stages.push(await runNative(repositoryRoot));
    stages.push(await runRust(repositoryRoot, env));
    stages.push(await runNodeSuite(repositoryRoot, harnessDir, env));
    stages.push(await runPythonSuite(repositoryRoot, harnessDir, env));
} finally {
    await server.stop();
}
stages.push(compare({ resultDir }));

const summary = stages.map(report);
const failed = summary.filter((stage) => !stage.ok);
console.log(JSON.stringify({ server: `127.0.0.1:${server.port}`, stages: summary, ok: failed.length === 0 }, null, 4));
process.exit(failed.length === 0 ? 0 : 1);
