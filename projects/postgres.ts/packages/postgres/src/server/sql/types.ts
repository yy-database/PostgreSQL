/** PostgreSQL scalar types, literal parsing, casts and text formatting. */

import { ServerError } from '../errors.ts';

export type SqlValue = null | string | number | boolean;

/** Every type key this batch understands. */
export type TypeKey =
    | 'bool'
    | 'int2'
    | 'int4'
    | 'int8'
    | 'float4'
    | 'float8'
    | 'numeric'
    | 'text'
    | 'varchar'
    | 'bpchar'
    | 'name'
    | 'char'
    | 'oid'
    | 'regclass'
    | 'regtype'
    | 'regnamespace'
    | 'regproc'
    | 'date'
    | 'timestamp'
    | 'timestamptz'
    | 'uuid'
    | 'pg_node_tree'
    | 'int2vector'
    | 'oidvector'
    | 'int2_array'
    | 'int4_array'
    | 'int8_array'
    | 'oid_array'
    | 'text_array'
    | 'char_array'
    | 'bool_array'
    | 'float4_array'
    | 'float8_array';

export interface DataType {
    readonly key: TypeKey;
    /** `atttypmod`; `-1` when the type carries no modifier. */
    readonly typmod: number;
}

interface TypeInfo {
    oid: number;
    typlen: number;
}

const TYPE_INFO: Record<TypeKey, TypeInfo> = {
    bool: { oid: 16, typlen: 1 },
    int2: { oid: 21, typlen: 2 },
    int4: { oid: 23, typlen: 4 },
    int8: { oid: 20, typlen: 8 },
    float4: { oid: 700, typlen: 4 },
    float8: { oid: 701, typlen: 8 },
    numeric: { oid: 1700, typlen: -1 },
    text: { oid: 25, typlen: -1 },
    varchar: { oid: 1043, typlen: -1 },
    bpchar: { oid: 1042, typlen: -1 },
    name: { oid: 19, typlen: 64 },
    char: { oid: 18, typlen: 1 },
    oid: { oid: 26, typlen: 4 },
    regclass: { oid: 2205, typlen: 4 },
    regtype: { oid: 2206, typlen: 4 },
    regnamespace: { oid: 4089, typlen: 4 },
    regproc: { oid: 24, typlen: 4 },
    date: { oid: 1082, typlen: 4 },
    timestamp: { oid: 1114, typlen: 8 },
    timestamptz: { oid: 1184, typlen: 8 },
    uuid: { oid: 2950, typlen: 16 },
    pg_node_tree: { oid: 194, typlen: -1 },
    int2vector: { oid: 22, typlen: -1 },
    oidvector: { oid: 30, typlen: -1 },
    int2_array: { oid: 1005, typlen: -1 },
    int4_array: { oid: 1007, typlen: -1 },
    int8_array: { oid: 1016, typlen: -1 },
    oid_array: { oid: 1028, typlen: -1 },
    text_array: { oid: 1009, typlen: -1 },
    char_array: { oid: 1002, typlen: -1 },
    bool_array: { oid: 1000, typlen: -1 },
    float4_array: { oid: 1021, typlen: -1 },
    float8_array: { oid: 1022, typlen: -1 },
};

export function typeOf(key: TypeKey, typmod = -1): DataType {
    return { key, typmod };
}

export const TEXT = typeOf('text');
export const INT4 = typeOf('int4');
export const BOOL = typeOf('bool');
export const OID = typeOf('oid');
export const NAME = typeOf('name');

export function typeOid(type: DataType): number {
    return TYPE_INFO[type.key].oid;
}

export function typeLength(type: DataType): number {
    return TYPE_INFO[type.key].typlen;
}

/** Wraps a type in `[]`. */
export function arrayOf(type: DataType): DataType {
    switch (type.key) {
        case 'int2':
            return typeOf('int2_array');
        case 'int4':
            return typeOf('int4_array');
        case 'int8':
            return typeOf('int8_array');
        case 'oid':
        case 'regclass':
        case 'regtype':
            return typeOf('oid_array');
        case 'char':
            return typeOf('char_array');
        case 'bool':
            return typeOf('bool_array');
        case 'float4':
            return typeOf('float4_array');
        case 'float8':
            return typeOf('float8_array');
        default:
            return typeOf('text_array');
    }
}

/** The name `format_type` renders for one type. */
export function formatType(type: DataType): string {
    switch (type.key) {
        case 'bool':
            return 'boolean';
        case 'int2':
            return 'smallint';
        case 'int4':
            return 'integer';
        case 'int8':
            return 'bigint';
        case 'float4':
            return 'real';
        case 'float8':
            return 'double precision';
        case 'numeric':
            if (type.typmod > 0) {
                const { precision, scale } = numericPrecisionScale(type.typmod);
                return `numeric(${precision},${scale})`;
            }
            return 'numeric';
        case 'text':
            return 'text';
        case 'varchar':
            return type.typmod > 0 ? `character varying(${type.typmod - 4})` : 'character varying';
        case 'bpchar':
            return type.typmod > 0 ? `character(${type.typmod - 4})` : 'character';
        case 'name':
            return 'name';
        case 'char':
            return '"char"';
        case 'oid':
            return 'oid';
        case 'regclass':
            return 'regclass';
        case 'regtype':
            return 'regtype';
        case 'regnamespace':
            return 'regnamespace';
        case 'regproc':
            return 'regproc';
        case 'date':
            return 'date';
        case 'timestamp':
            return 'timestamp without time zone';
        case 'timestamptz':
            return 'timestamp with time zone';
        case 'uuid':
            return 'uuid';
        case 'pg_node_tree':
            return 'pg_node_tree';
        case 'int2vector':
            return 'int2vector';
        case 'oidvector':
            return 'oidvector';
        case 'int2_array':
            return 'smallint[]';
        case 'int4_array':
            return 'integer[]';
        case 'int8_array':
            return 'bigint[]';
        case 'oid_array':
            return 'oid[]';
        case 'text_array':
            return 'text[]';
        case 'char_array':
            return '"char"[]';
        case 'bool_array':
            return 'boolean[]';
        case 'float4_array':
            return 'real[]';
        case 'float8_array':
            return 'double precision[]';
    }
}

/** Encodes `numeric(p,s)` the way `atttypmod` stores it. */
export function numericTypmod(precision: number, scale: number): number {
    return ((precision << 16) | (scale & 0xffff)) + 4;
}

/** Decodes `numeric` precision and scale out of `atttypmod`. */
export function numericPrecisionScale(typmod: number): { precision: number; scale: number } {
    const raw = typmod - 4;
    return { precision: (raw >> 16) & 0xffff, scale: raw & 0x7ff };
}

/** Resolves a type name, including its array suffix and modifier. */
export function typeFromName(parts: string[], modifiers: number[]): DataType {
    const base = parts.map((part) => part.toLowerCase()).join(' ');
    const bare = parts[parts.length - 1]?.toLowerCase() ?? '';
    const typmod = base === 'numeric' || base === 'decimal'
        ? (modifiers.length > 0 ? numericTypmod(modifiers[0] ?? 1, modifiers[1] ?? 0) : -1)
        : modifiers.length > 0 ? (modifiers[0] ?? -1) + 4 : -1;
    switch (base) {
        case 'smallint':
        case 'int2':
            return typeOf('int2');
        case 'integer':
        case 'int':
        case 'int4':
            return typeOf('int4');
        case 'bigint':
        case 'int8':
            return typeOf('int8');
        case 'real':
        case 'float4':
            return typeOf('float4');
        case 'double precision':
        case 'float8':
            return typeOf('float8');
        case 'numeric':
        case 'decimal':
            if (modifiers.length > 0 && ((modifiers[0] ?? 0) < 1 || (modifiers[0] ?? 0) > 1000)) {
                throw new ServerError('22023', `NUMERIC precision ${modifiers[0]} must be between 1 and 1000`);
            }
            return typeOf('numeric', typmod);
        case 'serial':
            return typeOf('int4');
        case 'bigserial':
            return typeOf('int8');
        case 'smallserial':
            return typeOf('int2');
        case 'boolean':
        case 'bool':
            return typeOf('bool');
        case 'text':
            return typeOf('text');
        case 'varchar':
        case 'character varying':
            return typeOf('varchar', typmod);
        case 'char':
        case 'character':
        case 'bpchar':
            return typeOf('bpchar', typmod);
        case 'name':
            return typeOf('name');
        case 'oid':
            return typeOf('oid');
        case 'regclass':
            return typeOf('regclass');
        case 'regtype':
            return typeOf('regtype');
        case 'regnamespace':
            return typeOf('regnamespace');
        case 'regproc':
            return typeOf('regproc');
        case 'date':
            return typeOf('date');
        case 'timestamp':
        case 'timestamp without time zone':
            return typeOf('timestamp');
        case 'timestamptz':
        case 'timestamp with time zone':
            return typeOf('timestamptz');
        case 'uuid':
            return typeOf('uuid');
        case 'pg_node_tree':
            return typeOf('pg_node_tree');
        case 'int2vector':
            return typeOf('int2vector');
        case 'oidvector':
            return typeOf('oidvector');
        default:
            throw new ServerError('42704', `type "${bare}" does not exist`);
    }
}

/** Error text PostgreSQL uses when a literal does not fit the column type. */
function invalid(type: DataType, text: string): ServerError {
    return new ServerError('22P02', `invalid input syntax for type ${formatType(type)}: "${text}"`);
}

function integerText(type: DataType, text: string, min: bigint, max: bigint): number {
    const trimmed = text.trim();
    if (!/^[-+]?\d+$/.test(trimmed)) throw invalid(type, text);
    const parsed = BigInt(trimmed);
    if (parsed < min || parsed > max) throw new ServerError('22003', `value "${text}" is out of range for type ${formatType(type)}`);
    return Number(parsed);
}

const INT2_MIN = -32768n;
const INT2_MAX = 32767n;
const INT4_MIN = -2147483648n;
const INT4_MAX = 2147483647n;
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

function floatText(type: DataType, text: string): number {
    const trimmed = text.trim();
    if (/^[-+]?inf(inity)?$/i.test(trimmed)) return trimmed.startsWith('-') ? -Infinity : Infinity;
    if (/^nan$/i.test(trimmed)) return Number.NaN;
    const parsed = Number(trimmed);
    if (trimmed.length === 0 || Number.isNaN(parsed) || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) throw invalid(type, text);
    return parsed;
}

function booleanText(type: DataType, text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (['t', 'true', '1', 'yes', 'on', 'y'].includes(trimmed)) return true;
    if (['f', 'false', '0', 'no', 'off', 'n'].includes(trimmed)) return false;
    throw invalid(type, text);
}

function dateText(type: DataType, text: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
    if (!match) throw invalid(type, text);
    return `${match[1]}-${match[2]}-${match[3]}`;
}

function timestampText(type: DataType, text: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2}|[+-]\d{2})?$/.exec(text.trim());
    if (!match) throw invalid(type, text);
    const fraction = match[7] ?? '';
    const zone = match[8] ?? '';
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}${fraction}${zone}`;
}

function uuidText(type: DataType, text: string): string {
    const trimmed = text.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) throw invalid(type, text);
    return trimmed;
}

interface DecimalParts {
    magnitude: bigint;
    scale: number;
    negative: boolean;
}

/** Splits decimal text into an unsigned significand and a scale. */
function decimalParts(text: string): DecimalParts | null {
    const match = /^([+-]?)(\d+)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!match) return null;
    const intDigits = match[2] ?? '';
    const fracDigits = match[3] ?? '';
    if (intDigits === '' && fracDigits === '') return null;
    const exponent = match[4] === undefined ? 0 : Number(match[4]);
    if (!Number.isFinite(exponent) || Math.abs(exponent) > 100_000) return null;
    let digits = intDigits + fracDigits;
    let scale = fracDigits.length - exponent;
    if (scale < 0) {
        digits += '0'.repeat(-scale);
        scale = 0;
    }
    return { magnitude: digits.length === 0 ? 0n : BigInt(digits), scale, negative: match[1] === '-' };
}

function renderNumeric(sign: string, magnitude: bigint, scale: number): string {
    const digits = magnitude.toString();
    if (scale === 0) return `${magnitude === 0n ? '' : sign}${digits}`;
    const padded = digits.padStart(scale + 1, '0');
    const split = padded.length - scale;
    return `${magnitude === 0n ? '' : sign}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/**
 * Normalizes a numeric literal, applying the column's precision and scale.
 *
 * Rounding is half away from zero, like PostgreSQL. A value that rounds to an
 * absolute value of `10^precision` or more is a `22003` overflow.
 */
function numericText(type: DataType, text: string): string {
    const parts = decimalParts(text);
    if (!parts) throw invalid(type, text);
    let { magnitude, scale } = parts;
    if (type.typmod > 0) {
        const { precision, scale: target } = numericPrecisionScale(type.typmod);
        if (target >= scale) {
            magnitude *= 10n ** BigInt(target - scale);
        }
        else {
            const divisor = 10n ** BigInt(scale - target);
            const remainder = magnitude % divisor;
            magnitude /= divisor;
            if (remainder * 2n >= divisor) magnitude += 1n;
        }
        scale = target;
        if (magnitude >= 10n ** BigInt(precision)) {
            throw new ServerError(
                '22003',
                'numeric field overflow',
                `A field with precision ${precision}, scale ${target} must round to an absolute value less than 10^${precision - target}.`,
            );
        }
    }
    return renderNumeric(parts.negative ? '-' : '', magnitude, scale);
}

/** Parses one literal string into a value of `type`. */
export function parseLiteral(text: string, type: DataType): SqlValue {
    switch (type.key) {
        case 'bool':
            return booleanText(type, text);
        case 'int2':
            return integerText(type, text, INT2_MIN, INT2_MAX);
        case 'int4':
            return integerText(type, text, INT4_MIN, INT4_MAX);
        case 'int8':
            return integerText(type, text, INT8_MIN, INT8_MAX);
        case 'oid':
        case 'regclass':
        case 'regtype':
        case 'regnamespace':
        case 'regproc':
            return integerText(type, text, 0n, 4294967295n);
        case 'float4':
            return floatText(type, text);
        case 'float8':
            return floatText(type, text);
        case 'numeric':
            return numericText(type, text);
        case 'text':
            return text;
        case 'varchar':
        case 'bpchar': {
            if (type.typmod > 0 && text.length > type.typmod - 4) {
                throw new ServerError(
                    '22001',
                    `value too long for type ${formatType(type)}`,
                );
            }
            return text;
        }
        case 'name':
            return text;
        case 'char':
            return text.slice(0, 1);
        case 'date':
            return dateText(type, text);
        case 'timestamp':
        case 'timestamptz':
            return timestampText(type, text);
        case 'uuid':
            return uuidText(type, text);
        default:
            return text;
    }
}

export interface CastHooks {
    /** Relation name for an `oid` cast to `regclass`, or `null` when unknown. */
    relationName(oid: number): string | null;
}

/** Casts one value while preserving PostgreSQL's text-first behaviour. */
export function castValue(value: SqlValue, to: DataType, hooks: CastHooks): SqlValue {
    if (value === null) return null;
    if (to.key === 'regclass') {
        return typeof value === 'number' ? hooks.relationName(value) ?? String(value) : String(value);
    }
    if (to.key === 'regtype' || to.key === 'regnamespace' || to.key === 'regproc' || to.key === 'oid') {
        return typeof value === 'number' ? value : parseLiteral(String(value), to);
    }
    if (to.key === 'text' || to.key === 'name' || to.key === 'pg_node_tree' || to.key === 'int2vector' || to.key === 'oidvector') {
        return formatValue(value, typeOf('text'));
    }
    return parseLiteral(formatValue(value, typeOf('text')) ?? '', to);
}

/** Renders one value as the text form sent on the wire. */
export function formatValue(value: SqlValue, type: DataType): string | null {
    if (value === null) return null;
    if (typeof value === 'boolean') return value ? 't' : 'f';
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return 'NaN';
        if (value === Infinity) return 'Infinity';
        if (value === -Infinity) return '-Infinity';
        return String(value);
    }
    return value;
}

/** Compares two non-null values; `null` sorts last in ascending order. */
export function compareValues(left: SqlValue, right: SqlValue): number {
    if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
    if (typeof left === 'number' && typeof right === 'number') {
        if (Number.isNaN(left) && Number.isNaN(right)) return 0;
        if (Number.isNaN(left)) return 1;
        if (Number.isNaN(right)) return -1;
        if (left === Infinity && right === Infinity) return 0;
        if (left === Infinity) return 1;
        if (right === Infinity) return -1;
        if (left === -Infinity && right === -Infinity) return 0;
        if (left === -Infinity) return -1;
        if (right === -Infinity) return 1;
        return left < right ? -1 : left > right ? 1 : 0;
    }
    const a = String(left);
    const b = String(right);
    const leftDecimal = decimalParts(a);
    const rightDecimal = decimalParts(b);
    if (leftDecimal && rightDecimal) {
        const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
        const magnitude = (parts: DecimalParts): bigint =>
            (parts.negative ? -1n : 1n) * parts.magnitude * 10n ** BigInt(scale - parts.scale);
        const leftValue = magnitude(leftDecimal);
        const rightValue = magnitude(rightDecimal);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}
