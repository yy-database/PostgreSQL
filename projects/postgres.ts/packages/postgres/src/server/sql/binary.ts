/** Decodes the binary parameter formats clients such as psycopg send on `Bind`. */

import { ServerError } from '../errors.ts';
import { formatValue, numericSpecial, typeFromOid, type DataType, type SqlValue } from './types.ts';

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

/** Days between 1970-01-01 and 2000-01-01, the epoch PostgreSQL timestamps use. */
const PG_EPOCH_DAYS = 10_957;

/** Proleptic-Gregorian days since 1970-01-01, Howard Hinnant's `days_from_civil`. */
function daysFromCivil(year: number, month: number, day: number): number {
    const y = year - (month <= 2 ? 1 : 0);
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

const TIMESTAMP_OUTPUT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Microseconds since 2000-01-01 00:00:00, with the zone offset folded into UTC. */
function timestampMicros(text: string): bigint {
    const match = TIMESTAMP_OUTPUT.exec(text);
    if (match === null) throw new ServerError('22P02', `invalid timestamp output "${text}"`);
    const days = BigInt(daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3])) - PG_EPOCH_DAYS);
    const seconds = BigInt(Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6]));
    const fraction = BigInt((match[7] ?? '.0').slice(1).padEnd(6, '0'));
    let micros = days * DAY_MICROS + seconds * 1_000_000n + fraction;
    const zone = match[8];
    if (zone !== undefined && zone !== 'Z') {
        const digits = zone.slice(1).replace(':', '');
        const offsetSeconds = BigInt(Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2) ?? 0) * 60);
        micros -= (zone[0] === '-' ? -1n : 1n) * offsetSeconds * 1_000_000n;
    }
    return micros;
}

function numericHeader(digits: number, weight: number, sign: number, scale: number, groups: number[]): Buffer {
    const buffer = Buffer.alloc(8 + groups.length * 2);
    buffer.writeInt16BE(digits, 0);
    buffer.writeInt16BE(weight, 2);
    buffer.writeUInt16BE(sign, 4);
    buffer.writeUInt16BE(scale, 6);
    for (let index = 0; index < groups.length; index += 1) buffer.writeInt16BE(groups[index]!, 8 + index * 2);
    return buffer;
}

/**
 * Encodes decimal text into PostgreSQL's base-10000 `numeric` wire form.
 *
 * `weight` is the power of 10000 of the first digit group, leading and trailing
 * zero groups are dropped, and the infinities carry the scale PostgreSQL does:
 * `NaN` reports `0`, the infinities report `32`.
 */
function encodeBinaryNumeric(text: string): Buffer {
    const special = numericSpecial(text);
    if (special === 'NaN') return numericHeader(0, 0, 0xc000, 0, []);
    if (special === 'Infinity') return numericHeader(0, 0, 0xd000, 32, []);
    if (special === '-Infinity') return numericHeader(0, 0, 0xf000, 32, []);
    const match = /^([+-]?)(\d+)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    const intDigits = match?.[2] ?? '';
    const fracDigits = match?.[3] ?? '';
    if (match === null || (intDigits === '' && fracDigits === '')) {
        throw new ServerError('22P02', `invalid numeric output "${text}"`);
    }
    const exponent = match[4] === undefined ? 0 : Number(match[4]);
    let digits = intDigits + fracDigits;
    let scale = fracDigits.length - exponent;
    if (scale < 0) {
        digits += '0'.repeat(-scale);
        scale = 0;
    }
    const integer = scale === 0 ? digits : digits.slice(0, digits.length - scale) || '0';
    const fraction = scale === 0 ? '' : digits.slice(digits.length - scale);
    const negative = match[1] === '-' && BigInt(digits) !== 0n;
    const groups: number[] = [];
    const intPadded = integer.padStart(Math.ceil(integer.length / 4) * 4, '0');
    for (let index = 0; index < intPadded.length; index += 4) groups.push(Number(intPadded.slice(index, index + 4)));
    const fracPadded = fraction.padEnd(Math.ceil(fraction.length / 4) * 4, '0');
    for (let index = 0; index < fracPadded.length; index += 4) groups.push(Number(fracPadded.slice(index, index + 4)));
    let weight = Math.ceil(integer.length / 4) - 1;
    while (groups.length > 0 && groups[0] === 0) {
        groups.shift();
        weight -= 1;
    }
    while (groups.length > 0 && groups[groups.length - 1] === 0) groups.pop();
    if (groups.length === 0) weight = 0;
    return numericHeader(groups.length, weight, negative ? 0x4000 : 0, scale, groups);
}

/**
 * Encodes one result value in the binary `DataRow` format for `type`.
 *
 * `NULL` becomes `null`, which the frame layer renders as a `-1` length. Every
 * scalar PostgreSQL sends as bytes gets its own branch; text-like types, the
 * catalog vectors and arrays carry their textual form as raw UTF-8.
 */
export function encodeBinaryValue(value: SqlValue, type: DataType): Buffer | null {
    if (value === null) return null;
    const text = formatValue(value, type) ?? '';
    switch (type.key) {
        case 'bool':
            return Buffer.from([text === 't' ? 1 : 0]);
        case 'int2': {
            const buffer = Buffer.alloc(2);
            buffer.writeInt16BE(Number(text));
            return buffer;
        }
        case 'int4': {
            const buffer = Buffer.alloc(4);
            buffer.writeInt32BE(Number(text));
            return buffer;
        }
        case 'int8': {
            const buffer = Buffer.alloc(8);
            buffer.writeBigInt64BE(BigInt(text));
            return buffer;
        }
        case 'float4': {
            const buffer = Buffer.alloc(4);
            buffer.writeFloatBE(Number(text));
            return buffer;
        }
        case 'float8': {
            const buffer = Buffer.alloc(8);
            buffer.writeDoubleBE(Number(text));
            return buffer;
        }
        case 'numeric':
            return encodeBinaryNumeric(text);
        case 'bytea': {
            const hex = /^\\x([0-9a-fA-F]*)$/.exec(text);
            return hex === null ? Buffer.from(text, 'utf8') : Buffer.from(hex[1]!, 'hex');
        }
        case 'uuid':
            return Buffer.from(text.replace(/-/g, ''), 'hex');
        case 'date': {
            const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
            if (match === null) throw new ServerError('22P02', `invalid date output "${text}"`);
            const buffer = Buffer.alloc(4);
            buffer.writeInt32BE(daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3])) - PG_EPOCH_DAYS);
            return buffer;
        }
        case 'timestamp': {
            const buffer = Buffer.alloc(8);
            buffer.writeBigInt64BE(timestampMicros(text.replace(/\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/, '')));
            return buffer;
        }
        case 'timestamptz': {
            const buffer = Buffer.alloc(8);
            buffer.writeBigInt64BE(timestampMicros(text));
            return buffer;
        }
        case 'oid':
        case 'regclass':
        case 'regtype':
        case 'regnamespace':
        case 'regproc':
        case 'regprocedure':
        case 'regoperator':
        case 'regdictionary':
        case 'regconfig':
        case 'regrole': {
            if (/^\d+$/.test(text)) {
                const buffer = Buffer.alloc(4);
                buffer.writeUInt32BE(Number(text));
                return buffer;
            }
            return Buffer.from(text, 'utf8');
        }
        default:
            return Buffer.from(text, 'utf8');
    }
}
