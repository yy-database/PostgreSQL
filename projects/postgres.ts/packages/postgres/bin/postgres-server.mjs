#!/usr/bin/env node
import { startPostgresServer } from '../dist/server/server.js';

const options = { port: 5432, host: '127.0.0.1', user: 'postgres', database: 'postgres', auth: 'trust' };
let authMethod = 'trust';
let password;
let stopOnStdinClose = false;
for (let index = 2; index < process.argv.length; index += 1) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (flag === '--host' && value) options.host = value;
    else if (flag === '--port' && value) options.port = Number(value);
    else if (flag === '--user' && value) options.user = value;
    else if (flag === '--database' && value) options.database = value;
    else if (flag === '--auth' && value) authMethod = value;
    else if (flag === '--password' && value) password = value;
    else if (flag === '--data-dir' && value) options.dataDir = value;
    else if (flag === '--stop-on-stdin-close') stopOnStdinClose = true;
    else continue;
    index += 1;
}
if (authMethod !== 'trust') {
    if (!['password', 'md5', 'scram-sha-256'].includes(authMethod)) {
        console.error(`postgres-server: unknown auth "${authMethod}", use trust, password, md5 or scram-sha-256`);
        process.exit(2);
    }
    if (!password) {
        console.error(`postgres-server: auth "${authMethod}" requires --password`);
        process.exit(2);
    }
    options.auth = { method: authMethod, password, user: options.user };
}

let server;
try {
    server = await startPostgresServer(options);
} catch (error) {
    console.error(`postgres-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
const authMode = options.auth === 'trust' ? 'trust' : options.auth.method;
console.log(`listening on ${server.host}:${server.port} (auth ${authMode}, data ${server.dataDir})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close().then(() => process.exit(0));
    });
}

if (stopOnStdinClose) {
    // A closed stdin is the shutdown trigger for supervisors and harnesses
    // that cannot deliver a real signal (Windows `TerminateProcess` would be
    // a hard kill and leave `postmaster.pid` behind).
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        server.close().then(() => process.exit(0));
    };
    process.stdin.resume();
    process.stdin.on('end', stop);
    process.stdin.on('close', stop);
}
