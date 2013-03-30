/** `COPY ... FROM STDIN` / `COPY ... TO STDOUT` text and CSV codecs. */

import { ServerError } from '../errors.ts';
import { Database } from './database.ts';
import { runStatement, type Field } from './engine.ts';
import type { CopyOptions, CopyStatement, Expr, SelectStatement, Target } from './parser.ts';
import { formatValue, parseLiteral, TEXT, type SqlValue } from './types.ts';

export interface ResolvedCopyOptions {
    format: 'text' | 'csv';
    header: boolean;
    delimiter: string;
    nullString: string;
    quote: string;
    escape: string;
}

/** Fills in PostgreSQL's defaults for the options the parser saw. */
export function resolveCopyOptions(options: CopyOptions): ResolvedCopyOptions {
    const csv = options.format === 'csv';
    const delimiter = options.delimiter ?? (csv ? ',' : '\t');
    const quote = options.quote ?? '"';
    const escape = options.escape ?? (csv ? quote : '\\');
    const nullString = options.nullString ?? (csv ? '' : '\\N');
    if (delimiter.length !== 1) throw new ServerError('22023', 'DELIMITER must be a single one-byte character');
    if (csv && quote.length !== 1) throw new ServerError('22023', 'QUOTE must be a single one-byte character');
    return { format: options.format, header: options.header, delimiter, nullString, quote, escape };
}

const TARGET_STAR: Target = { expr: { kind: 'star', qualifier: undefined }, alias: undefined };

/** Builds `SELECT * FROM <table>` for `COPY table ...`. */
function tableSelect(statement: CopyStatement): SelectStatement {
    const table = statement.table;
    if (table === undefined) throw new ServerError('42601', 'COPY source is missing');
    return {
        kind: 'select',
        core: {
            kind: 'select',
            targets: [TARGET_STAR],
            from: [
                {
                    kind: 'relation',
                    schema: table.schema,
                    name: table.name,
                    alias: undefined,
                    start: table.start,
                    args: undefined,
                },
            ],
            where: undefined,
            groupBy: [],
            having: undefined,
            distinct: false,
            values: undefined,
        },
        unions: [],
        orderBy: [],
        limit: undefined,
        offset: undefined,
    };
}

interface CopySource {
    fields: Field[];
    rows: SqlValue[][];
}

/** Runs the relation scan or the embedded query that feeds a COPY. */
function copySource(database: Database, statement: CopyStatement): CopySource {
    const query = statement.select ?? tableSelect(statement);
    const outcome = runStatement(database, query, []);
    if (outcome.kind !== 'rows') throw new ServerError('XX000', 'COPY source did not produce rows');
    let fields = outcome.fields;
    let rows = outcome.rows;
    if (statement.columns !== undefined && statement.columns.length > 0) {
        const indexes = statement.columns.map((name) => {
            const index = fields.findIndex((field) => field.name.toLowerCase() === name.toLowerCase());
            if (index < 0) {
                throw new ServerError('42703', `column "${name}" of relation "${relationName(statement)}" does not exist`);
            }
            return index;
        });
        fields = indexes.map((index) => fields[index]!);
        rows = rows.map((row) => indexes.map((index) => row[index] ?? null));
    }
    return { fields, rows };
}

function relationName(statement: CopyStatement): string {
    return statement.table?.name ?? 'query';
}

/** Number of columns announced in `CopyInResponse` / `CopyOutResponse`. */
export function copyColumnCount(database: Database, statement: CopyStatement): number {
    return copySource(database, statement).fields.length;
}

function escapeText(value: string): string {
    let output = '';
    for (const character of value) {
        switch (character) {
            case '\\':
                output += '\\\\';
                break;
            case '\b':
                output += '\\b';
                break;
            case '\f':
                output += '\\f';
                break;
            case '\n':
                output += '\\n';
                break;
            case '\r':
                output += '\\r';
                break;
            case '\t':
                output += '\\t';
                break;
            case '\v':
                output += '\\v';
                break;
            default:
                output += character;
        }
    }
    return output;
}

function unescapeText(value: string): string {
    let output = '';
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;
        if (character !== '\\') {
            output += character;
            continue;
        }
        const next = value[index + 1];
        if (next === undefined) {
            output += '\\';
            break;
        }
        index += 1;
        switch (next) {
            case 'b':
                output += '\b';
                break;
            case 'f':
                output += '\f';
                break;
            case 'n':
                output += '\n';
                break;
            case 'r':
                output += '\r';
                break;
            case 't':
                output += '\t';
                break;
            case 'v':
                output += '\v';
                break;
            case 'x': {
                let digits = '';
                while (digits.length < 2 && /[0-9a-fA-F]/.test(value[index + 1] ?? '')) {
                    index += 1;
                    digits += value[index];
                }
                output += digits.length === 0 ? 'x' : String.fromCharCode(parseInt(digits, 16));
                break;
            }
            default:
                if (/[0-7]/.test(next)) {
                    let digits = next;
                    while (digits.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) {
                        index += 1;
                        digits += value[index];
                    }
                    output += String.fromCharCode(parseInt(digits, 8));
                }
                else output += next;
        }
    }
    return output;
}

function quoteCsv(value: string, options: ResolvedCopyOptions): string {
    const mustQuote =
        value.length === 0 ||
        value.includes(options.delimiter) ||
        value.includes(options.quote) ||
        value.includes('\n') ||
        value.includes('\r');
    if (!mustQuote) return value;
    const escaped = options.escape === options.quote
        ? value.split(options.quote).join(options.quote + options.quote)
        : value.split(options.quote).join(options.escape + options.quote);
    return options.quote + escaped + options.quote;
}

/** Renders one COPY result into the payload psql and drivers consume. */
export function copyOut(database: Database, statement: CopyStatement): { data: string; rows: number; columns: number } {
    const options = resolveCopyOptions(statement.options);
    const source = copySource(database, statement);
    const render = (text: string | null): string =>
        text === null ? options.nullString : options.format === 'csv' ? quoteCsv(text, options) : escapeText(text);
    const lines: string[] = [];
    if (options.header) lines.push(source.fields.map((field) => render(field.name)).join(options.delimiter));
    for (const row of source.rows) {
        const cells = row.map((value, index) => {
            const field = source.fields[index];
            if (value === null) return render(null);
            return render(formatValue(value, field?.type ?? TEXT));
        });
        lines.push(cells.join(options.delimiter));
    }
    return { data: lines.length === 0 ? '' : `${lines.join('\n')}\n`, rows: source.rows.length, columns: source.fields.length };
}

interface CsvRecord {
    fields: string[];
    quoted: boolean[];
}

function parseCsvRecords(input: string, options: ResolvedCopyOptions): CsvRecord[] {
    const records: CsvRecord[] = [];
    let fields: string[] = [];
    let quotedFlags: boolean[] = [];
    let field = '';
    let quoted = false;
    let inQuotes = false;
    let started = false;
    let index = 0;
    const pushField = (): void => {
        fields.push(field);
        quotedFlags.push(quoted);
        field = '';
        quoted = false;
    };
    const endRecord = (): void => {
        pushField();
        records.push({ fields, quoted: quotedFlags });
        fields = [];
        quotedFlags = [];
        started = false;
    };
    while (index < input.length) {
        const character = input[index]!;
        if (!inQuotes && !started && fields.length === 0 && field.length === 0) {
            const rest = input.slice(index);
            if (rest === '\\.' || rest === '\\.\n' || rest === '\\.\r\n' || rest.startsWith('\\.\n') || rest.startsWith('\\.\r\n')) {
                break;
            }
        }
        if (inQuotes) {
            if (character === options.escape && options.escape !== options.quote) {
                index += 1;
                field += input[index] ?? '';
                index += 1;
                continue;
            }
            if (character === options.quote) {
                if (input[index + 1] === options.quote) {
                    field += options.quote;
                    index += 2;
                    continue;
                }
                inQuotes = false;
                index += 1;
                continue;
            }
            field += character;
            index += 1;
            continue;
        }
        if (character === options.quote && field.length === 0 && !quoted) {
            inQuotes = true;
            quoted = true;
            started = true;
            index += 1;
            continue;
        }
        if (character === options.delimiter) {
            pushField();
            started = true;
            index += 1;
            continue;
        }
        if (character === '\n') {
            endRecord();
            index += 1;
            continue;
        }
        if (character === '\r') {
            if (input[index + 1] === '\n') {
                index += 1;
                continue;
            }
            endRecord();
            index += 1;
            continue;
        }
        field += character;
        started = true;
        index += 1;
    }
    if (started || field.length > 0) endRecord();
    return records;
}

function parseTextRecords(input: string, options: ResolvedCopyOptions): CsvRecord[] {
    const records: CsvRecord[] = [];
    for (const rawLine of input.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '\\.') break;
        if (line.length === 0) continue;
        const fields = line.split(options.delimiter).map((value) => unescapeText(value));
        records.push({ fields, quoted: fields.map((value) => value !== options.nullString) });
    }
    return records;
}

/** Inserts every record, adding PostgreSQL's COPY context to failures. */
export function copyIn(database: Database, statement: CopyStatement, input: string): number {
    const options = resolveCopyOptions(statement.options);
    const source = copySource(database, statement);
    const records = (options.format === 'csv' ? parseCsvRecords(input, options) : parseTextRecords(input, options)).slice(
        options.header ? 1 : 0,
    );
    if (records.length === 0) return 0;
    const table = statement.table;
    if (table === undefined) throw new ServerError('42601', 'COPY target is missing');
    const tableName = table.name;
    const headerOffset = options.header ? 1 : 0;
    const columns = source.fields.map((field) => field.name);
    let inserted = 0;
    for (const [index, record] of records.entries()) {
        const line = index + 1 + headerOffset;
        if (record.fields.length !== source.fields.length) {
            throw withContext(
                new ServerError(
                    '22P04',
                    `missing data for column "${source.fields[record.fields.length]?.name ?? '?'}"`
                ),
                `COPY ${tableName}, line ${line}`,
            );
        }
        const values: Expr[] = record.fields.map((raw, fieldIndex) => {
            const field = source.fields[fieldIndex]!;
            const isNull = options.format === 'csv'
                ? !record.quoted[fieldIndex] && raw === options.nullString
                : raw === options.nullString;
            if (isNull) return { kind: 'literal', value: null, text: 'NULL' } satisfies Expr;
            try {
                parseLiteral(raw, field.type);
            } catch (error) {
                if (error instanceof ServerError) {
                    error.context = `COPY ${tableName}, line ${line}, column ${field.name}: "${raw}"`;
                }
                throw error;
            }
            return { kind: 'literal', value: raw, text: raw, numeric: false } satisfies Expr;
        });
        const insert = {
            kind: 'insert' as const,
            table,
            columns,
            rows: [values],
            defaultValues: false,
            overriding: undefined,
            returning: undefined,
        };
        try {
            runStatement(database, insert, []);
        } catch (error) {
            if (error instanceof ServerError && error.context === undefined) {
                throw withContext(error, `COPY ${tableName}, line ${line}`);
            }
            throw error;
        }
        inserted += 1;
    }
    return inserted;
}

function withContext(error: ServerError, context: string): ServerError {
    error.context = context;
    return error;
}
