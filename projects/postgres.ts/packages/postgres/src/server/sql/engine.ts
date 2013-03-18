/** Statement execution: DDL, DML and the SELECT subset psql's `\\d` needs. */

import { ServerError } from '../errors.ts';
import {
    type CatalogDoc,
    type ColumnMeta,
    PUBLIC_NAMESPACE,
    catalogTables,
    formatTypeByOid,
    pgGetConstraintDef,
    pgGetExpr,
    pgGetIndexDef,
    pgGetUserById,
    pgRelationIsPublishable,
    pgTableIsVisible,
    relationByName,
    systemColumns,
    typeByOid,
} from './catalog.ts';
import type { Database } from './database.ts';
import type {
    ArrayExpr,
    AnyExpr,
    BinaryExpr,
    CaseExpr,
    CastExpr,
    ColumnDef,
    ColumnExpr,
    CreateTableStatement,
    DeleteStatement,
    DropTableStatement,
    Expr,
    FromItem,
    FunctionExpr,
    InExpr,
    InsertStatement,
    IsNullExpr,
    OrderItem,
    ParamExpr,
    RelationRef,
    SelectStatement,
    Statement,
    SubqueryExpr,
    Target,
    UnaryExpr,
    UpdateStatement,
} from './parser.ts';
import {
    BOOL,
    INT4,
    TEXT,
    arrayOf,
    castValue,
    compareValues,
    formatType,
    formatValue,
    parseLiteral,
    type DataType,
    type SqlValue,
    typeOf,
    typeOid,
} from './types.ts';

export interface Field {
    name: string;
    type: DataType;
}

export type Outcome =
    | { kind: 'rows'; fields: Field[]; rows: SqlValue[][]; tag: string }
    | { kind: 'command'; tag: string };

interface Binding {
    alias: string;
    name: string;
    type: DataType;
}

interface RowSet {
    columns: Binding[];
    rows: SqlValue[][];
}

interface Context {
    columns: Binding[];
    row: SqlValue[];
    outer: Context | undefined;
}

interface Scope {
    columns: Binding[];
    outer: Scope | undefined;
}

function emptyTagName(statement: Statement): string {
    switch (statement.kind) {
        case 'select':
            return 'SELECT';
        case 'insert':
            return 'INSERT';
        case 'update':
            return 'UPDATE';
        case 'delete':
            return 'DELETE';
        case 'create-table':
            return 'CREATE TABLE';
        case 'drop-table':
            return 'DROP TABLE';
    }
}

/** Runs one already-parsed statement against the message's working set. */
export function runStatement(database: Database, statement: Statement, params: SqlValue[]): Outcome {
    switch (statement.kind) {
        case 'select': {
            const result = executeSelect(database, statement, params, undefined);
            return { kind: 'rows', fields: result.fields, rows: result.rows, tag: `SELECT ${result.rows.length}` };
        }
        case 'create-table':
            return createTable(database, statement);
        case 'drop-table':
            return dropTable(database, statement);
        case 'insert':
            return insertRows(database, statement, params);
        case 'update':
            return updateRows(database, statement, params);
        case 'delete':
            return deleteRows(database, statement, params);
    }
    throw new ServerError('0A000', 'feature not supported', `${emptyTagName(statement)} is not implemented`);
}

/** Field metadata for `Describe` on a SELECT, without running side effects. */
export function describeSelect(database: Database, statement: SelectStatement, params: SqlValue[]): Field[] {
    const result = executeSelect(database, statement, params, undefined);
    return result.fields;
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

interface SelectResult {
    fields: Field[];
    rows: SqlValue[][];
}

interface Entry {
    values: SqlValue[];
    keys: SqlValue[];
}

function executeSelect(database: Database, select: SelectStatement, params: SqlValue[], outer: Context | undefined): SelectResult {
    const orderBy = select.orderBy;
    const core = select.core;
    let fields: Field[] = [];
    const entries: Entry[] = [];
    const appendCore = (current: typeof core, withKeys: boolean): void => {
        const { fields: coreFields, entries: coreEntries } = executeCore(database, current, params, outer, withKeys ? orderBy : []);
        fields = coreFields;
        entries.push(...coreEntries);
    };

    appendCore(core, orderBy.length > 0 && select.unions.length === 0);
    let dedupe = core.distinct;
    for (const union of select.unions) {
        const { fields: unionFields, entries: unionEntries } = executeCore(database, union.core, params, outer, []);
        fields = unionFields;
        entries.push(...unionEntries);
        if (union.op === 'union' && !union.all) dedupe = true;
    }
    if (dedupe) {
        const seen = new Set<string>();
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (!entry) continue;
            const key = JSON.stringify(entry.values);
            if (seen.has(key)) entries.splice(index, 1);
            else seen.add(key);
        }
    }

    if (select.unions.length === 0) {
        if (orderBy.length > 0) entries.sort((left, right) => compareEntries(left, right, orderBy));
    }
    else if (orderBy.length > 0) {
        const keyed = entries.map((entry) => ({ values: entry.values, keys: orderBy.map((item) => outputKey(item, entry.values, fields)) }));
        keyed.sort((left, right) => compareEntries(left, right, orderBy));
        entries.splice(0, entries.length, ...keyed);
    }

    const offset = select.offset === undefined ? 0 : Number(evaluate(database, select.offset, emptyContext(), params));
    const limit = select.limit === undefined ? Number.POSITIVE_INFINITY : Number(evaluate(database, select.limit, emptyContext(), params));
    const rows = entries
        .slice(Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) && Number.isFinite(offset) ? offset + limit : undefined)
        .map((entry) => entry.values);
    return { fields, rows };
}

/** Sort key for a set-operation result: ordinals and output aliases only. */
function outputKey(item: OrderItem, values: SqlValue[], fields: Field[]): SqlValue {
    const expr = item.expr;
    if (expr.kind === 'literal' && typeof (expr as { value: SqlValue }).value === 'number') {
        return values[Number((expr as { value: SqlValue }).value) - 1] ?? null;
    }
    if (expr.kind === 'column' && (expr as ColumnExpr).qualifier === undefined) {
        const index = fields.findIndex((field) => field.name === (expr as ColumnExpr).name);
        return index >= 0 ? values[index] ?? null : null;
    }
    return null;
}

function compareEntries(left: Entry, right: Entry, orderBy: OrderItem[]): number {
    for (let index = 0; index < orderBy.length; index += 1) {
        const item = orderBy[index];
        if (!item) continue;
        const a = left.keys[index] ?? null;
        const b = right.keys[index] ?? null;
        const compared = compareWithNulls(a, b, item);
        if (compared !== 0) return compared;
    }
    return 0;
}

function compareWithNulls(left: SqlValue, right: SqlValue, item: OrderItem): number {
    // Ascending puts NULL last, descending puts it first unless NULLS overrides.
    const nullsFirst = item.nulls === 'FIRST' || (item.nulls === undefined && item.direction === 'DESC');
    if (left === null && right === null) return 0;
    if (left === null) return nullsFirst ? -1 : 1;
    if (right === null) return nullsFirst ? 1 : -1;
    const compared = compareValues(left, right);
    return item.direction === 'DESC' ? -compared : compared;
}

function executeCore(
    database: Database,
    core: SelectStatement['core'],
    params: SqlValue[],
    outer: Context | undefined,
    orderBy: OrderItem[],
): { fields: Field[]; entries: Entry[] } {
    const from = buildFrom(database, core.from, params, outer);
    const targets = expandTargets(database, core.targets, from.columns);
    const fields: Field[] = targets.map((target) => ({
        name: targetName(target),
        type: fieldType(database, target.expr, { columns: from.columns, outer: outer ? { columns: outer.columns, outer: undefined } : undefined }, params),
    }));

    const entries: Entry[] = [];
    for (const row of from.rows) {
        const context: Context = { columns: from.columns, row, outer };
        if (core.where) {
            const keep = evaluate(database, core.where, context, params);
            if (keep !== true) continue;
        }
        if (core.groupBy.length > 0 || core.having) {
            throw new ServerError('0A000', 'feature not supported', 'GROUP BY and HAVING are not implemented');
        }
        const values = targets.map((target) => evaluate(database, target.expr, context, params));
        const keys = orderBy.map((item) => orderKey(database, item, context, values, fields, params));
        entries.push({ values, keys });
    }
    return { fields, entries };
}

function orderKey(database: Database, item: OrderItem, context: Context, values: SqlValue[], fields: Field[], params: SqlValue[]): SqlValue {
    const expr = item.expr;
    if (expr.kind === 'literal' && typeof (expr as { value: SqlValue }).value === 'number') {
        const index = Number((expr as { value: SqlValue }).value) - 1;
        return values[index] ?? null;
    }
    if (expr.kind === 'column' && (expr as ColumnExpr).qualifier === undefined) {
        const columnName = (expr as ColumnExpr).name;
        const index = fields.findIndex((field) => field.name === columnName);
        if (index >= 0) return values[index] ?? null;
    }
    return evaluate(database, expr, context, params);
}

function expandTargets(database: Database, targets: Target[], columns: Binding[]): Target[] {
    const expanded: Target[] = [];
    for (const target of targets) {
        if (target.expr.kind === 'star') {
            const qualifier = (target.expr as { qualifier: string | undefined }).qualifier;
            for (const binding of columns) {
                if (qualifier !== undefined && binding.alias !== qualifier) continue;
                expanded.push({ expr: { kind: 'column', qualifier: binding.alias, name: binding.name } satisfies ColumnExpr, alias: undefined });
            }
            continue;
        }
        expanded.push(target);
    }
    return expanded;
}

function targetName(target: Target): string {
    if (target.alias) return target.alias;
    const expr = target.expr;
    if (expr.kind === 'column') return (expr as ColumnExpr).name;
    if (expr.kind === 'cast') return targetName({ expr: (expr as CastExpr).expr, alias: undefined });
    if (expr.kind === 'function') return (expr as FunctionExpr).name;
    return '?column?';
}

function fieldType(database: Database, expr: Expr, scope: Scope | undefined, params: SqlValue[]): DataType {
    switch (expr.kind) {
        case 'literal': {
            const value = (expr as { value: SqlValue }).value;
            if (typeof value === 'boolean') return BOOL;
            if (typeof value === 'number') return Number.isInteger(value) ? INT4 : typeOf('float8');
            return TEXT;
        }
        case 'param':
            return TEXT;
        case 'column': {
            const column = expr as ColumnExpr;
            const binding = findBinding(scope, column.qualifier, column.name);
            if (!binding) throw new ServerError('42703', `column "${column.name}" does not exist`);
            return binding.type;
        }
        case 'cast':
            return (expr as CastExpr).type;
        case 'function':
            return functionType((expr as FunctionExpr).name);
        case 'binary': {
            const binary = expr as BinaryExpr;
            if (['and', 'or', '=', '<>', '<', '>', '<=', '>=', '~', '!~', '~*', '!~*'].includes(binary.op)) return BOOL;
            if (binary.op === '||') return TEXT;
            const left = fieldType(database, binary.left, scope, params);
            const right = fieldType(database, binary.right, scope, params);
            if (left.key === 'float8' || right.key === 'float8' || left.key === 'float4' || right.key === 'float4') return typeOf('float8');
            return left.key === 'text' || left.key === 'varchar' ? left : INT4;
        }
        case 'unary':
            return (expr as UnaryExpr).op === 'not' ? BOOL : fieldType(database, (expr as UnaryExpr).expr, scope, params);
        case 'isnull':
        case 'in':
        case 'any':
        case 'exists':
            return BOOL;
        case 'case': {
            const first = (expr as CaseExpr).whens[0];
            return first ? fieldType(database, first.then, scope, params) : TEXT;
        }
        case 'subquery':
            return staticSelectType((expr as SubqueryExpr).select) ?? TEXT;
        case 'collate':
            return fieldType(database, (expr as { expr: Expr }).expr, scope, params);
        case 'array':
            return arrayOf(TEXT);
        default:
            return TEXT;
    }
}

function functionType(name: string): DataType {
    switch (name.toLowerCase()) {
        case 'pg_get_userbyid':
            return typeOf('name');
        case 'pg_table_is_visible':
        case 'pg_relation_is_publishable':
            return BOOL;
        case 'generate_series':
            return INT4;
        case 'count':
            return typeOf('int8');
        default:
            return TEXT;
    }
}

/** Field type of a subquery's first target without running the subquery. */
function staticSelectType(select: SelectStatement): DataType | undefined {
    const target = select.core.targets[0];
    return target === undefined ? undefined : staticExprType(target.expr);
}

function staticExprType(expr: Expr): DataType | undefined {
    switch (expr.kind) {
        case 'literal': {
            const value = (expr as { value: SqlValue }).value;
            if (typeof value === 'boolean') return BOOL;
            if (typeof value === 'number') return Number.isInteger(value) ? INT4 : typeOf('float8');
            return TEXT;
        }
        case 'cast':
            return (expr as CastExpr).type;
        case 'case': {
            const first = (expr as CaseExpr).whens[0];
            return first ? staticExprType(first.then) : TEXT;
        }
        case 'function':
            return functionType((expr as FunctionExpr).name);
        case 'array':
            return arrayOf(TEXT);
        default:
            return undefined;
    }
}

function findBinding(scope: Scope | undefined, qualifier: string | undefined, name: string): Binding | undefined {
    let current = scope;
    while (current) {
        const candidates = current.columns.filter((column) => column.name === name && (qualifier === undefined || column.alias === qualifier));
        if (candidates.length > 1) throw new ServerError('42702', `column reference "${name}" is ambiguous`);
        const found = candidates[0];
        if (found) return found;
        if (qualifier !== undefined && current.columns.some((column) => column.alias === qualifier)) return undefined;
        current = current.outer;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// FROM
// ---------------------------------------------------------------------------

function emptyContext(): Context {
    return { columns: [], row: [], outer: undefined };
}

function buildFrom(database: Database, from: FromItem[], params: SqlValue[], outer: Context | undefined): RowSet {
    if (from.length === 0) return { columns: [], rows: [[]] };
    let current = buildItem(database, from[0]!, params, outer);
    for (const item of from.slice(1)) {
        current = crossJoin(current, buildItem(database, item, params, outer));
    }
    return current;
}

function buildItem(database: Database, item: FromItem, params: SqlValue[], outer: Context | undefined): RowSet {
    if (item.kind === 'relation') return buildRelation(database, item);
    if (item.kind === 'subquery') {
        const result = executeSelect(database, item.select, params, outer);
        const alias = item.alias ?? '';
        return {
            columns: result.fields.map((field) => ({ alias, name: field.name, type: field.type })),
            rows: result.rows,
        };
    }
    const left = buildItem(database, item.left, params, outer);
    const right = buildItem(database, item.right, params, outer);
    if (item.joinType === 'cross') return crossJoin(left, right);
    const columns = [...left.columns, ...right.columns];
    const rows: SqlValue[][] = [];
    for (const leftRow of left.rows) {
        let matched = false;
        for (const rightRow of right.rows) {
            const row = [...leftRow, ...rightRow];
            const context: Context = { columns, row, outer };
            const keep = item.on === undefined ? true : evaluate(database, item.on, context, params);
            if (keep === true) {
                rows.push(row);
                matched = true;
            }
        }
        if (!matched && item.joinType === 'left') {
            const nulls = right.columns.map(() => null);
            rows.push([...leftRow, ...nulls]);
        }
    }
    return { columns, rows };
}

function crossJoin(left: RowSet, right: RowSet): RowSet {
    const columns = [...left.columns, ...right.columns];
    const rows: SqlValue[][] = [];
    for (const leftRow of left.rows) for (const rightRow of right.rows) rows.push([...leftRow, ...rightRow]);
    return { columns, rows };
}

function buildRelation(database: Database, ref: RelationRef): RowSet {
    const alias = ref.alias ?? ref.name;
    const system = ref.schema === 'pg_catalog' ? systemColumns(ref.name) : ref.schema === undefined ? systemColumns(ref.name) : undefined;
    if (system) {
        const table = catalogTables(database.catalog).get(ref.name);
        return {
            columns: (table?.columns ?? system).map((column) => ({ alias, name: column.name, type: column.type })),
            rows: table?.rows ?? [],
        };
    }
    if (ref.schema !== undefined && ref.schema !== 'public') throw new ServerError('3F000', `schema "${ref.schema}" does not exist`);
    const relation = relationByName(database.catalog, ref.name);
    if (!relation) throw new ServerError('42P01', `relation "${ref.name}" does not exist`);
    const columns: ColumnMeta[] = database.catalog.columns
        .filter((column) => column.relid === relation.oid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({ name: column.name, type: typeByOid(column.typeOid, column.typmod) }));
    const rows = [...database.table(relation.oid).values()];
    return { columns: columns.map((column) => ({ alias, name: column.name, type: column.type })), rows };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function evaluate(database: Database, expr: Expr, context: Context, params: SqlValue[]): SqlValue {
    switch (expr.kind) {
        case 'literal':
            return (expr as { value: SqlValue }).value;
        case 'param': {
            const index = (expr as ParamExpr).index;
            if (index < 1 || index > params.length) throw new ServerError('42P02', `there is no parameter $${index}`);
            return params[index - 1] ?? null;
        }
        case 'column': {
            const column = expr as ColumnExpr;
            return lookup(database, context, column.qualifier, column.name, params);
        }
        case 'cast':
            return evaluateCast(database, expr as CastExpr, context, params);
        case 'unary': {
            const unary = expr as UnaryExpr;
            const value = evaluate(database, unary.expr, context, params);
            if (unary.op === 'not') return value === null ? null : value !== true;
            if (typeof value !== 'number') return value === null ? null : value;
            return unary.op === '-' ? -value : value;
        }
        case 'binary':
            return evaluateBinary(database, expr as BinaryExpr, context, params);
        case 'isnull': {
            const value = evaluate(database, (expr as IsNullExpr).expr, context, params);
            const result = value === null;
            return (expr as IsNullExpr).negated ? !result : result;
        }
        case 'in': {
            const node = expr as InExpr;
            const value = evaluate(database, node.expr, context, params);
            if (value === null) return null;
            let matched = false;
            let sawNull = false;
            for (const item of node.list) {
                const candidate = evaluate(database, item, context, params);
                if (candidate === null) sawNull = true;
                else if (compareValues(value, candidate) === 0) matched = true;
            }
            if (matched) return node.negated ? false : true;
            if (sawNull) return null;
            return node.negated ? true : false;
        }
        case 'any': {
            const node = expr as AnyExpr;
            const value = evaluate(database, node.left, context, params);
            const array = evaluate(database, node.array, context, params);
            if (value === null || array === null) return null;
            const items = splitArray(array);
            let matched = false;
            let sawNull = false;
            for (const item of items) {
                if (item === null) sawNull = true;
                else if (compareOperation(node.op, value, item) === true) matched = true;
            }
            if (matched) return true;
            return sawNull ? null : false;
        }
        case 'case':
            return evaluateCase(database, expr as CaseExpr, context, params);
        case 'subquery': {
            const result = executeSelect(database, (expr as SubqueryExpr).select, params, context);
            if (result.rows.length > 1) throw new ServerError('21000', 'more than one row returned by a subquery used as an expression');
            return result.rows[0]?.[0] ?? null;
        }
        case 'exists': {
            const result = executeSelect(database, (expr as { select: SelectStatement }).select, params, context);
            return result.rows.length > 0;
        }
        case 'collate':
            return evaluate(database, (expr as { expr: Expr }).expr, context, params);
        case 'array':
            return evaluateArray(database, expr as ArrayExpr, context, params);
        case 'function':
            return evaluateFunction(database, expr as FunctionExpr, context, params);
        case 'default':
            return null;
        case 'star':
        case 'subscript':
            throw new ServerError('0A000', 'feature not supported', `${expr.kind} is not implemented`);
    }
}

function lookup(database: Database, context: Context, qualifier: string | undefined, name: string, params: SqlValue[]): SqlValue {
    let current: Context | undefined = context;
    while (current) {
        const binding = findBinding({ columns: current.columns, outer: undefined }, qualifier, name);
        if (binding) {
            const index = current.columns.indexOf(binding);
            return current.row[index] ?? null;
        }
        if (qualifier !== undefined && current.columns.some((column) => column.alias === qualifier)) {
            throw new ServerError('42703', `column ${qualifier}.${name} does not exist`);
        }
        current = current.outer;
    }
    throw new ServerError('42703', `column "${name}" does not exist`);
}

function evaluateCast(database: Database, expr: CastExpr, context: Context, params: SqlValue[]): SqlValue {
    const value = evaluate(database, expr.expr, context, params);
    return castValue(value, expr.type, { relationName: (oid) => relationDisplayName(database.catalog, oid) });
}

function relationDisplayName(catalog: CatalogDoc, oid: number): string | null {
    return catalog.relations.find((relation) => relation.oid === oid)?.name ?? null;
}

function evaluateBinary(database: Database, expr: BinaryExpr, context: Context, params: SqlValue[]): SqlValue {
    if (expr.op === 'and') {
        const left = evaluate(database, expr.left, context, params);
        if (left === false) return false;
        const right = evaluate(database, expr.right, context, params);
        if (right === false) return false;
        if (left === null || right === null) return null;
        return true;
    }
    if (expr.op === 'or') {
        const left = evaluate(database, expr.left, context, params);
        if (left === true) return true;
        const right = evaluate(database, expr.right, context, params);
        if (right === true) return true;
        if (left === null || right === null) return null;
        return false;
    }
    const left = evaluate(database, expr.left, context, params);
    const right = evaluate(database, expr.right, context, params);
    if (expr.op === '||') {
        if (left === null || right === null) return null;
        return `${formatValue(left, TEXT)}${formatValue(right, TEXT)}`;
    }
    if (['=', '<>', '<', '>', '<=', '>='].includes(expr.op)) return compareOperation(expr.op, left, right);
    if (['~', '!~', '~*', '!~*'].includes(expr.op)) {
        if (left === null || right === null) return null;
        const flags = expr.op.includes('*') ? 'i' : '';
        const matched = new RegExp(String(right ?? ''), flags).test(String(formatValue(left, TEXT)));
        return expr.op.startsWith('!') ? !matched : matched;
    }
    if (left === null || right === null) return null;
    const a = numeric(left);
    const b = numeric(right);
    switch (expr.op) {
        case '+':
            return a + b;
        case '-':
            return a - b;
        case '*':
            return a * b;
        case '/':
            if (b === 0) throw new ServerError('22012', 'division by zero');
            return a / b;
        case '%':
            if (b === 0) throw new ServerError('22012', 'division by zero');
            return a % b;
        default:
            throw new ServerError('0A000', 'feature not supported', `operator ${expr.op} is not implemented`);
    }
}

function compareOperation(op: string, left: SqlValue, right: SqlValue): SqlValue {
    if (left === null || right === null) return null;
    let a = left;
    let b = right;
    if (typeof a === 'number' && typeof b === 'string' && /^[-+]?\d+$/.test(b)) b = Number(b);
    if (typeof b === 'number' && typeof a === 'string' && /^[-+]?\d+$/.test(a)) a = Number(a);
    if (typeof a === 'string' && typeof b === 'number') b = Number(b);
    const compared = compareValues(a, b);
    switch (op) {
        case '=':
            return compared === 0;
        case '<>':
            return compared !== 0;
        case '<':
            return compared < 0;
        case '>':
            return compared > 0;
        case '<=':
            return compared <= 0;
        case '>=':
            return compared >= 0;
        default:
            throw new ServerError('0A000', 'feature not supported', `operator ${op} is not implemented`);
    }
}

function numeric(value: SqlValue): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new ServerError('22P02', `invalid input syntax for type numeric: "${value}"`);
    return parsed;
}

function evaluateCase(database: Database, expr: CaseExpr, context: Context, params: SqlValue[]): SqlValue {
    const hasOperand = expr.operand !== undefined;
    const operand = expr.operand === undefined ? null : evaluate(database, expr.operand, context, params);
    for (const branch of expr.whens) {
        if (hasOperand) {
            const candidate = evaluate(database, branch.when, context, params);
            if (operand !== null && candidate !== null && compareValues(operand, candidate) === 0) {
                return evaluate(database, branch.then, context, params);
            }
        }
        else if (evaluate(database, branch.when, context, params) === true) {
            return evaluate(database, branch.then, context, params);
        }
    }
    return expr.otherwise ? evaluate(database, expr.otherwise, context, params) : null;
}

function evaluateArray(database: Database, expr: ArrayExpr, context: Context, params: SqlValue[]): SqlValue {
    if (expr.select) {
        const result = executeSelect(database, expr.select, params, context);
        return result.rows.map((row) => formatValue(row[0] ?? null, TEXT) ?? '').join(' ');
    }
    return (expr.elements ?? []).map((element) => formatValue(evaluate(database, element, context, params), TEXT) ?? '').join(' ');
}

function splitArray(value: SqlValue): SqlValue[] {
    if (value === null) return [];
    if (Array.isArray(value)) return value as SqlValue[];
    const text = String(value);
    if (text.length === 0) return [];
    return text.split(/\s+/);
}

function evaluateFunction(database: Database, expr: FunctionExpr, context: Context, params: SqlValue[]): SqlValue {
    const name = expr.name.toLowerCase();
    if (['count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg'].includes(name)) {
        throw new ServerError('0A000', 'feature not supported', 'aggregate functions are not implemented');
    }
    const args = expr.args.map((argument) => evaluate(database, argument, context, params));
    switch (name) {
        case 'pg_get_userbyid':
            return pgGetUserById(args[0] ?? null);
        case 'pg_table_is_visible':
            return pgTableIsVisible(args[0] ?? null, database.catalog);
        case 'pg_relation_is_publishable':
            return pgRelationIsPublishable();
        case 'pg_get_expr':
            return pgGetExpr(args[0] ?? null);
        case 'pg_get_indexdef':
            return pgGetIndexDef(database.catalog, args[0] ?? null);
        case 'pg_get_constraintdef':
            return pgGetConstraintDef(database.catalog, args[0] ?? null);
        case 'format_type':
            return formatTypeByOid(args[0] ?? null, args[1] ?? -1);
        case 'pg_get_statisticsobjdef_columns':
            return null;
        case 'array_to_string': {
            const array = splitArray(args[0] ?? null);
            const separator = formatValue(args[1] ?? ',', TEXT) ?? ',';
            return array.map((item) => String(item)).join(separator);
        }
        case 'array_upper': {
            const array = splitArray(args[0] ?? null);
            return array.length === 0 ? null : array.length;
        }
        case 'generate_series': {
            const start = Number(args[0] ?? 1);
            const stop = Number(args[1] ?? start);
            const values: string[] = [];
            for (let current = start; current <= stop; current += 1) values.push(String(current));
            return values.join(' ');
        }
        default:
            throw new ServerError('42883', `function ${expr.name}(${args.length} arguments) does not exist`);
    }
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const BTREE_OID = 403;

function createTable(database: Database, statement: CreateTableStatement): Outcome {
    const catalog = database.catalog;
    if (statement.table.schema !== undefined && statement.table.schema !== 'public') {
        throw new ServerError('3F000', `schema "${statement.table.schema}" does not exist`);
    }
    const existing = relationByName(catalog, statement.table.name);
    if (existing) {
        if (statement.ifNotExists) return { kind: 'command', tag: 'CREATE TABLE' };
        throw new ServerError('42P07', `relation "${statement.table.name}" already exists`);
    }

    const names = new Set<string>();
    for (const column of statement.columns) {
        if (names.has(column.name)) throw new ServerError('42701', `column "${column.name}" specified more than once`);
        names.add(column.name);
    }

    const tableOid = catalog.nextOid;
    catalog.nextOid += 1;
    const relation = {
        oid: tableOid,
        name: statement.table.name,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'r' as const,
        relam: 2,
        owner: 10,
        relhasindex: false,
    };

    const prepared: { column: ColumnDef; typeOid: number; typmod: number; defaultText: string | null; defaultValue: SqlValue }[] = [];
    for (const column of statement.columns) {
        const defaultValue = column.defaultExpr ? evaluate(database, column.defaultExpr, emptyContext(), []) : null;
        const coerced = defaultValue === null ? null : coerce(defaultValue, column.type);
        const defaultText = coerced === null ? null : renderDefault(coerced, column.type);
        prepared.push({
            column,
            typeOid: typeOid(column.type),
            typmod: column.type.typmod,
            defaultText,
            defaultValue: coerced,
        });
    }

    prepared.forEach((entry, index) => {
        const defaultOid = entry.defaultText === null ? null : catalog.nextOid;
        if (defaultOid !== null) catalog.nextOid += 1;
        catalog.columns.push({
            relid: tableOid,
            attnum: index + 1,
            name: entry.column.name,
            typeOid: entry.typeOid,
            typmod: entry.typmod,
            notNull: entry.column.notNull,
            defaultText: entry.defaultText,
            defaultValue: entry.defaultValue,
            defaultOid,
        });
    });

    const primaryColumns = collectPrimaryColumns(statement);
    const uniqueConstraints = collectUniqueConstraints(statement);
    const constraintCount = (primaryColumns.length > 0 ? 1 : 0) + uniqueConstraints.length;
    if (constraintCount > 0) relation.relhasindex = true;

    for (const columns of uniqueConstraints) {
        addIndex(database, tableOid, columns, false, statement.table.name, catalog);
    }
    if (primaryColumns.length > 0) {
        addIndex(database, tableOid, primaryColumns, true, statement.table.name, catalog);
        for (const columnName of primaryColumns) {
            const column = catalog.columns.find((candidate) => candidate.relid === tableOid && candidate.name === columnName);
            if (column) column.notNull = true;
        }
    }

    catalog.relations.push(relation);
    catalog.nextRowId[String(tableOid)] = 1;
    database.markCatalogDirty();
    return { kind: 'command', tag: 'CREATE TABLE' };
}

function collectPrimaryColumns(statement: CreateTableStatement): string[] {
    const candidates = [
        ...statement.columns.filter((column) => column.primaryKey).map((column) => [column.name]),
        ...statement.constraints.filter((constraint) => constraint.kind === 'primary').map((constraint) => constraint.columns),
    ];
    if (candidates.length > 1) throw new ServerError('42P16', `multiple primary keys for table "${statement.table.name}" are not defined`);
    return candidates[0] ?? [];
}

function collectUniqueConstraints(statement: CreateTableStatement): string[][] {
    const result = statement.constraints.filter((constraint) => constraint.kind === 'unique').map((constraint) => constraint.columns);
    for (const column of statement.columns) {
        if (column.unique) result.push([column.name]);
    }
    return result;
}

function addIndex(database: Database, relid: number, names: string[], primary: boolean, tableName: string, catalog: CatalogDoc): void {
    const attnums: number[] = [];
    for (const columnName of names) {
        const column = catalog.columns.find((candidate) => candidate.relid === relid && candidate.name === columnName);
        if (!column) throw new ServerError('42703', `column "${columnName}" does not exist`);
        attnums.push(column.attnum);
    }
    if (attnums.length === 0) return;
    const indexOid = catalog.nextOid;
    catalog.nextOid += 1;
    const constraintOid = catalog.nextOid;
    catalog.nextOid += 1;
    const indexName = primary ? `${tableName}_pkey` : `${tableName}_${names.join('_')}_key`;
    catalog.relations.push({
        oid: indexOid,
        name: indexName,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'i',
        relam: BTREE_OID,
        owner: 10,
        relhasindex: false,
    });
    catalog.indexes.push({
        oid: indexOid,
        name: indexName,
        relid,
        unique: true,
        primary,
        indkey: attnums,
        constraintOid,
    });
    catalog.constraints.push({
        oid: constraintOid,
        name: indexName,
        relid,
        contype: primary ? 'p' : 'u',
        indexOid,
        conkey: attnums,
    });
    database.markCatalogDirty();
}

function dropTable(database: Database, statement: DropTableStatement): Outcome {
    const catalog = database.catalog;
    const relation = relationByName(catalog, statement.table.name);
    if (!relation) {
        if (statement.ifExists) return { kind: 'command', tag: 'DROP TABLE' };
        throw new ServerError('42P01', `table "${statement.table.name}" does not exist`);
    }
    if (relation.relkind !== 'r') throw new ServerError('42P01', `table "${statement.table.name}" does not exist`);
    const indexOids = catalog.indexes.filter((index) => index.relid === relation.oid).map((index) => index.oid);
    catalog.relations = catalog.relations.filter((candidate) => candidate.oid !== relation.oid && !indexOids.includes(candidate.oid));
    catalog.columns = catalog.columns.filter((column) => column.relid !== relation.oid);
    catalog.indexes = catalog.indexes.filter((index) => index.relid !== relation.oid);
    catalog.constraints = catalog.constraints.filter((constraint) => constraint.relid !== relation.oid);
    delete catalog.nextRowId[String(relation.oid)];
    for (const key of [...database.table(relation.oid).keys()]) database.deleteRow(relation.oid, key);
    database.markCatalogDirty();
    return { kind: 'command', tag: 'DROP TABLE' };
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

interface TableShape {
    oid: number;
    name: string;
    columns: { attnum: number; name: string; type: DataType; notNull: boolean; defaultText: string | null; defaultValue: SqlValue }[];
    uniqueIndexes: { name: string; attnums: number[] }[];
}

function tableShape(database: Database, ref: RelationRef): TableShape {
    if (ref.schema !== undefined && ref.schema !== 'public') throw new ServerError('3F000', `schema "${ref.schema}" does not exist`);
    const relation = relationByName(database.catalog, ref.name);
    if (!relation || relation.relkind !== 'r') throw new ServerError('42P01', `relation "${ref.name}" does not exist`);
    const columns = database.catalog.columns
        .filter((column) => column.relid === relation.oid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({
            attnum: column.attnum,
            name: column.name,
            type: typeByOid(column.typeOid, column.typmod),
            notNull: column.notNull,
            defaultText: column.defaultText,
            defaultValue: column.defaultValue,
        }));
    const uniqueIndexes = database.catalog.indexes
        .filter((index) => index.relid === relation.oid && index.unique)
        .map((index) => ({ name: index.name, attnums: index.indkey }));
    return { oid: relation.oid, name: relation.name, columns, uniqueIndexes };
}

function insertRows(database: Database, statement: InsertStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    const targetColumns = statement.columns
        ? statement.columns.map((columnName) => {
                const column = shape.columns.find((candidate) => candidate.name === columnName);
                if (!column) throw new ServerError('42703', `column "${columnName}" of relation "${shape.name}" does not exist`);
                return column;
            })
        : shape.columns;
    const inserted: { key: string; values: SqlValue[] }[] = [];
    const rows = statement.defaultValues ? [[]] : statement.rows;
    for (const source of rows) {
        if (!statement.defaultValues) {
            if (source.length > targetColumns.length) throw new ServerError('42601', 'INSERT has more expressions than target columns');
            if (source.length < targetColumns.length) throw new ServerError('42601', 'INSERT has more target columns than expressions');
        }
        const values = shape.columns.map((column) => column.defaultValue ?? null);
        source.forEach((expr, index) => {
            const column = targetColumns[index];
            if (!column) return;
            const raw = expr.kind === 'default' ? column.defaultValue ?? null : evaluate(database, expr, emptyContext(), params);
            values[column.attnum - 1] = coerce(raw, column.type);
        });
        for (const column of shape.columns) {
            if (column.notNull && (values[column.attnum - 1] ?? null) === null) {
                throw new ServerError('23502', `null value in column "${column.name}" of relation "${shape.name}" violates not-null constraint`);
            }
        }
        const key = database.insertRow(shape.oid, values);
        inserted.push({ key, values });
        checkUnique(database, shape, values, new Set([key]));
    }
    return returningOutcome(database, statement.returning, shape, inserted, params, `INSERT 0 ${inserted.length}`);
}

function updateRows(database: Database, statement: UpdateStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    for (const assignment of statement.assignments) {
        if (!shape.columns.some((column) => column.name === assignment.column)) {
            throw new ServerError('42703', `column "${assignment.column}" of relation "${shape.name}" does not exist`);
        }
    }
    const alias = statement.table.name;
    const columns: Binding[] = shape.columns.map((column) => ({ alias, name: column.name, type: column.type }));
    const rows = database.table(shape.oid);
    const updated: { key: string; values: SqlValue[] }[] = [];
    for (const [key, values] of [...rows.entries()]) {
        const context: Context = { columns, row: values, outer: undefined };
        if (statement.where && evaluate(database, statement.where, context, params) !== true) continue;
        const next = [...values];
        for (const assignment of statement.assignments) {
            const column = shape.columns.find((candidate) => candidate.name === assignment.column)!;
            next[column.attnum - 1] = coerce(evaluate(database, assignment.value, context, params), column.type);
        }
        for (const column of shape.columns) {
            if (column.notNull && (next[column.attnum - 1] ?? null) === null) {
                throw new ServerError('23502', `null value in column "${column.name}" of relation "${shape.name}" violates not-null constraint`);
            }
        }
        updated.push({ key, values: next });
    }
    for (const row of updated) database.updateRow(shape.oid, row.key, row.values);
    for (const row of updated) checkUnique(database, shape, row.values, new Set([row.key]));
    return returningOutcome(database, statement.returning, shape, updated, params, `UPDATE ${updated.length}`);
}

function deleteRows(database: Database, statement: DeleteStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    const alias = statement.table.name;
    const columns: Binding[] = shape.columns.map((column) => ({ alias, name: column.name, type: column.type }));
    const rows = database.table(shape.oid);
    const removed: { key: string; values: SqlValue[] }[] = [];
    for (const [key, values] of [...rows.entries()]) {
        const context: Context = { columns, row: values, outer: undefined };
        if (statement.where && evaluate(database, statement.where, context, params) !== true) continue;
        removed.push({ key, values });
    }
    for (const row of removed) database.deleteRow(shape.oid, row.key);
    return returningOutcome(database, statement.returning, shape, removed, params, `DELETE ${removed.length}`);
}

function returningOutcome(
    database: Database,
    targets: Target[] | undefined,
    shape: TableShape,
    rows: { key: string; values: SqlValue[] }[],
    params: SqlValue[],
    tag: string,
): Outcome {
    if (!targets) return { kind: 'command', tag };
    const alias = shape.name;
    const columns: Binding[] = shape.columns.map((column) => ({ alias, name: column.name, type: column.type }));
    const expanded = expandTargets(database, targets, columns);
    const fields: Field[] = expanded.map((target) => ({
        name: targetName(target),
        type: fieldType(database, target.expr, { columns, outer: undefined }, params),
    }));
    const output = rows.map((row) => {
        const context: Context = { columns, row: row.values, outer: undefined };
        return expanded.map((target) => evaluate(database, target.expr, context, params));
    });
    return { kind: 'rows', fields, rows: output, tag };
}

function checkUnique(database: Database, shape: TableShape, values: SqlValue[], skipKeys: Set<string>): void {
    const rows = database.table(shape.oid);
    for (const index of shape.uniqueIndexes) {
        const candidate = index.attnums.map((attnum) => values[attnum - 1] ?? null);
        if (candidate.some((value) => value === null)) continue;
        for (const [key, other] of rows) {
            if (skipKeys.has(key)) continue;
            const existing = index.attnums.map((attnum) => other[attnum - 1] ?? null);
            if (existing.some((value) => value === null)) continue;
            const same = candidate.every((value, position) => compareValues(value, existing[position] ?? null) === 0);
            if (!same) continue;
            const labels = index.attnums
                .map((attnum) => shape.columns.find((column) => column.attnum === attnum)?.name ?? `attnum${attnum}`)
                .join(', ');
            const rendered = candidate.map((value) => formatValue(value, TEXT)).join(', ');
            throw new ServerError('23505', `duplicate key value violates unique constraint "${index.name}"`, `Key (${labels})=(${rendered}) already exists.`);
        }
    }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Coerces one evaluated value to the column type. */
function coerce(value: SqlValue, type: DataType): SqlValue {
    if (value === null) return null;
    if (typeof value === 'boolean') return type.key === 'bool' ? value : parseLiteral(value ? 't' : 'f', type);
    if (typeof value === 'number') return parseLiteral(String(value), type);
    return parseLiteral(value, type);
}

/** Renders the `pg_get_expr` text for one literal default. */
function renderDefault(value: SqlValue, type: DataType): string {
    const name = formatType(type).replace(/\(.*\)$/, '');
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (value < 0) return `'${value}'::${name}`;
        return String(value);
    }
    const escaped = String(value).replace(/'/g, "''");
    return `'${escaped}'::${name}`;
}
