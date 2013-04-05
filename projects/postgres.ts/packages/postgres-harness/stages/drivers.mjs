import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mustRun } from './process.mjs';

const FLOOR = 61;

function leaves(actual, expected, prefix, result) {
    if (Array.isArray(expected)) {
        const values = Array.isArray(actual) ? actual : [];
        const length = Math.max(expected.length, values.length);
        for (let index = 0; index < length; index += 1) {
            leaves(values[index], expected[index], `${prefix}[${index}]`, result);
        }
        return;
    }
    if (expected !== null && typeof expected === 'object') {
        const values = actual !== null && typeof actual === 'object' ? actual : {};
        const keys = new Set([...Object.keys(expected), ...Object.keys(values)]);
        for (const key of keys) leaves(values[key], expected[key], `${prefix}.${key}`, result);
        return;
    }
    result.executed += 1;
    if (actual !== expected) {
        result.failed += 1;
        if (result.lines.length < 20) {
            result.lines.push(`${prefix}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
        }
    }
}

/**
 * Runs the two real drivers in an isolated venv and compares their output with
 * the fixture captured from PostgreSQL 16.9. Missing psycopg or a failed
 * install fails the gate instead of skipping the stage.
 */
export async function runDriversStage(repositoryRoot, harnessDir, env) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-drivers-'));
    const python = process.env.POSTGRES_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const venv = path.join(root, 'venv');
    await mustRun(python, ['-m', 'venv', venv], { env, timeout: 120_000 });
    const venvPython =
        process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    await mustRun(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', path.join(harnessDir, 'tests', 'drivers', 'requirements.txt')],
        { env, timeout: 300_000 },
    );

    const driversDir = path.join(harnessDir, 'tests', 'drivers');
    const fixtureFile = path.join(harnessDir, 'fixtures', 'drivers-expected.json');
    const psycopgFile = path.join(root, 'psycopg.json');
    const nodeFile = path.join(root, 'node.json');
    const driverEnv = {
        ...env,
        DRIVER_HOST: env.POSTGRES_TEST_HOST,
        DRIVER_PORT: env.POSTGRES_TEST_PORT,
        DRIVER_USER: env.POSTGRES_TEST_USER,
        DRIVER_DATABASE: env.POSTGRES_TEST_DATABASE,
    };

    await mustRun(venvPython, [path.join(driversDir, 'psycopg_driver.py')], {
        env: { ...driverEnv, DRIVER_RESULT_FILE: psycopgFile },
        timeout: 120_000,
    });
    await mustRun('node', [path.join(driversDir, 'node_pg_driver.mjs')], {
        env: { ...driverEnv, DRIVER_RESULT_FILE: nodeFile },
        timeout: 120_000,
    });

    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const result = { executed: 0, failed: 0, lines: [] };
    leaves(JSON.parse(fs.readFileSync(psycopgFile, 'utf8')), fixture.psycopg, 'psycopg', result);
    leaves(JSON.parse(fs.readFileSync(nodeFile, 'utf8')), fixture.node_postgres, 'node', result);
    if (result.failed === 0) result.lines.push('drivers match the PostgreSQL 16.9 fixture');
    return {
        name: 'drivers',
        output: result.lines.join('\n'),
        counts: { executed: result.executed, skipped: 0, failed: result.failed },
        floor: FLOOR,
    };
}
