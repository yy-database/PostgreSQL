import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mustRun, run } from './process.mjs';

function venvCommand(venvDir, name) {
    const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    return path.join(venvDir, binDir, process.platform === 'win32' ? `${name}.exe` : name);
}

/**
 * Builds a wheel, installs it into a clean virtual environment, and runs the
 * same assertion corpus through the installed Python module.
 */
export async function runPythonSuite(repositoryRoot, harnessDir, env) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-wheel-'));
    const dist = path.join(root, 'dist');
    const venv = path.join(root, 'venv');
    const manifest = path.join(repositoryRoot, 'projects', 'postgres.rs', 'postgres-pyo3', 'Cargo.toml');

    await mustRun('python', ['-m', 'maturin', 'build', '--manifest-path', manifest, '--out', dist], {
        cwd: repositoryRoot,
        env,
    });
    await mustRun('python', ['-m', 'venv', venv], { cwd: repositoryRoot, env });

    const wheels = fs.readdirSync(dist).map((name) => path.join(dist, name));
    await mustRun(venvCommand(venv, 'pip'), ['install', '--no-input', '--disable-pip-version-check', ...wheels], {
        cwd: root,
        env,
    });

    const testsDir = path.join(harnessDir, 'tests', 'python');
    const resultFile = path.join(env.POSTGRES_RESULT_DIR, 'py.json');
    const pythonEnv = {
        ...env,
        POSTGRES_CASES_DIR: path.join(harnessDir, 'cases'),
        POSTGRES_RESULT_FILE: resultFile,
        POSTGRES_STORE_ROOT: path.join(root, 'stores'),
    };
    fs.mkdirSync(pythonEnv.POSTGRES_STORE_ROOT, { recursive: true });

    const result = await run(venvCommand(venv, 'python'), [path.join(testsDir, 'acceptance.py')], {
        cwd: testsDir,
        env: pythonEnv,
        timeout: 600_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    let summary = { executed: 0, skipped: 0, failed: 1 };
    try {
        summary = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch {
        // The suite crashed before writing its counters; the stage fails below.
    }
    const failed = summary.failed + (result.status === 0 ? 0 : 1);
    return {
        name: 'python',
        output,
        counts: { executed: summary.executed, skipped: summary.skipped ?? 0, failed },
        floor: 1018,
    };
}
