/**
 * Worker-thread host for one local engine assembly.
 *
 * The native protocol client is synchronous, so an in-process engine could
 * never answer it: the calling thread is the engine's event loop. The engine
 * therefore runs here, on its own thread, and the main thread talks to it
 * through the same protocol primitives it would use against any server.
 */

import { parentPort } from 'node:worker_threads';

import { createPostgresAssembly, type PostgresAssembly, type PostgresEndpointHandle, type PostgresServerOptions } from './server/server.ts';

const port = parentPort;
if (port === null) throw new Error('the engine worker needs a parent port');

interface Request {
    id: number;
    op: 'open' | 'serve' | 'closeEndpoint' | 'close';
    dataDir?: string;
    options?: PostgresServerOptions;
    key?: string;
}

let assembly: PostgresAssembly | null = null;
const endpoints = new Map<string, PostgresEndpointHandle>();

port.on('message', async (request: Request) => {
    const reply = (payload: Record<string, unknown>): void => {
        port.postMessage({ id: request.id, ...payload });
    };
    try {
        if (request.op === 'open') {
            if (assembly !== null) throw new Error('the engine assembly is already open');
            assembly = createPostgresAssembly(request.dataDir ?? '');
            const endpoint = await assembly.serve(request.options ?? {});
            endpoints.set('internal', endpoint);
            reply({ ok: true, host: endpoint.host, port: endpoint.port });
            return;
        }
        if (request.op === 'serve') {
            if (assembly === null) throw new Error('the engine assembly is not open');
            const endpoint = await assembly.serve(request.options ?? {});
            endpoints.set(request.key ?? '', endpoint);
            reply({ ok: true, host: endpoint.host, port: endpoint.port });
            return;
        }
        if (request.op === 'closeEndpoint') {
            const endpoint = endpoints.get(request.key ?? '');
            endpoints.delete(request.key ?? '');
            await endpoint?.close();
            reply({ ok: true });
            return;
        }
        if (request.op === 'close') {
            endpoints.clear();
            await assembly?.close();
            assembly = null;
            reply({ ok: true });
            return;
        }
        throw new Error(`unknown engine worker request "${request.op}"`);
    } catch (error) {
        reply({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
});
