import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

async function findFreePort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

/**
 * Starts a real PostgreSQL core (PGlite) behind the protocol-v3 wire.
 * The suite talks to it exactly like an external server.
 */
export async function startServer() {
    const port = await findFreePort();
    const db = new PGlite();
    await db.waitReady;
    const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 8 });
    await server.start();
    return {
        port,
        async stop() {
            await server.stop();
            await db.close();
        },
    };
}
