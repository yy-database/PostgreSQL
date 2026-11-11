/**
 * SCRAM-SHA-256 server-side primitives (RFC 5802 / RFC 7677), built only on
 * `node:crypto`. The stored secret keeps the shape PostgreSQL writes into
 * `pg_authid.rolpassword`: `SCRAM-SHA-256$<iterations>:<base64 salt>$<hex
 * StoredKey>:<hex ServerKey>`. Cleartext passwords never reach storage.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** The iteration count PostgreSQL 16 derives with by default. */
export const SCRAM_ITERATIONS = 4096;

/** The gs2 header of a no-channel-binding client-first message, as the client echoes it in `c=`. */
export const SCRAM_CHANNEL_BINDING_NO = 'biws';

function hmac(key: Buffer, data: string): Buffer {
    return createHmac('sha256', key).update(data).digest();
}

function sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
}

/** One parsed `SCRAM-SHA-256` stored secret. */
export interface ScramSecret {
    iterations: number;
    salt: Buffer;
    storedKey: Buffer;
    serverKey: Buffer;
}

/** Derives one stored secret from a cleartext password, the way `CREATE ROLE ... PASSWORD` does. */
export function deriveScramSecret(password: string, iterations = SCRAM_ITERATIONS): ScramSecret {
    const salt = randomBytes(16);
    const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    return {
        iterations,
        salt,
        storedKey: sha256(hmac(saltedPassword, 'Client Key')),
        serverKey: hmac(saltedPassword, 'Server Key'),
    };
}

/** Renders one secret the way PostgreSQL writes it into `pg_authid.rolpassword`. */
export function formatScramVerifier(secret: ScramSecret): string {
    return `SCRAM-SHA-256$${secret.iterations}:${secret.salt.toString('base64')}$${secret.storedKey.toString('hex')}:${secret.serverKey.toString('hex')}`;
}

/** Reads one verifier back; `null` for anything that is not a well-formed SCRAM-SHA-256 verifier. */
export function parseScramVerifier(text: string): ScramSecret | null {
    const match = /^SCRAM-SHA-256\$(\d+):([^$]*)\$([0-9a-f]{64}):([0-9a-f]{64})$/.exec(text);
    if (match === null) return null;
    const iterations = Number(match[1]);
    if (!Number.isSafeInteger(iterations) || iterations <= 0) return null;
    const salt = Buffer.from(match[2] ?? '', 'base64');
    return {
        iterations,
        salt,
        storedKey: Buffer.from(match[3] ?? '', 'hex'),
        serverKey: Buffer.from(match[4] ?? '', 'hex'),
    };
}

/**
 * One SCRAM nonce part: printable ASCII without `,` or `=`, which hex supplies
 * without any filtering.
 */
export function scramNonce(bytes = 18): string {
    return randomBytes(bytes).toString('hex');
}

/** Splits one comma-separated SCRAM message into its `k=v` fields. */
export function scramFields(message: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const part of message.split(',')) {
        const index = part.indexOf('=');
        if (index > 0) fields.set(part.slice(0, index), part.slice(index + 1));
    }
    return fields;
}

/**
 * Verifies one `ClientProof`: the key it XORs out of `ClientSignature` must
 * hash to the stored `StoredKey`, which is what PBKDF2 committed to.
 */
export function scramClientProofValid(secret: ScramSecret, authMessage: string, proofBase64: string): boolean {
    const proof = Buffer.from(proofBase64, 'base64');
    if (proof.toString('base64') !== proofBase64 || proof.length !== secret.storedKey.length) return false;
    const clientSignature = hmac(secret.storedKey, authMessage);
    const clientKey = Buffer.alloc(proof.length);
    for (let index = 0; index < proof.length; index += 1) clientKey[index] = (proof[index] ?? 0) ^ (clientSignature[index] ?? 0);
    return timingSafeEqual(sha256(clientKey), secret.storedKey);
}

/** The `v=` payload of the server-final message. */
export function scramServerSignature(secret: ScramSecret, authMessage: string): string {
    return hmac(secret.serverKey, authMessage).toString('base64');
}
