/** Protocol-v3 framing for the backend side of the wire protocol. */

/** Protocol version 3.0, the only version this server accepts. */
export const PROTOCOL_VERSION = 196608;

/** Startup request code for a TLS upgrade, answered with `N` (no TLS yet). */
export const SSL_REQUEST = 80877103;

/** Startup request code for a GSSAPI upgrade, answered with `N`. */
export const GSSENC_REQUEST = 80877104;

/** Startup request code for a cancel request, which closes the socket. */
export const CANCEL_REQUEST = 80877102;

export type TransactionStatus = 'I' | 'T' | 'E';

/** One column of a `RowDescription`. */
export interface RowField {
    name: string;
    tableOid?: number;
    columnId?: number;
    typeOid: number;
    typeLength: number;
    typeModifier?: number;
    format?: number;
}

/** One `ErrorResponse` / `NoticeResponse` field, already ordered by the caller. */
export interface MessageFields {
    severity: string;
    code: string;
    message: string;
    detail?: string;
    hint?: string;
    /** `n` field, the violated constraint's name. */
    constraint?: string;
    /** `s` field, the schema that owns the failing relation. */
    schema?: string;
    /** `t` field, the relation name. */
    table?: string;
    /** `c` field, the column name. */
    column?: string;
    /** `d` field, the data type name. */
    dataType?: string;
    position?: string;
    /** `W` field, printed by psql as `CONTEXT:  ...`. */
    where?: string;
    file?: string;
    line?: string;
    routine?: string;
}

function int16(value: number): Buffer {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(value);
    return buffer;
}

function int32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
}

/** Wraps a payload in a tagged backend frame. The length includes itself. */
export function frame(tag: string, payload: Buffer = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from([tag.charCodeAt(0)]), int32(payload.length + 4), payload]);
}

export function authenticationOk(): Buffer {
    return frame('R', int32(0));
}

export function authenticationCleartextPassword(): Buffer {
    return frame('R', int32(3));
}

export function parameterStatus(name: string, value: string): Buffer {
    return frame('S', Buffer.concat([Buffer.from(name), Buffer.from([0]), Buffer.from(value), Buffer.from([0])]));
}

export function backendKeyData(pid: number, secret: number): Buffer {
    return frame('K', Buffer.concat([int32(pid), int32(secret)]));
}

export function readyForQuery(status: TransactionStatus = 'I'): Buffer {
    return frame('Z', Buffer.from(status));
}

export function rowDescription(fields: RowField[]): Buffer {
    const parts = [int16(fields.length)];
    for (const field of fields) {
        parts.push(
            Buffer.from(field.name),
            Buffer.from([0]),
            int32(field.tableOid ?? 0),
            int16(field.columnId ?? 0),
            int32(field.typeOid),
            int16(field.typeLength),
            int32(field.typeModifier ?? -1),
            int16(field.format ?? 0),
        );
    }
    return frame('T', Buffer.concat(parts));
}

export function dataRow(values: (string | null)[]): Buffer {
    const parts = [int16(values.length)];
    for (const value of values) {
        parts.push(value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]));
    }
    return frame('D', Buffer.concat(parts));
}

export function commandComplete(tag: string): Buffer {
    return frame('C', Buffer.from(`${tag}\0`));
}

export function emptyQueryResponse(): Buffer {
    return frame('I');
}

export function parseComplete(): Buffer {
    return frame('1');
}

export function bindComplete(): Buffer {
    return frame('2');
}

export function closeComplete(): Buffer {
    return frame('3');
}

export function noData(): Buffer {
    return frame('n');
}

/** `CopyInResponse`: format byte, column count and per-column formats. */
export function copyInResponse(columns: number): Buffer {
    const formats = [Buffer.from([0]), int16(columns)];
    for (let index = 0; index < columns; index += 1) formats.push(int16(0));
    return frame('G', Buffer.concat(formats));
}

/** `CopyOutResponse`, same shape as the inbound counterpart. */
export function copyOutResponse(columns: number): Buffer {
    const formats = [Buffer.from([0]), int16(columns)];
    for (let index = 0; index < columns; index += 1) formats.push(int16(0));
    return frame('H', Buffer.concat(formats));
}

export function copyData(payload: Buffer): Buffer {
    return frame('d', payload);
}

export function copyDone(): Buffer {
    return frame('c');
}

/** `NotificationResponse`: sender pid followed by channel and payload. */
export function notificationResponse(pid: number, channel: string, payload: string): Buffer {
    return frame('A', Buffer.concat([int32(pid), Buffer.from(channel), Buffer.from([0]), Buffer.from(payload), Buffer.from([0])]));
}

export function parameterDescription(typeOids: number[]): Buffer {
    const parts = [int16(typeOids.length)];
    for (const oid of typeOids) parts.push(int32(oid));
    return frame('t', Buffer.concat(parts));
}

function field(kind: string, value: string): Buffer {
    return Buffer.concat([Buffer.from([kind.charCodeAt(0)]), Buffer.from(value), Buffer.from([0])]);
}

export function messageFieldsResponse(tag: string, fields: MessageFields): Buffer {
    const parts = [
        field('S', fields.severity),
        field('V', fields.severity),
        field('C', fields.code),
        field('M', fields.message),
    ];
    if (fields.detail !== undefined) parts.push(field('D', fields.detail));
    if (fields.hint !== undefined) parts.push(field('H', fields.hint));
    if (fields.constraint !== undefined) parts.push(field('n', fields.constraint));
    if (fields.schema !== undefined) parts.push(field('s', fields.schema));
    if (fields.table !== undefined) parts.push(field('t', fields.table));
    if (fields.column !== undefined) parts.push(field('c', fields.column));
    if (fields.dataType !== undefined) parts.push(field('d', fields.dataType));
    if (fields.position !== undefined) parts.push(field('P', fields.position));
    if (fields.where !== undefined) parts.push(field('W', fields.where));
    if (fields.file !== undefined) parts.push(field('F', fields.file));
    if (fields.line !== undefined) parts.push(field('L', fields.line));
    if (fields.routine !== undefined) parts.push(field('R', fields.routine));
    return frame(tag, Buffer.concat([...parts, Buffer.from([0])]));
}

export function errorResponse(fields: MessageFields): Buffer {
    return messageFieldsResponse('E', fields);
}

export function noticeResponse(fields: MessageFields): Buffer {
    return messageFieldsResponse('N', fields);
}

/** Reads one NUL-terminated string starting at `offset`. */
export function cstring(buffer: Buffer, offset: number): { value: string; next: number } {
    const end = buffer.indexOf(0, offset);
    const stop = end === -1 ? buffer.length : end;
    return { value: buffer.subarray(offset, stop).toString('utf8'), next: stop + 1 };
}
