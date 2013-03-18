#!/usr/bin/env node
import { startPostgresServer } from '../dist/server/server.js';

const options = { port: 5432, host: '127.0.0.1', user: 'postgres', database: 'postgres', auth: 'trust' };
for (let index = 2; index < process.argv.length; index += 1) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (flag === '--host' && value) options.host = value;
    else if (flag === '--port' && value) options.port = Number(value);
    else if (flag === '--user' && value) options.user = value;
    else if (flag === '--database' && value) options.database = value;
    else if (flag === '--password' && value) options.auth = { password: value };
    else if (flag === '--data-dir' && value) options.dataDir = value;
    else continue;
    index += 1;
}

let server;
try {
    server = await startPostgresServer(options);
} catch (error) {
    console.error(`postgres-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
console.log(
    `listening on ${server.host}:${server.port} (auth ${options.auth === 'trust' ? 'trust' : 'password'}, data ${server.dataDir})`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close().then(() => process.exit(0));
    });
}
