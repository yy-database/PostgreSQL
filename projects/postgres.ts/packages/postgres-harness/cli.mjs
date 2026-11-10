#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { startServer } from './server.mjs';
import { runDriversStage } from './stages/drivers.mjs';
import { runDurabilityStage } from './stages/durability.mjs';
import { runNative } from './stages/native.mjs';
import { runNodeSuite } from './stages/node.mjs';
import { runPythonSuite } from './stages/python.mjs';
import { runRust } from './stages/rust.mjs';
import { runServerStage } from './stages/server.mjs';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(harnessDir, '..', '..', '..', '..');
const TAIL_LINES = 40;

function frame(tag, payload) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 4);
    return Buffer.concat([Buffer.from(tag), length, payload]);
}

function startupPacket() {
    const parameters = Buffer.concat([
        ...['user', 'postgres', 'database', 'postgres', 'application_name', 'copy-in-probe'].flatMap((value) => [
            Buffer.from(value),
            Buffer.from([0]),
        ]),
        Buffer.from([0]),
    ]);
    const length = Buffer.alloc(4);
    length.writeInt32BE(parameters.length + 8);
    const version = Buffer.alloc(4);
    version.writeInt32BE(196608);
    return Buffer.concat([length, version, parameters]);
}

function errorFields(payload) {
    const result = { severity: '', code: '', message: '', file: '', routine: '' };
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
        const kind = String.fromCharCode(payload[offset]);
        const end = payload.indexOf(0, offset + 1);
        const value = payload.subarray(offset + 1, end).toString('utf8');
        if (kind === 'S') result.severity = value;
        if (kind === 'V') result.severity = value;
        if (kind === 'C') result.code = value;
        if (kind === 'M') result.message = value;
        if (kind === 'F') result.file = value;
        if (kind === 'R') result.routine = value;
        offset = end + 1;
    }
    return result;
}

/**
 * Records why `COPY ... FROM STDIN` cannot be exercised against the oracle.
 *
 * The PGlite socket server answers `CopyInResponse`, never consumes `CopyData`,
 * and then tears the whole server down. Running this on the shared server would
 * kill every later stage, so it uses its own throwaway server and the observed
 * bytes travel to the suites as `POSTGRES_COPY_IN_EVIDENCE`.
 */
async function probeCopyIn() {
    const server = await startServer();
    try {
        const socket = net.connect(server.port, '127.0.0.1');
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.setTimeout(2000, () => socket.destroy());

        let buffer = Buffer.alloc(0);
        let closed = false;
        let waiter = null;
        const queue = [];
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            let offset = 0;
            while (buffer.length - offset >= 5) {
                const length = buffer.readInt32BE(offset + 1);
                if (buffer.length - offset - 1 < length) break;
                queue.push({
                    tag: String.fromCharCode(buffer[offset]),
                    payload: buffer.subarray(offset + 5, offset + 1 + length),
                });
                offset += 1 + length;
            }
            buffer = buffer.subarray(offset);
            if (waiter && queue.length) {
                const next = waiter;
                waiter = null;
                next(queue.shift());
            }
        });
        socket.on('close', () => {
            closed = true;
            if (waiter) {
                const next = waiter;
                waiter = null;
                next(null);
            }
        });
        const next = () =>
            queue.length
                ? Promise.resolve(queue.shift())
                : closed
                  ? Promise.resolve(null)
                  : new Promise((resolve) => {
                        waiter = resolve;
                    });
        const readUntilReady = async () => {
            let message;
            while ((message = await next()) !== null && message.tag !== 'Z') {}
        };
        const send = (sql) => socket.write(frame('Q', Buffer.concat([Buffer.from(sql), Buffer.from([0])])));

        socket.write(startupPacket());
        await readUntilReady();
        send('CREATE TABLE copy_in_probe (n int, s text)');
        await readUntilReady();
        send('COPY copy_in_probe FROM STDIN');

        const messages = [];
        let message;
        while ((message = await next()) !== null) {
            messages.push(message);
            if (message.tag === 'E') {
                const fields = errorFields(message.payload);
                if (fields.severity === 'FATAL') break;
            }
        }
        socket.destroy();

        const response = messages.find((item) => item.tag === 'G');
        const errors = messages.filter((item) => item.tag === 'E').map((item) => errorFields(item.payload));
        if (!response) throw new Error('the oracle sent no CopyInResponse');
        const columns = response.payload.readUInt16BE(1);
        return {
            copyInResponse: {
                format: response.payload.readUInt8(0),
                columns,
                columnFormats: Array.from({ length: columns }, (_, index) => response.payload.readUInt16BE(3 + index * 2)),
            },
            error: errors.length > 0 ? errors[0] : null,
            fatal: errors.length > 1 ? errors[errors.length - 1] : null,
        };
    } finally {
        await server.stop();
    }
}

function tail(output) {
    const lines = `${output}`.trimEnd().split(/\r?\n/);
    return lines.slice(-TAIL_LINES).join('\n');
}

// Stage floor verdicts run in `database.harness` through the napi primitive
// `harnessEvaluateGate`; the binding is loaded lazily because the native stage
// builds it on fresh checkouts.
let harnessBinding = null;
function loadHarnessBinding() {
    if (!harnessBinding) {
        harnessBinding = createRequire(import.meta.url)(
            path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${process.platform}-${process.arch}`),
        );
    }
    return harnessBinding;
}

function report(stage) {
    const { executed, skipped, failed } = stage.counts;
    const passed = Math.max(executed - failed - skipped, 0);
    const gate = JSON.parse(loadHarnessBinding().harnessEvaluateGate(JSON.stringify({
        suites: [
            {
                name: stage.name,
                tally: {
                    cases: executed,
                    assertions: 0,
                    attempts: executed,
                    passed,
                    failed,
                    skipped,
                    unverified: 0,
                    unavailable: 0,
                    timed_out: 0,
                    cancelled: 0,
                    crashed: 0,
                    not_run: 0,
                },
                floors: [{ metric: 'cases', min: stage.floor }],
                oracle: { required: false, available: false, provenance: null },
                baseline: 'none',
            },
        ],
        // The Rust stage only compiles the two binding crates, so it contributes
        // no cases by design (`stages/rust.mjs` documents the floor of 0). Every
        // other stage must still prove a non-empty suite.
        policy: { allow_partial: false, allow_skipped: false, allow_empty_suites: stage.name === 'rust', required_suites: [] },
    })));
    const ok = gate.ok;
    const byKind = new Map(gate.problems.map((problem) => [problem.kind, problem]));
    const reason = [];
    if (byKind.has('failed')) reason.push(`${byKind.get('failed').count} failed`);
    if (byKind.has('skipped')) reason.push(`${byKind.get('skipped').count} skipped`);
    if (byKind.has('floor-unmet')) reason.push(`${byKind.get('floor-unmet').actual} executed below floor ${byKind.get('floor-unmet').min}`);
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
        floor: 396,
    };
}

const command = process.argv[2] ?? 'test';
if (command !== 'test') {
    console.error(`unknown command '${command}'`);
    process.exit(2);
}

const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-results-'));
const copyInEvidence = await probeCopyIn();
const server = await startServer();
const env = {
    ...process.env,
    POSTGRES_TEST_HOST: '127.0.0.1',
    POSTGRES_TEST_PORT: String(server.port),
    POSTGRES_TEST_USER: 'postgres',
    POSTGRES_TEST_DATABASE: 'postgres',
    POSTGRES_RESULT_DIR: resultDir,
    POSTGRES_COPY_IN_EVIDENCE: JSON.stringify(copyInEvidence),
};

const stages = [];
try {
    stages.push(await runNative(repositoryRoot));
    stages.push(await runRust(repositoryRoot, env));
    stages.push(await runNodeSuite(repositoryRoot, harnessDir, env));
    stages.push(await runPythonSuite(repositoryRoot, harnessDir, env));
    stages.push(await runServerStage(repositoryRoot, harnessDir));
    stages.push(await runDurabilityStage(repositoryRoot, harnessDir));
    stages.push(await runDriversStage(repositoryRoot, harnessDir, env));
} finally {
    await server.stop();
}
stages.push(compare({ resultDir }));

const summary = stages.map(report);
const failed = summary.filter((stage) => !stage.ok);
console.log(JSON.stringify({ server: `127.0.0.1:${server.port}`, stages: summary, ok: failed.length === 0 }, null, 4));
process.exit(failed.length === 0 ? 0 : 1);
