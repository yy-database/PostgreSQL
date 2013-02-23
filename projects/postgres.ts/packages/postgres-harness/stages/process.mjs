import { spawn } from 'node:child_process';

/** Runs one command without blocking the event loop, so the in-process server keeps serving. */
export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            ...options,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });
}

/** Runs a command and throws with captured output when it fails. */
export async function mustRun(command, args, options = {}) {
    const result = await run(command, args, options);
    if (result.status !== 0) {
        throw Object.assign(new Error(`${command} ${args.join(' ')} failed`), {
            output: `${result.stdout}${result.stderr}`,
        });
    }
    return result;
}
