/** Decodes the binary parameter formats clients such as psycopg send on `Bind`. */

import { ServerError } from '../errors.ts';
import { typeFromOid, type SqlValue } from './types.ts';

const PG_EPOCH_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;
const DAY_MICROS = 86_400_000_000n;

/** PostgreSQL's `22P03`: the bytes do not match the declared type's binary format. */
function bad(message: string): ServerError {
    return new ServerError('22P03', message, 'incorrect binary data format');
}

function expectLength(buffer: Buffer, length: number): void {
    if (buffer.length !== length) throw bad(`expected ${length} bytes, received ${buffer.length}`);
}

function pad(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

function formatDate(days: number): string {
    const date = new Date(PG_EPOCH_MS + days * DAY_MS);
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function formatTimestamp(microseconds: bigint): string {
    let days = microseconds / DAY_MICROS;
    let rest = microseconds % DAY_MICROS;
    if (rest < 0n) {
        days -= 1n;
        rest += DAY_MICROS;
    }
    const seconds = Number(rest / 1_000_000n);
    const fraction = Number(rest % 1_000_000n);
    const text = `${formatDate(Number(days))} ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    if (fraction === 0) return text;
    return `${text}.${pad(fraction, 6).replace(/0+$/, '')}`;
}

function decodeUuid(buffer: Buffer): string {
    const hex = buffer.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Decodes PostgreSQL's base-10000 `numeric` representation.
 *
 * Each digit group is four decimal places and `weight` is the power of 10000
 * of the first group, so a negative weight starts inside the fraction.
 */
function decodeNumeric(buffer: Buffer): string {
    if (buffer.length < 8) throw bad('numeric payload is shorter than its header');
    const digits = buffer.readInt16BE(0);
    const weight = buffer.readInt16BE(2);
    const sign = buffer.readUInt16BE(4);
    const scale = buffer.readInt16BE(6);
    if (buffer.length !== 8 + digits * 2) throw bad(`numeric payload should hold ${digits} digits`);
    if (sign === 0xc000) return 'NaN';
    if (sign === 0xd000) return 'Infinity';
    if (sign === 0xf000) return '-Infinity';
    if (sign !== 0x0000 && sign !== 0x4000) throw bad(`unknown numeric sign 0x${sign.toString(16)}`);
    const groups: string[] = [];
    for (let index = 0; index < digits; index += 1) {
        const digit = buffer.readInt16BE(8 + index * 2);
        if (digit < 0 || digit > 9999) throw bad(`numeric digit ${digit} is out of range`);
        groups.push(String(digit));
    }
    let integer = '';
    let fraction = '';
    if (weight >= 0) {
        integer = groups[0] ?? '0';
        for (let index = 1; index <= weight; index += 1) integer += (groups[index] ?? '0').padStart(4, '0');
        for (let index = weight + 1; index < groups.length; index += 1) fraction += (groups[index] ?? '0').padStart(4, '0');
    } else {
        fraction = '0000'.repeat(-weight - 1) + groups.map((group) => group.padStart(4, '0')).join('');
    }
    integer = integer.replace(/^0+/, '') || '0';
    fraction = fraction.padEnd(scale, '0').slice(0, scale);
    const body = scale > 0 ? `${integer}.${fraction}` : integer;
    return sign === 0x4000 ? `-${body}` : body;
}

/** Renders one array element back to the text literal the SQL layer consumes. */
function elementText(oid: number, buffer: Buffer): string {
    if (oid === 16) return buffer[0] === 0 ? 'f' : 't';
    if (oid === 17) return `\\x${buffer.toString('hex')}`;
    if (oid === 20) {
        expectLength(buffer, 8);
        return String(buffer.readBigInt64BE(0));
    }
    if (oid === 21) {
        expectLength(buffer, 2);
        return String(buffer.readInt16BE(0));
    }
    if (oid === 23) {
        expectLength(buffer, 4);
        return String(buffer.readInt32BE(0));
    }
    if (oid === 26 || oid === 24 || oid === 2205 || oid === 2206 || oid === 4089) {
        expectLength(buffer, 4);
        return String(buffer.readUInt32BE(0));
    }
    if (oid === 700) {
        expectLength(buffer, 4);
        return String(buffer.readFloatBE(0));
    }
    if (oid === 701) {
        expectLength(buffer, 8);
        return String(buffer.readDoubleBE(0));
    }
    if (oid === 1700) return decodeNumeric(buffer);
    if (oid === 1082) {
        expectLength(buffer, 4);
        return formatDate(buffer.readInt32BE(0));
    }
    if (oid === 1114 || oid === 1184) {
        expectLength(buffer, 8);
        return formatTimestamp(buffer.readBigInt64BE(0));
    }
    if (oid === 2950) {
        expectLength(buffer, 16);
        return decodeUuid(buffer);
    }
    // Text-like elements stay raw here; they are quoted later only when they
    // contain array syntax characters.
    return buffer.toString('utf8');
}

function needsQuotes(text: string): boolean {
    if (text.length === 0 || /^(?:null)$/i.test(text)) return true;
    return /[{}",\\\s]/.test(text);
}

function quoteElement(text: string): string {
    return needsQuotes(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

/** Expands a (possibly multi-dimensional) binary array into its text literal. */
function decodeArray(buffer: Buffer): string {
    if (buffer.length < 12) throw bad('array payload is shorter than its header');
    const dimensions = buffer.readInt32BE(0);
    const flags = buffer.readInt32BE(4);
    const elementOid = buffer.readUInt32BE(8);
    if (dimensions < 0) throw bad(`array has ${dimensions} dimensions`);
    let offset = 12;
    const lengths: number[] = [];
    for (let index = 0; index < dimensions; index += 1) {
        if (offset + 8 > buffer.length) throw bad('array header ends before its dimensions');
        const length = buffer.readInt32BE(offset);
        offset += 8;
        if (length < 0) throw bad(`array dimension ${index} has negative length`);
        lengths.push(length);
    }
    const total = lengths.reduce((product, length) => product * length, 1);
    const values: (string | null)[] = [];
    for (let index = 0; index < total; index += 1) {
        if (offset + 4 > buffer.length) throw bad('array payload ends before its last element');
        const length = buffer.readInt32BE(offset);
        offset += 4;
        if (length < 0) {
            if ((flags & 1) === 0) throw bad('array declares no nulls but holds one');
            values.push(null);
            continue;
        }
        if (offset + length > buffer.length) throw bad('array element runs past the payload');
        values.push(elementText(elementOid, buffer.subarray(offset, offset + length)));
        offset += length;
    }
    if (offset !== buffer.length) throw bad('array payload has trailing bytes');
    if (dimensions === 0) return '{}';
    let position = 0;
    const build = (dimension: number): string => {
        const parts: string[] = [];
        const length = lengths[dimension] ?? 0;
        for (let index = 0; index < length; index += 1) {
            if (dimension + 1 < dimensions) parts.push(build(dimension + 1));
            else {
                const value = values[position] ?? null;
                position += 1;
                parts.push(value === null ? 'NULL' : quoteElement(value));
            }
        }
        return `{${parts.join(',')}}`;
    };
    return build(0);
}

/**
 * Decodes one binary parameter value.
 *
 * The declared OID decides the layout; arrays carry their element type in the
 * payload and are handed to the SQL layer as a text literal.
 */
export function decodeBinaryParameter(buffer: Buffer, typeOidValue: number): SqlValue {
    switch (typeOidValue) {
        case 16:
            expectLength(buffer, 1);
            return buffer[0] !== 0;
        case 17:
            return `\\x${buffer.toString('hex')}`;
        case 18:
        case 19:
        case 25:
        case 1042:
        case 1043:
            return buffer.toString('utf8');
        case 20: {
            expectLength(buffer, 8);
            const value = buffer.readBigInt64BE(0);
            return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
        }
        case 21:
            expectLength(buffer, 2);
            return buffer.readInt16BE(0);
        case 23:
            expectLength(buffer, 4);
            return buffer.readInt32BE(0);
        case 26:
        case 2205:
        case 2206:
        case 24:
        case 4089:
            expectLength(buffer, 4);
            return buffer.readUInt32BE(0);
        case 700:
            expectLength(buffer, 4);
            return buffer.readFloatBE(0);
        case 701:
            expectLength(buffer, 8);
            return buffer.readDoubleBE(0);
        case 1700:
            return decodeNumeric(buffer);
        case 1082:
            expectLength(buffer, 4);
            return formatDate(buffer.readInt32BE(0));
        case 1114:
            expectLength(buffer, 8);
            return formatTimestamp(buffer.readBigInt64BE(0));
        case 1184:
            expectLength(buffer, 8);
            return `${formatTimestamp(buffer.readBigInt64BE(0))}+00`;
        case 2950:
            expectLength(buffer, 16);
            return decodeUuid(buffer);
        case 1000:
        case 1002:
        case 1003:
        case 1005:
        case 1007:
        case 1009:
        case 1014:
        case 1015:
        case 1016:
        case 1021:
        case 1022:
        case 1028:
        case 1115:
        case 1182:
        case 1185:
        case 1231:
        case 2951:
            return decodeArray(buffer);
        default: {
            const named = typeFromOid(typeOidValue);
            throw new ServerError(
                '0A000',
                'feature not supported',
                named === undefined
                    ? `binary parameter type ${typeOidValue} is not implemented`
                    : `binary parameter type ${named.key} is not implemented`,
            );
        }
    }
}
