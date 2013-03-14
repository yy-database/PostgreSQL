/**
 * Oracle runtime for `sql-diff.mjs`.
 *
 * Runs in its own process on purpose: the native client blocks its thread while
 * it waits for a reply, so the socket server and the oracle both need their own
 * event loop. The runtime hosts two independent PGlite instances:
 *
 * - `oracle` answers expectations through `execProtocolRaw`, decoded here by an
 *   independent protocol reader, so no expectation passes through this
 *   repository's decoder.
 * - `server` sits behind `PGLiteSocketServer`; the repository client connects to
 *   it exactly like the acceptance harness does.
 *
 * Both instances receive the same statements in the same order, so their state
 * stays in step while the driver compares one reply with the other.
 */
import net from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const SESSION_SETTINGS = [
    "SET TimeZone = 'UTC'",
    "SET DateStyle = 'ISO, MDY'",
    "SET IntervalStyle = 'postgres'",
    "SET byte_output = 'hex'",
];

function i32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
}

function frame(tag, payload) {
    return Buffer.concat([Buffer.from(tag), i32(payload.length + 4), payload]);
}

function queryBytes(sql) {
    return frame('Q', Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])]));
}

function parsePayloads(buffer) {
    const messages = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
        const tag = String.fromCharCode(buffer[offset]);
        const length = buffer.readInt32BE(offset + 1);
        if (length < 4 || offset + 1 + length > buffer.length) break;
        messages.push({ tag, payload: buffer.subarray(offset + 5, offset + 1 + length) });
        offset += 1 + length;
    }
    return messages;
}

function cstrings(payload) {
    const values = [];
    let start = 0;
    for (let index = 0; index < payload.length; index += 1) {
        if (payload[index] === 0) {
            values.push(payload.subarray(start, index).toString('utf8'));
            start = index + 1;
        }
    }
    return values;
}

function columnNames(payload) {
    if (payload.length < 2) throw new Error('truncated RowDescription');
    const count = payload.readUInt16BE(0);
    const names = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const end = payload.indexOf(0, offset);
        if (end < 0) throw new Error('truncated column description');
        names.push(payload.subarray(offset, end).toString('utf8'));
        offset = end + 1 + 18;
    }
    return names;
}

function dataRow(payload, columns) {
    const count = payload.readUInt16BE(0);
    if (count !== columns) throw new Error(`DataRow carries ${count} values for ${columns} columns`);
    const values = [];
    let offset = 2;
    for (let index = 0; index < count; index += 1) {
        const length = payload.readInt32BE(offset);
        offset += 4;
        if (length < 0) values.push(null);
        else {
            values.push(payload.subarray(offset, offset + length).toString('utf8'));
            offset += length;
        }
    }
    return values;
}

function errorFields(payload) {
    const fields = {};
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
        const kind = String.fromCharCode(payload[offset]);
        offset += 1;
        const end = payload.indexOf(0, offset);
        if (end < 0) break;
        fields[kind] = payload.subarray(offset, end).toString('utf8');
        offset = end + 1;
    }
    return fields;
}

/** Same fields as `errorFields`, kept as `[kind, value]` in wire order. */
function orderedFields(payload) {
    const fields = [];
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
        const kind = String.fromCharCode(payload[offset]);
        offset += 1;
        const end = payload.indexOf(0, offset);
        if (end < 0) break;
        fields.push([kind, payload.subarray(offset, end).toString('utf8')]);
        offset = end + 1;
    }
    return fields;
}

/** Decodes one simple-query reply using the protocol chapter, not this repo. */
function decodeReply(bytes) {
    const messages = parsePayloads(Buffer.from(bytes));
    const results = [];
    const notices = [];
    const tags = [];
    let current = null;
    let error = null;
    for (const message of messages) {
        tags.push(message.tag);
        switch (message.tag) {
            case 'T':
                current = { columns: columnNames(message.payload), rows: [] };
                break;
            case 'n':
                current = { columns: [], rows: [] };
                break;
            case 'D':
                if (!current) throw new Error('DataRow without RowDescription');
                current.rows.push(dataRow(message.payload, current.columns.length));
                break;
            case 'C':
                results.push({ ...(current ?? { columns: [], rows: [] }), tag: cstrings(message.payload)[0] ?? '' });
                current = null;
                break;
            case 'I':
                current = null;
                break;
            case 'E': {
                const fields = errorFields(message.payload);
                error = {
                    code: fields.C ?? 'unknown',
                    message: fields.M ?? '',
                    fields,
                    ordered: orderedFields(message.payload),
                    raw: message.payload.toString('hex'),
                };
                break;
            }
            case 'N':
                notices.push({
                    fields: errorFields(message.payload),
                    ordered: orderedFields(message.payload),
                    raw: message.payload.toString('hex'),
                });
                break;
            default:
                break;
        }
    }
    // The whole reply is kept as bytes so a gate failure can print exactly what
    // PGlite sent, not a re-serialized copy of the decoded fields.
    return { results, error, notices, tags, raw: Buffer.from(bytes).toString('hex') };
}

async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

const oracle = new PGlite();
const serverDb = new PGlite();
await Promise.all([oracle.waitReady, serverDb.waitReady]);

// Boundary probes deliberately abort mid-protocol (COPY, notifications). The
// socket server surfaces those aborts as unhandled socket errors; keep the
// runtime alive so the remaining probes and the report still complete.
process.on('uncaughtException', (error) => {
    console.error(`[sql-diff-runtime] ignored abort: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[sql-diff-runtime] ignored rejection: ${reason}`);
});

for (const setting of SESSION_SETTINGS) {
    await oracle.execProtocolRaw(queryBytes(setting));
}

const port = await freePort();
const server = new PGLiteSocketServer({ db: serverDb, port, host: '127.0.0.1', maxConnections: 4 });
await server.start();

async function run(sql) {
    try {
        return decodeReply(await oracle.execProtocolRaw(queryBytes(sql)));
    } catch (error) {
        return { results: [], error: { code: 'client', message: `${error.message}`, fields: {} }, notices: [], tags: [], raw: null };
    }
}

process.on('message', async (message) => {
    if (message.op === 'ready') {
        process.send({ id: message.id, result: { port } });
        return;
    }
    if (message.op === 'query') {
        process.send({ id: message.id, result: await run(message.sql) });
        return;
    }
    if (message.op === 'shutdown') {
        await server.stop();
        await oracle.close();
        await serverDb.close();
        process.exit(0);
    }
});

process.send({ type: 'listening', port });
