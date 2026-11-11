/** Statement execution: DDL, DML and the SELECT subset psql's `\\d` needs. */

import { ServerError } from '../errors.ts';
import {
    type CatalogDoc,
    type ColumnMeta,
    type UserIndexKey,
    type UserRelation,
    PUBLIC_NAMESPACE,
    SYSTEM_NAMESPACES,
    catalogTables,
    describeObject,
    formatTypeByOid,
    functionNameFor,
    namespaceNameFor,
    objectDescription,
    pgGetConstraintDef,
    pgGetExpr,
    pgGetIndexDef,
    pgGetUserById,
    pgRelationIsPublishable,
    pgTableIsVisible,
    relationByName,
    relationDisplayName,
    relationOidForName,
    systemColumns,
    systemRelationOidForName,
    typeByOid,
} from './catalog.ts';
import type { Database, IndexScanStat } from './database.ts';
import { type ClusterRole, findRole, hasDatabasePrivilege, roleIsSuperuser } from './cluster.ts';
import { deriveScramSecret, formatScramVerifier, parseScramVerifier } from '../scram.ts';
import { defaultAcl, defaultNamespaceAcl, formatAcl, grantAcl, parseAcl, privilegeLetters, revokeAcl } from './acl.ts';
import {
    checkGrant,
    checkGrantOnOid,
    checkGrantOnTable,
    checkTableOwner,
    currentRole,
    currentRoleOid,
    namespaceOid,
} from './privilege.ts';
import {
    type ArrayExpr,
    type AnyExpr,
    type BinaryExpr,
    type CaseExpr,
    type CastExpr,
    type ColumnDef,
    type ColumnExpr,
    type CommonTableExpression,
    type AnalyzeStatement,
    type CreateIndexStatement,
    type CreateTableStatement,
    type CreateViewStatement,
    type DeleteStatement,
    type DropIndexStatement,
    type DropTableStatement,
    type DropViewStatement,
    type ExplainStatement,
    type Expr,
    type FrameBound,
    type FromItem,
    type FunctionExpr,
    type InExpr,
    type InsertStatement,
    type IsNullExpr,
    type LiteralExpr,
    type OrderItem,
    type ParamExpr,
    type ReferenceClause,
    type RelationRef,
    type SelectStatement,
    type Statement,
    type SubqueryExpr,
    type Target,
    type AlterTableStatement,
    type AlterRoleStatement,
    type CreateRoleStatement,
    type DropRoleStatement,
    type GrantStatement,
    type RevokeStatement,
    type UnaryExpr,
    type UpdateStatement,
    type VacuumStatement,
    type WindowFrame,
    type WindowSpec,
    parseExpression,
    parseViewQuery,
} from './parser.ts';
import {
    BOOL,
    INT4,
    TEXT,
    arrayOf,
    arrayValueText,
    castValue,
    compareValues,
    formatType,
    formatValue,
    numericSpecial,
    parseLiteral,
    type DataType,
    type SqlValue,
    typeOf,
    typeOid,
} from './types.ts';

/**
 * Cooperative `statement_timeout` deadline: epoch milliseconds, `Infinity`
 * when unarmed. The session arms it around one statement and the executor
 * checks it at row boundaries, so a long scan, join or aggregate aborts with
 * `57014` the way PostgreSQL cancels a timed-out statement.
 */
let statementDeadline = Number.POSITIVE_INFINITY;

/** Arms one statement's deadline and returns the value it replaced. */
export function armStatementDeadline(deadline: number): number {
    const previous = statementDeadline;
    statementDeadline = Math.min(previous, deadline);
    return previous;
}

/** Restores the deadline a previous arm returned. */
export function restoreStatementDeadline(deadline: number): void {
    statementDeadline = deadline;
}

/** Aborts the running statement once its armed deadline has passed. */
function checkStatementDeadline(): void {
    if (statementDeadline === Number.POSITIVE_INFINITY || Date.now() <= statementDeadline) return;
    throw new ServerError('57014', 'canceling statement due to statement timeout');
}

export interface Field {
    name: string;
    type: DataType;
}

export type Outcome =
    | { kind: 'rows'; fields: Field[]; rows: SqlValue[][]; tag: string }
    | { kind: 'command'; tag: string; notices?: { code: string; message: string; severity?: 'NOTICE' | 'WARNING' }[] };

interface Binding {
    alias: string;
    name: string;
    type: DataType;
    /** System columns resolve by name but never expand through `*`. */
    hidden?: boolean;
    /** Extra relation aliases that expose the same value, added by `USING`/`NATURAL`. */
    aliases?: string[];
}

/** Whether `qualifier` names the relation this binding belongs to. */
function matchesAlias(binding: Binding, qualifier: string): boolean {
    return binding.alias === qualifier || binding.aliases?.includes(qualifier) === true;
}

interface RowSet {
    columns: Binding[];
    rows: SqlValue[][];
    /** 行已按 `ORDER BY` 要求的键序产出，外层无需再排序。 */
    ordered?: boolean;
}

/** 单表有序访问：`items` 来自 `ORDER BY`，`limit` 是允许提前停止的行数，0 表示不限。 */
interface OrderedAccess {
    items: OrderItem[];
    limit: number;
}

interface Context {
    columns: Binding[];
    row: SqlValue[];
    outer: Context | undefined;
    /** Rows in the current aggregate group, absent outside a grouped query. */
    group?: Context[];
    /** Precomputed window-function values, indexed by output row. */
    windowValues?: Map<FunctionExpr, SqlValue[]>;
    windowIndex?: number;
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
        case 'create-view':
            return 'CREATE VIEW';
        case 'drop-view':
            return 'DROP VIEW';
        case 'vacuum':
            return 'VACUUM';
        case 'analyze':
            return 'ANALYZE';
        case 'create-index':
            return 'CREATE INDEX';
        case 'drop-index':
            return 'DROP INDEX';
        case 'alter-table':
            return 'ALTER TABLE';
        case 'transaction':
            return 'TRANSACTION';
        default:
            return statement.kind.toUpperCase();
    }
}

/** Runs one already-parsed statement against the message's working set. */
export function runStatement(database: Database, statement: Statement, params: SqlValue[]): Outcome {
    switch (statement.kind) {
        case 'select': {
            const result = executeSelect(database, statement, params, undefined);
            return { kind: 'rows', fields: result.fields, rows: result.rows, tag: `SELECT ${result.rows.length}` };
        }
        case 'explain':
            return explainStatement(database, statement, params);
        case 'create-table':
            return createTable(database, statement);
        case 'drop-table':
            return dropTable(database, statement);
        case 'create-view':
            return createView(database, statement);
        case 'drop-view':
            return dropView(database, statement);
        case 'vacuum':
            return runVacuum(database, statement);
        case 'analyze':
            return runAnalyze(database, statement);
        case 'insert':
            return insertRows(database, statement, params);
        case 'update':
            return updateRows(database, statement, params);
        case 'delete':
            return deleteRows(database, statement, params);
        case 'create-index':
            return createIndex(database, statement);
        case 'drop-index':
            return dropIndex(database, statement);
        case 'alter-table':
            return alterTable(database, statement);
        case 'create-role':
            return createRole(database, statement);
        case 'alter-role':
            return alterRole(database, statement);
        case 'drop-role':
            return dropRole(database, statement);
        case 'grant':
            return grantPrivileges(database, statement);
        case 'revoke':
            return revokePrivileges(database, statement);
        case 'transaction':
            throw new ServerError('0A000', 'feature not supported', 'transaction control is handled by the session');
    }
    throw new ServerError('0A000', 'feature not supported', `${emptyTagName(statement)} is not implemented`);
}

/** Field metadata for `Describe` on a SELECT, without running side effects. */
export function describeSelect(database: Database, statement: SelectStatement, params: SqlValue[]): Field[] {
    const result = executeSelect(database, statement, params, undefined);
    return result.fields;
}

/** Parameter types PostgreSQL infers from the `INSERT` / `UPDATE` target columns. */
export function inferParameterTypes(database: Database, statement: Statement, count: number): (DataType | undefined)[] {
    const types = new Array<DataType | undefined>(count).fill(undefined);
    const record = (expr: Expr, type: DataType): void => {
        if (expr.kind === 'param') {
            const index = (expr as ParamExpr).index;
            if (index >= 1 && index <= count) types[index - 1] = type;
            return;
        }
        if (expr.kind === 'cast' && (expr as CastExpr).expr.kind === 'param') {
            const index = ((expr as CastExpr).expr as ParamExpr).index;
            if (index >= 1 && index <= count) types[index - 1] = (expr as CastExpr).type;
        }
    };
    if (statement.kind === 'insert') {
        const shape = tableShape(database, statement.table);
        const targets = statement.columns
            ? statement.columns.map((name) => shape.columns.find((column) => column.name === name))
            : shape.columns;
        for (const row of statement.rows) {
            row.forEach((expr, index) => {
                const column = targets[index];
                if (column) record(expr, column.type);
            });
        }
    } else if (statement.kind === 'update') {
        const shape = tableShape(database, statement.table);
        for (const assignment of statement.assignments) {
            const column = shape.columns.find((candidate) => candidate.name === assignment.column);
            if (column) record(assignment.value, column.type);
        }
    }
    return types;
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
    context?: Context;
}

/** Innermost scope first; `WITH` shadows relations for the query it precedes. */
const cteScopes: Map<string, RowSet>[] = [];

function executeSelect(database: Database, select: SelectStatement, params: SqlValue[], outer: Context | undefined): SelectResult {
    if (select.with) {
        const scope = new Map<string, RowSet>();
        cteScopes.push(scope);
        try {
            for (const cte of select.with.ctes) {
                if (select.with.recursive && referencesRelation(cte.select, cte.name)) {
                    evaluateRecursiveCte(database, cte, params, outer, scope);
                }
                else {
                    const result = executeSelect(database, cte.select, params, outer);
                    const names = cte.columns ?? result.fields.map((field, index) => field.name || `column${index + 1}`);
                    scope.set(cte.name.toLowerCase(), {
                        columns: names.map((name, index) => ({ alias: cte.name, name, type: result.fields[index]?.type ?? TEXT })),
                        rows: result.rows,
                    });
                }
            }
            return executeSelectBody(database, select, params, outer);
        }
        finally {
            cteScopes.pop();
        }
    }
    return executeSelectBody(database, select, params, outer);
}

function executeSelectBody(database: Database, select: SelectStatement, params: SqlValue[], outer: Context | undefined): SelectResult {
    const orderBy = select.orderBy;
    const ops = select.unions;
    const orderedAccess = ops.length === 0 && orderBy.length > 0 && rowPreserving(select.core, orderBy)
        ? scanWindow(database, select, params)
        : undefined;
    const results: { fields: Field[]; entries: Entry[]; ordered?: boolean }[] = [
        executeCore(database, select.core, params, outer, ops.length === 0 ? orderBy : [], orderedAccess),
    ];
    if (ops.length === 0) return finishSelect(database, results[0]!, select, params);
    for (const op of ops) results.push(executeCore(database, op.core, params, outer, []));

    const width = results[0]!.fields.length;
    for (const result of results) {
        if (result.fields.length !== width) {
            throw new ServerError('42601', 'each UNION query must have the same number of columns');
        }
    }

    // INTERSECT binds tighter than UNION and EXCEPT, so fold the intersect runs
    // first and then combine the resulting terms left to right.
    let term = results[0]!;
    const terms: { fields: Field[]; entries: Entry[] }[] = [];
    const seps: { op: 'union' | 'except'; all: boolean }[] = [];
    for (let index = 0; index < ops.length; index += 1) {
        const op = ops[index]!;
        const right = results[index + 1]!;
        if (op.op === 'intersect') {
            term = { fields: term.fields, entries: setCombine('intersect', term.entries, right.entries, op.all) };
            continue;
        }
        terms.push(term);
        seps.push({ op: op.op, all: op.all });
        term = right;
    }
    terms.push(term);
    let combined = terms[0]!;
    for (let index = 0; index < seps.length; index += 1) {
        const sep = seps[index]!;
        const right = terms[index + 1]!;
        combined = { fields: combined.fields, entries: setCombine(sep.op, combined.entries, right.entries, sep.all) };
    }
    return finishSelect(database, combined, select, params);
}

/**
 * `LIMIT` 能否下推到扫描：分组、聚合、去重与窗口函数都会改变行数或依赖全部输入行，
 * 这类查询只允许按索引键序扫描，不允许提前停止。
 */
function rowPreserving(core: SelectStatement['core'], orderBy: OrderItem[]): boolean {
    if (core.groupBy.length > 0 || core.having !== undefined || core.distinct) return false;
    const exprs = [...core.targets.map((target) => target.expr), ...orderBy.map((item) => item.expr)];
    return !exprs.some((expr) => containsAggregate(expr)) && collectWindows(exprs).length === 0;
}

/** `ORDER BY` 需要的行数与偏移；只有常量且非负时才允许提前截断扫描。 */
function scanWindow(database: Database, select: SelectStatement, params: SqlValue[]): OrderedAccess {
    let limit = 0;
    if (select.limit !== undefined) limit = Number(evaluate(database, select.limit, emptyContext(), params));
    let offset = 0;
    if (select.offset !== undefined) offset = Number(evaluate(database, select.offset, emptyContext(), params));
    const usable = Number.isFinite(limit) && Number.isFinite(offset) && limit >= 0 && offset >= 0;
    return { items: select.orderBy, limit: usable ? limit + offset : 0 };
}

function finishSelect(database: Database, result: { fields: Field[]; entries: Entry[]; ordered?: boolean }, select: SelectStatement, params: SqlValue[]): SelectResult {
    const entries = result.entries;
    // 有序索引扫描已经按 `ORDER BY` 产出，再排序只会白付一次全量比较。
    if (select.orderBy.length > 0 && result.ordered !== true) {
        if (select.unions.length === 0) entries.sort((left, right) => compareEntries(left, right, select.orderBy));
        else {
            const keyed = entries.map((entry) => ({
                values: entry.values,
                keys: select.orderBy.map((item) => outputKey(item, entry.values, result.fields)),
                context: entry.context,
            }));
            keyed.sort((left, right) => compareEntries(left, right, select.orderBy));
            entries.splice(0, entries.length, ...keyed);
        }
    }
    const offset = select.offset === undefined ? 0 : Number(evaluate(database, select.offset, emptyContext(), params));
    const limit = select.limit === undefined ? Number.POSITIVE_INFINITY : Number(evaluate(database, select.limit, emptyContext(), params));
    const rows = entries
        .slice(Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) && Number.isFinite(offset) ? offset + limit : undefined)
        .map((entry) => entry.values);
    return { fields: result.fields, rows };
}

/** Set-operation evaluation. `all` keeps duplicate multiplicity. */
function setCombine(op: 'union' | 'intersect' | 'except', left: Entry[], right: Entry[], all: boolean): Entry[] {
    const keyOf = (entry: Entry): string => JSON.stringify(entry.values);
    if (op === 'union') {
        if (all) return [...left, ...right];
        const seen = new Set<string>();
        const result: Entry[] = [];
        for (const entry of [...left, ...right]) {
            const key = keyOf(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(entry);
        }
        return result;
    }
    const rightKeys = new Set(right.map(keyOf));
    if (op === 'intersect') {
        if (all) {
            const counts = new Map<string, number>();
            for (const entry of right) counts.set(keyOf(entry), (counts.get(keyOf(entry)) ?? 0) + 1);
            const result: Entry[] = [];
            for (const entry of left) {
                const key = keyOf(entry);
                const remaining = counts.get(key) ?? 0;
                if (remaining === 0) continue;
                counts.set(key, remaining - 1);
                result.push(entry);
            }
            return result;
        }
        const seen = new Set<string>();
        const result: Entry[] = [];
        for (const entry of left) {
            const key = keyOf(entry);
            if (!rightKeys.has(key) || seen.has(key)) continue;
            seen.add(key);
            result.push(entry);
        }
        return result;
    }
    if (all) {
        const counts = new Map<string, number>();
        for (const entry of right) counts.set(keyOf(entry), (counts.get(keyOf(entry)) ?? 0) + 1);
        const result: Entry[] = [];
        for (const entry of left) {
            const key = keyOf(entry);
            const remaining = counts.get(key) ?? 0;
            if (remaining === 0) {
                result.push(entry);
                continue;
            }
            counts.set(key, remaining - 1);
        }
        return result;
    }
    const seen = new Set<string>();
    const result: Entry[] = [];
    for (const entry of left) {
        const key = keyOf(entry);
        if (rightKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
    }
    return result;
}


/** True when the query's FROM tree mentions `name`; drives recursive CTE detection. */
function referencesRelation(select: SelectStatement, name: string): boolean {
    const wanted = name.toLowerCase();
    const coreReferences = (core: SelectStatement['core']): boolean => core.from.some((item) => fromItemReferences(item, wanted));
    if (coreReferences(select.core)) return true;
    return select.unions.some((union) => coreReferences(union.core));
}

function fromItemReferences(item: FromItem, name: string): boolean {
    if (item.kind === 'relation') return item.args === undefined && item.name.toLowerCase() === name;
    if (item.kind === 'subquery') return referencesRelation(item.select, name);
    return fromItemReferences(item.left, name) || fromItemReferences(item.right, name);
}

/**
 * Runs `WITH RECURSIVE`: evaluate the anchor, then keep re-running the
 * recursive terms against the accumulated rows until nothing new appears.
 */
function evaluateRecursiveCte(
    database: Database,
    cte: CommonTableExpression,
    params: SqlValue[],
    outer: Context | undefined,
    scope: Map<string, RowSet>,
): void {
    const ops = cte.select.unions;
    if (ops.length === 0) {
        throw new ServerError('42601', 'recursive query "' + cte.name + '" must have a UNION or UNION ALL clause');
    }
    const anchor = executeCore(database, cte.select.core, params, outer, []);
    const names = cte.columns ?? anchor.fields.map((field, index) => field.name || `column${index + 1}`);
    let rows = anchor.entries.map((entry) => entry.values);
    scope.set(cte.name.toLowerCase(), {
        columns: names.map((name, index) => ({ alias: cte.name, name, type: anchor.fields[index]?.type ?? TEXT })),
        rows,
    });
    const seen = new Set(rows.map((row) => JSON.stringify(row)));
    let iterations = 0;
    while (iterations < 1000) {
        iterations += 1;
        let added = 0;
        for (const op of ops) {
            const result = executeCore(database, op.core, params, outer, []);
            const fresh: SqlValue[][] = [];
            for (const entry of result.entries) {
                const key = JSON.stringify(entry.values);
                if (seen.has(key)) continue;
                seen.add(key);
                fresh.push(entry.values);
            }
            rows = [...rows, ...fresh];
            added += fresh.length;
            scope.get(cte.name.toLowerCase())!.rows = rows;
        }
        if (added === 0) return;
    }
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
    orderedAccess?: OrderedAccess,
): { fields: Field[]; entries: Entry[]; ordered?: boolean } {
    const valuesList = core.values;
    if (valuesList) {
        const width = valuesList[0]?.length ?? 0;
        const fields: Field[] = Array.from({ length: width }, (_, index) => ({
            name: `column${index + 1}`,
            type: staticExprType(valuesList[0]?.[index] ?? { kind: 'literal', value: null, text: 'NULL' }) ?? TEXT,
        }));
        const entries = valuesList.map((row) => ({ values: row.map((expr) => evaluate(database, expr, emptyContext(), params)), keys: [] as SqlValue[] }));
        return { fields, entries };
    }
    const from = buildFrom(database, core.from, params, outer, core.where, orderedAccess);
    const targets = expandTargets(database, core.targets, from.columns);
    const scope: Scope = { columns: from.columns, outer: outer ? { columns: outer.columns, outer: undefined } : undefined };
    const fields: Field[] = targets.map((target) => ({ name: targetName(target), type: fieldType(database, target.expr, scope, params) }));
    const groupBy = resolveGroupBy(core.groupBy, targets, scope);

    // WHERE runs per input row; grouping and windows need the surviving rows.
    const rows: Context[] = [];
    for (const row of from.rows) {
        checkStatementDeadline();
        const context: Context = { columns: from.columns, row, outer };
        if (core.where) {
            const keep = evaluate(database, core.where, context, params);
            if (keep !== true) continue;
        }
        rows.push(context);
    }

    const grouped = groupBy.length > 0
        || core.having !== undefined
        || targets.some((target) => containsAggregate(target.expr))
        || orderBy.some((item) => containsAggregate(item.expr));
    let contexts: Context[];
    if (grouped) {
        validateGrouped(targets, core.having, orderBy, groupBy, scope, fields);
        contexts = [];
        for (const group of groupRows(database, groupBy, rows, params)) {
            const groupContext: Context = { columns: from.columns, row: group[0]?.row ?? [], outer, group };
            if (core.having !== undefined && evaluate(database, core.having, groupContext, params) !== true) continue;
            contexts.push(groupContext);
        }
    }
    else {
        contexts = rows;
    }

    const windows = collectWindows([...targets.map((target) => target.expr), ...orderBy.map((item) => item.expr)]);
    const windowValues = new Map<FunctionExpr, SqlValue[]>();
    if (windows.length > 0) computeWindows(database, windows, contexts, params, windowValues);

    const entries: Entry[] = [];
    contexts.forEach((context, index) => {
        const evalContext: Context = windows.length > 0 ? { ...context, windowValues, windowIndex: index } : context;
        const values = targets.map((target) => evaluate(database, target.expr, evalContext, params));
        const keys = orderBy.map((item) => orderKey(database, item, evalContext, values, fields, params));
        entries.push({ values, keys, context: evalContext });
    });
    if (core.distinct) {
        const seen = new Set<string>();
        const kept: Entry[] = [];
        for (const entry of entries) {
            const key = JSON.stringify(entry.values);
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push(entry);
        }
        entries.splice(0, entries.length, ...kept);
    }
    return { fields, entries, ordered: grouped ? undefined : from.ordered };
}

const AGGREGATE_NAMES = new Set(['count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'every']);

function isAggregate(node: Expr): boolean {
    return node.kind === 'function' && (node as FunctionExpr).over === undefined && AGGREGATE_NAMES.has((node as FunctionExpr).name.toLowerCase());
}

function containsAggregate(node: Expr | undefined): boolean {
    if (node === undefined) return false;
    if (isAggregate(node)) return true;
    let found = false;
    walkExpr(node, (child) => {
        if (isAggregate(child)) found = true;
    });
    return found;
}

/** Visits every expression node, including subquery bodies left alone. */
function walkExpr(node: Expr, visit: (node: Expr) => void): void {
    visit(node);
    switch (node.kind) {
        case 'cast':
        case 'unary':
        case 'collate':
        case 'subscript':
            walkExpr((node as { expr: Expr }).expr, visit);
            break;
        case 'binary':
            walkExpr((node as BinaryExpr).left, visit);
            walkExpr((node as BinaryExpr).right, visit);
            break;
        case 'any':
            walkExpr((node as AnyExpr).left, visit);
            walkExpr((node as AnyExpr).array, visit);
            break;
        case 'case': {
            const node2 = node as CaseExpr;
            if (node2.operand) walkExpr(node2.operand, visit);
            for (const branch of node2.whens) {
                walkExpr(branch.when, visit);
                walkExpr(branch.then, visit);
            }
            if (node2.otherwise) walkExpr(node2.otherwise, visit);
            break;
        }
        case 'in': {
            const node2 = node as InExpr;
            walkExpr(node2.expr, visit);
            for (const item of node2.list) walkExpr(item, visit);
            break;
        }
        case 'isnull':
            walkExpr((node as IsNullExpr).expr, visit);
            break;
        case 'array':
            for (const element of (node as ArrayExpr).elements ?? []) walkExpr(element, visit);
            break;
        case 'function': {
            const node2 = node as FunctionExpr;
            for (const argument of node2.args) walkExpr(argument, visit);
            break;
        }
        default:
            break;
    }
}

function collectWindows(roots: Expr[]): FunctionExpr[] {
    const result: FunctionExpr[] = [];
    const seen = new Set<FunctionExpr>();
    const walk = (node: Expr): void => {
        if (node.kind === 'function' && (node as FunctionExpr).over !== undefined && !seen.has(node as FunctionExpr)) {
            seen.add(node as FunctionExpr);
            result.push(node as FunctionExpr);
        }
        let children: Expr[] = [];
        switch (node.kind) {
            case 'cast':
            case 'unary':
            case 'collate':
            case 'subscript':
                children = [(node as { expr: Expr }).expr];
                break;
            case 'binary':
                children = [(node as BinaryExpr).left, (node as BinaryExpr).right];
                break;
            case 'any':
                children = [(node as AnyExpr).left, (node as AnyExpr).array];
                break;
            case 'case': {
                const node2 = node as CaseExpr;
                children = [node2.operand, node2.otherwise, ...node2.whens.flatMap((branch) => [branch.when, branch.then])].filter((child): child is Expr => child !== undefined);
                break;
            }
            case 'in':
                children = [(node as InExpr).expr, ...(node as InExpr).list];
                break;
            case 'isnull':
                children = [(node as IsNullExpr).expr];
                break;
            case 'array':
                children = (node as ArrayExpr).elements ?? [];
                break;
            case 'function':
                children = (node as FunctionExpr).args;
                break;
            default:
                break;
        }
        for (const child of children) walk(child);
    };
    for (const root of roots) walk(root);
    return result;
}

/**
 * Rewrites `GROUP BY` ordinals and output aliases into input expressions.
 *
 * Input columns win over output aliases, matching the server, and an output
 * alias only resolves when exactly one target carries that name.
 */
function resolveGroupBy(groupBy: Expr[], targets: Target[], scope: Scope): Expr[] {
    return groupBy.map((expr) => {
        let resolved = expr;
        if (expr.kind === 'literal' && Number.isInteger((expr as LiteralExpr).value) && typeof (expr as LiteralExpr).value === 'number') {
            const position = Number((expr as LiteralExpr).value);
            const target = targets[position - 1];
            if (target === undefined) {
                throw new ServerError('42P10', `GROUP BY position ${position} is not in select list`, undefined, expr.start);
            }
            resolved = target.expr;
        }
        else if (expr.kind === 'column' && (expr as ColumnExpr).qualifier === undefined) {
            const name = (expr as ColumnExpr).name;
            const isInput = scope.columns.some((column) => column.name === name)
                || scope.outer?.columns.some((column) => column.name === name) === true;
            if (!isInput) {
                const matches = targets.filter((target) => targetName(target) === name);
                if (matches.length > 1) throw new ServerError('42702', `GROUP BY "${name}" is ambiguous`, undefined, expr.start);
                if (matches.length === 1) resolved = matches[0]!.expr;
            }
        }
        if (containsAggregate(resolved)) {
            throw new ServerError('42803', 'aggregate functions are not allowed in GROUP BY', undefined, expr.start);
        }
        return resolved;
    });
}

interface GroupedColumns {
    /** `alias\0name` for every plain column the grouping exposes. */
    identities: Set<string>;
    /** Structural shapes of grouping expressions, so repeated expressions match. */
    shapes: Set<string>;
}

function bindingIdentity(binding: Binding): string {
    return `${binding.alias}\u0000${binding.name}`;
}

function exprShape(expr: Expr): string {
    return JSON.stringify(expr, (key, value) => key === 'start' ? undefined : value);
}

/** Rejects target, `HAVING` and `ORDER BY` columns that grouping does not expose. */
function validateGrouped(targets: Target[], having: Expr | undefined, orderBy: OrderItem[], groupBy: Expr[], scope: Scope, fields: Field[]): void {
    const identities = new Set<string>();
    const shapes = new Set<string>();
    for (const expr of groupBy) {
        shapes.add(exprShape(expr));
        if (expr.kind !== 'column') continue;
        const column = expr as ColumnExpr;
        const binding = findBinding(scope, column.qualifier, column.name, column.start);
        if (binding !== undefined) identities.add(bindingIdentity(binding));
    }
    const grouped: GroupedColumns = { identities, shapes };
    for (const target of targets) validateUngrouped(target.expr, grouped, scope);
    if (having !== undefined) validateUngrouped(having, grouped, scope);
    for (const item of orderBy) {
        const expr = item.expr;
        if (expr.kind === 'column' && (expr as ColumnExpr).qualifier === undefined) {
            const name = (expr as ColumnExpr).name;
            // A bare name that matches an output column is an alias reference.
            if (fields.some((field) => field.name === name)) continue;
        }
        validateUngrouped(expr, grouped, scope);
    }
}

function validateUngrouped(expr: Expr, grouped: GroupedColumns, scope: Scope): void {
    if (grouped.shapes.has(exprShape(expr))) return;
    if (isAggregate(expr)) return;
    if (expr.kind === 'subquery') return;
    if (expr.kind === 'column') {
        const column = expr as ColumnExpr;
        const binding = findBinding(scope, column.qualifier, column.name, column.start);
        if (binding === undefined) return;
        if (!grouped.identities.has(bindingIdentity(binding))) {
            throw new ServerError('42803', `column "${binding.alias}.${binding.name}" must appear in the GROUP BY clause or be used in an aggregate function`, undefined, column.start);
        }
        return;
    }
    for (const child of expressionChildren(expr)) validateUngrouped(child, grouped, scope);
}

/** Immediate sub-expressions that can carry column references. */
function expressionChildren(node: Expr): Expr[] {
    switch (node.kind) {
        case 'cast':
        case 'unary':
        case 'collate':
        case 'subscript':
            return [(node as { expr: Expr }).expr];
        case 'binary':
            return [(node as BinaryExpr).left, (node as BinaryExpr).right];
        case 'any':
            return [(node as AnyExpr).left, (node as AnyExpr).array];
        case 'case': {
            const node2 = node as CaseExpr;
            return [node2.operand, node2.otherwise, ...node2.whens.flatMap((branch) => [branch.when, branch.then])]
                .filter((child): child is Expr => child !== undefined);
        }
        case 'in': {
            const node2 = node as InExpr;
            return [node2.expr, ...node2.list];
        }
        case 'isnull':
            return [(node as IsNullExpr).expr];
        case 'array':
            return (node as ArrayExpr).elements ?? [];
        case 'function':
            return (node as FunctionExpr).args;
        default:
            return [];
    }
}

function groupRows(database: Database, groupBy: Expr[], rows: Context[], params: SqlValue[]): Context[][] {
    if (groupBy.length === 0) return [rows];
    const buckets = new Map<string, Context[]>();
    for (const row of rows) {
        const key = JSON.stringify(groupBy.map((expr) => evaluate(database, expr, row, params)));
        const bucket = buckets.get(key);
        if (bucket) bucket.push(row);
        else buckets.set(key, [row]);
    }
    return [...buckets.values()];
}

function orderKey(database: Database, item: OrderItem, context: Context, values: SqlValue[], fields: Field[], params: SqlValue[]): SqlValue {
    const expr = item.expr;
    if (expr.kind === 'literal' && typeof (expr as { value: SqlValue }).value === 'number') {
        const index = Number((expr as { value: SqlValue }).value) - 1;
        return values[index] ?? null;
    }
    if (expr.kind === 'column' && (expr as ColumnExpr).qualifier === undefined) {
        const columnName = (expr as ColumnExpr).name;
        const matches: number[] = [];
        fields.forEach((field, index) => {
            if (field.name === columnName) matches.push(index);
        });
        if (matches.length > 1) throw new ServerError('42702', `ORDER BY "${columnName}" is ambiguous`, undefined, (expr as ColumnExpr).start);
        if (matches.length === 1) return values[matches[0]!] ?? null;
    }
    return evaluate(database, expr, context, params);
}

function expandTargets(database: Database, targets: Target[], columns: Binding[]): Target[] {
    const expanded: Target[] = [];
    for (const target of targets) {
        if (target.expr.kind === 'star') {
            const qualifier = (target.expr as { qualifier: string | undefined }).qualifier;
            for (const binding of columns) {
                if (binding.hidden) continue;
                if (qualifier !== undefined && !matchesAlias(binding, qualifier)) continue;
                expanded.push({ expr: { kind: 'column', qualifier: qualifier ?? binding.alias, name: binding.name } satisfies ColumnExpr, alias: undefined });
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
            const literal = expr as LiteralExpr;
            const value = literal.value;
            if (typeof value === 'boolean') return BOOL;
            if (typeof value === 'number') return Number.isInteger(value) ? INT4 : typeOf('numeric');
            if (literal.numeric === true) return typeOf('numeric');
            return TEXT;
        }
        case 'param':
            return TEXT;
        case 'column': {
            const column = expr as ColumnExpr;
            const binding = findBinding(scope, column.qualifier, column.name, column.start);
            if (!binding) throw new ServerError('42703', `column "${column.name}" does not exist`, undefined, column.start);
            return binding.type;
        }
        case 'cast':
            return (expr as CastExpr).type;
        case 'function':
            return functionFieldType(database, expr as FunctionExpr, scope, params);
        case 'binary': {
            const binary = expr as BinaryExpr;
            if (['and', 'or', '=', '<>', '<', '>', '<=', '>=', '~', '!~', '~*', '!~*'].includes(binary.op)) return BOOL;
            if (binary.op === '||') return TEXT;
            const left = fieldType(database, binary.left, scope, params);
            const right = fieldType(database, binary.right, scope, params);
            if (left.key === 'float8' || right.key === 'float8' || left.key === 'float4' || right.key === 'float4') return typeOf('float8');
            if (left.key === 'numeric' || right.key === 'numeric') return typeOf('numeric');
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

function functionFieldType(database: Database, expr: FunctionExpr, scope: Scope | undefined, params: SqlValue[]): DataType {
    const name = expr.name.toLowerCase();
    if (name === 'row_number' || name === 'rank' || name === 'dense_rank' || name === 'count') return typeOf('int8');
    if (name === 'sum' || name === 'avg') {
        const argument = expr.args[0];
        const argumentType = argument === undefined ? undefined : fieldType(database, argument, scope, params);
        if (name === 'avg') {
            return argumentType?.key === 'float4' || argumentType?.key === 'float8' ? typeOf('float8') : typeOf('numeric');
        }
        if (argumentType !== undefined && (argumentType.key === 'float4' || argumentType.key === 'float8')) return argumentType;
        return argumentType?.key === 'numeric' ? typeOf('numeric') : typeOf('int8');
    }
    if (name === 'array_agg') {
        const argument = expr.args[0];
        return arrayOf(argument === undefined ? TEXT : fieldType(database, argument, scope, params));
    }
    if (name === 'string_agg') return TEXT;
    if (name === 'bool_and' || name === 'bool_or' || name === 'every') return BOOL;
    if (name === 'min' || name === 'max' || name === 'lag' || name === 'lead' || name === 'coalesce' || name === 'nullif') {
        const argument = expr.args[0];
        return argument === undefined ? TEXT : fieldType(database, argument, scope, params);
    }
    return functionType(name);
}

function functionType(name: string): DataType {
    switch (name.toLowerCase()) {
        case 'pg_get_userbyid':
            return typeOf('name');
        case 'pg_table_is_visible':
        case 'pg_relation_is_publishable':
        case 'pg_type_is_visible':
        case 'pg_conversion_is_visible':
        case 'pg_operator_is_visible':
        case 'pg_opclass_is_visible':
        case 'pg_opfamily_is_visible':
        case 'pg_amop_is_visible':
        case 'pg_amproc_is_visible':
        case 'pg_ts_config_is_visible':
        case 'pg_ts_dict_is_visible':
        case 'pg_ts_parser_is_visible':
        case 'pg_ts_template_is_visible':
        case 'has_database_privilege':
            return BOOL;
        case 'pg_table_size':
        case 'pg_indexes_size':
        case 'pg_total_relation_size':
        case 'pg_relation_size':
        case 'pg_database_size':
        case 'pg_tablespace_size':
            return typeOf('int8');
        case 'generate_series':
            return INT4;
        case 'nextval':
        case 'lastval':
        case 'currval':
            return typeOf('int8');
        case 'length':
        case 'char_length':
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
            const literal = expr as LiteralExpr;
            const value = literal.value;
            if (typeof value === 'boolean') return BOOL;
            if (typeof value === 'number') return Number.isInteger(value) ? INT4 : typeOf('numeric');
            if (literal.numeric === true) return typeOf('numeric');
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

function findBinding(scope: Scope | undefined, qualifier: string | undefined, name: string, start?: number): Binding | undefined {
    let current = scope;
    while (current) {
        const candidates = current.columns.filter((column) => column.name === name && (qualifier === undefined || matchesAlias(column, qualifier)));
        if (candidates.length > 1) throw new ServerError('42702', `column reference "${name}" is ambiguous`, undefined, start);
        const found = candidates[0];
        if (found) return found;
        // A bare name may also be the whole-row reference of a single-column
        // FROM item, which is how psql addresses `unnest(...) x`.
        if (qualifier === undefined) {
            const single = current.columns.filter((column) => matchesAlias(column, name) && !column.hidden);
            if (single.length === 1 && current.columns.filter((column) => matchesAlias(column, name)).length === 1) return single[0];
        }
        if (qualifier !== undefined && current.columns.some((column) => matchesAlias(column, qualifier))) return undefined;
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

function buildFrom(database: Database, from: FromItem[], params: SqlValue[], outer: Context | undefined, where?: Expr, ordered?: OrderedAccess): RowSet {
    if (from.length === 0) return { columns: [], rows: [[]] };
    const item = from.length === 1 ? from[0] : undefined;
    if (item !== undefined && item.kind === 'relation' && item.args === undefined && (where !== undefined || ordered !== undefined)) {
        // 单表时把谓词与 `ORDER BY` 交给访问路径选择器，索引扫描与全表扫描在这里分岔。
        return buildRelation(database, item, params, outer, where, ordered);
    }
    let current = buildItem(database, from[0]!, params, outer);
    for (const item of from.slice(1)) {
        if (item.kind === 'relation' && item.args !== undefined) {
            // Set-returning functions may refer to earlier items (`LATERAL`),
            // so build them once per left row and keep their column shape when
            // the left side is empty.
            const shape = current.rows.length === 0
                ? functionColumns(item)
                : buildRelation(database, item, params, { columns: current.columns, row: current.rows[0] ?? [], outer }).columns;
            const rows: SqlValue[][] = [];
            for (const leftRow of current.rows) {
                const right = buildRelation(database, item, params, { columns: current.columns, row: leftRow, outer });
                for (const rightRow of right.rows) rows.push([...leftRow, ...rightRow]);
            }
            current = { columns: [...current.columns, ...shape], rows };
            continue;
        }
        current = crossJoin(current, buildItem(database, item, params, outer));
    }
    return current;
}

/** Column shape of a `FROM` function, for when no left row exists to evaluate it. */
function functionColumns(ref: RelationRef): Binding[] {
    const alias = ref.alias ?? ref.name;
    const names = ref.columnAliases;
    const positional = ref.ordinality === true ? 2 : 1;
    return Array.from({ length: Math.max(positional, names?.length ?? 0) }, (_, index) => ({
        alias,
        name: names?.[index] ?? (index === 1 ? 'ordinality' : ref.name),
        type: index === 1 ? typeOf('int8') : TEXT,
    }));
}

function buildItem(database: Database, item: FromItem, params: SqlValue[], outer: Context | undefined): RowSet {
    if (item.kind === 'relation') return buildRelation(database, item, params, outer);
    if (item.kind === 'subquery') {
        const result = executeSelect(database, item.select, params, outer);
        const alias = item.alias ?? '';
        const names = item.columns ?? result.fields.map((field) => field.name);
        if (item.columns !== undefined && item.columns.length !== result.fields.length) {
            throw new ServerError('42P10', `table "${alias}" has ${result.fields.length} columns available but ${item.columns.length} columns specified`);
        }
        return {
            columns: result.fields.map((field, index) => ({ alias, name: names[index] ?? field.name, type: field.type })),
            rows: result.rows,
        };
    }
    const left = buildItem(database, item.left, params, outer);
    const right = buildItem(database, item.right, params, outer);
    if (item.joinType === 'cross') return crossJoin(left, right);
    if (item.natural === true) {
        const using = naturalUsing(left, right);
        if (using.length === 0) return crossJoin(left, right);
        return usingJoin(database, { ...item, using }, left, right, params, outer);
    }
    if (item.using !== undefined && item.using.length > 0) return usingJoin(database, item, left, right, params, outer);
    return onJoin(database, item, left, right, params, outer);
}

/** Columns both sides of a `NATURAL JOIN` expose, in left-side order. */
function naturalUsing(left: RowSet, right: RowSet): string[] {
    const names: string[] = [];
    for (const binding of left.columns) {
        if (binding.hidden || names.includes(binding.name)) continue;
        if (right.columns.some((column) => !column.hidden && column.name === binding.name)) names.push(binding.name);
    }
    return names;
}

/**
 * 等值连接快路径的键列类型：整数族在 `SqlValue` 里就是 JS number，
 * `compareValues` 的相等与 `===` 一致，可以安全做哈希键。浮点与 `numeric`
 * 的比较走另一条语义（NaN、十进制文本），留在逐对求值的路径里。
 */
const HASH_JOINABLE_KEYS = new Set(['int2', 'int4', 'int8', 'oid']);

interface EquiPair {
    leftIndex: number;
    rightIndex: number;
}

/** 在单侧列里按（qualifier, name）唯一定位一个可见绑定，歧义或缺失返回 `-1`。 */
function qualifiedBindingIndex(columns: Binding[], expr: ColumnExpr): number {
    let found = -1;
    for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index]!;
        if (column.hidden || column.name !== expr.name) continue;
        if (!matchesAlias(column, expr.qualifier!)) continue;
        if (found !== -1) return -1;
        found = index;
    }
    return found;
}

/**
 * 把 `ON` 拆成可哈希的等值列对与其余合取。
 *
 * 只有带限定符的纯列引用 `=` 纯列引用、两侧类型都在整数族、且恰好各归一侧时才进
 * 哈希计划；歧义引用在这里就按 `42702` 抛出（与逐对求值一致）。任何不满足的形状
 * 原样退回嵌套循环，语义不变。
 */
function planEquiJoin(
    item: Extract<FromItem, { kind: 'join' }>,
    left: RowSet,
    right: RowSet,
): { pairs: EquiPair[]; rest: Expr[] } | null {
    if (item.on === undefined) return null;
    const pairs: EquiPair[] = [];
    const rest: Expr[] = [];
    for (const conjunct of flattenConjuncts(item.on)) {
        if (conjunct.kind !== 'binary' || (conjunct as BinaryExpr).op !== '=') {
            rest.push(conjunct);
            continue;
        }
        const binary = conjunct as BinaryExpr;
        if (binary.left.kind !== 'column' || binary.right.kind !== 'column') {
            rest.push(conjunct);
            continue;
        }
        const first = binary.left as ColumnExpr;
        const second = binary.right as ColumnExpr;
        if (first.qualifier === undefined || second.qualifier === undefined) {
            rest.push(conjunct);
            continue;
        }
        const firstLeft = qualifiedBindingIndex(left.columns, first);
        const firstRight = qualifiedBindingIndex(right.columns, first);
        const secondLeft = qualifiedBindingIndex(left.columns, second);
        const secondRight = qualifiedBindingIndex(right.columns, second);
        if (firstLeft !== -1 && firstRight !== -1 || firstLeft === -1 && firstRight === -1 || secondLeft !== -1 && secondRight !== -1) {
            // 歧义或外层引用：原样交给逐对求值，抛出时机与嵌套循环一致。
            rest.push(conjunct);
            continue;
        }
        const pair: EquiPair | null =
            firstLeft !== -1 && secondRight !== -1
                ? { leftIndex: firstLeft, rightIndex: secondRight }
                : firstRight !== -1 && secondLeft !== -1
                    ? { leftIndex: secondLeft, rightIndex: firstRight }
                    : null;
        if (pair === null) {
            rest.push(conjunct);
            continue;
        }
        const leftType = left.columns[pair.leftIndex]!.type;
        const rightType = right.columns[pair.rightIndex]!.type;
        if (!HASH_JOINABLE_KEYS.has(leftType.key) || !HASH_JOINABLE_KEYS.has(rightType.key)) {
            rest.push(conjunct);
            continue;
        }
        pairs.push(pair);
    }
    return pairs.length > 0 ? { pairs, rest } : null;
}

/** 一条行的哈希键：整数列直接拼接十进制文本，`null` 行返回 `null` 表示永不匹配。 */
function hashKey(row: SqlValue[], indexes: number[]): string | null {
    let key = '';
    for (const index of indexes) {
        const value = row[index];
        if (value === null) return null;
        key += `${String(value)}\u0000`;
    }
    return key;
}

function onJoin(
    database: Database,
    item: Extract<FromItem, { kind: 'join' }>,
    left: RowSet,
    right: RowSet,
    params: SqlValue[],
    outer: Context | undefined,
): RowSet {
    const columns = [...left.columns, ...right.columns];
    const rows: SqlValue[][] = [];
    const leftMatched = new Array<boolean>(left.rows.length).fill(false);
    const rightMatched = new Array<boolean>(right.rows.length).fill(false);
    const equi = planEquiJoin(item, left, right);
    if (equi !== null) {
        // 等值列对建哈希表，把 O(左×右) 的逐对求值压成 O(左+右×命中)。
        // 其余合取（非等值或不可哈希的等值）只在候选对上求值，语义与嵌套循环一致。
        const leftIndexes = equi.pairs.map((pair) => pair.leftIndex);
        const rightIndexes = equi.pairs.map((pair) => pair.rightIndex);
        const build = new Map<string, number[]>();
        for (let rightIndex = 0; rightIndex < right.rows.length; rightIndex += 1) {
            checkStatementDeadline();
            const key = hashKey(right.rows[rightIndex]!, rightIndexes);
            if (key === null) continue;
            const bucket = build.get(key);
            if (bucket === undefined) build.set(key, [rightIndex]);
            else bucket.push(rightIndex);
        }
        for (let leftIndex = 0; leftIndex < left.rows.length; leftIndex += 1) {
            checkStatementDeadline();
            const leftRow = left.rows[leftIndex]!;
            const key = hashKey(leftRow, leftIndexes);
            if (key === null) continue;
            const bucket = build.get(key);
            if (bucket === undefined) continue;
            for (const rightIndex of bucket) {
                checkStatementDeadline();
                const row = [...leftRow, ...right.rows[rightIndex]!];
                if (equi.rest.length > 0) {
                    const context: Context = { columns, row, outer };
                    let keep = true;
                    for (const conjunct of equi.rest) {
                        if (evaluate(database, conjunct, context, params) !== true) {
                            keep = false;
                            break;
                        }
                    }
                    if (!keep) continue;
                }
                rows.push(row);
                leftMatched[leftIndex] = true;
                rightMatched[rightIndex] = true;
            }
        }
    } else {
        for (let leftIndex = 0; leftIndex < left.rows.length; leftIndex += 1) {
            checkStatementDeadline();
            const leftRow = left.rows[leftIndex]!;
            for (let rightIndex = 0; rightIndex < right.rows.length; rightIndex += 1) {
                checkStatementDeadline();
                const rightRow = right.rows[rightIndex]!;
                const row = [...leftRow, ...rightRow];
                const context: Context = { columns, row, outer };
                const keep = item.on === undefined ? true : evaluate(database, item.on, context, params);
                if (keep !== true) continue;
                rows.push(row);
                leftMatched[leftIndex] = true;
                rightMatched[rightIndex] = true;
            }
        }
    }
    const rightNulls = right.columns.map(() => null);
    const leftNulls = left.columns.map(() => null);
    if (item.joinType === 'left' || item.joinType === 'full') {
        for (let index = 0; index < left.rows.length; index += 1) {
            if (!leftMatched[index]) rows.push([...left.rows[index]!, ...rightNulls]);
        }
    }
    if (item.joinType === 'right' || item.joinType === 'full') {
        for (let index = 0; index < right.rows.length; index += 1) {
            if (!rightMatched[index]) rows.push([...leftNulls, ...right.rows[index]!]);
        }
    }
    return { columns, rows };
}

/** `JOIN ... USING (...)`: merged join columns appear once, then both remainders. */
/**
 * The single output column `USING`/`NATURAL` keeps for a shared name.
 *
 * PostgreSQL still answers both `a.id` and `b.id`, so the binding remembers
 * every relation alias that may qualify the merged value.
 */
function mergedBinding(left: Binding, right: Binding): Binding {
    const aliases = new Set<string>([...(left.aliases ?? []), left.alias, right.alias, ...(right.aliases ?? [])]);
    aliases.delete(left.alias);
    return aliases.size > 0 ? { ...left, aliases: [...aliases] } : left;
}

/** `JOIN ... USING (...)`: merged join columns appear once, then both remainders. */
function usingJoin(
    database: Database,
    item: Extract<FromItem, { kind: 'join' }>,
    left: RowSet,
    right: RowSet,
    params: SqlValue[],
    outer: Context | undefined,
): RowSet {
    const names = item.using ?? [];
    const leftIndexes = names.map((name) => left.columns.findIndex((column) => !column.hidden && column.name === name));
    const rightIndexes = names.map((name) => right.columns.findIndex((column) => !column.hidden && column.name === name));
    for (let index = 0; index < names.length; index += 1) {
        if (leftIndexes[index] === -1) {
            throw new ServerError('42703', `column "${names[index]}" specified in USING clause does not exist in left table`);
        }
        if (rightIndexes[index] === -1) {
            throw new ServerError('42703', `column "${names[index]}" specified in USING clause does not exist in right table`);
        }
    }
    const leftRest = left.columns.map((_, index) => index).filter((index) => !leftIndexes.includes(index));
    const rightRest = right.columns.map((_, index) => index).filter((index) => !rightIndexes.includes(index));
    const columns: Binding[] = [
        ...leftIndexes.map((index, position) => mergedBinding(left.columns[index]!, right.columns[rightIndexes[position]!]!)),
        ...leftRest.map((index) => left.columns[index]!),
        ...rightRest.map((index) => right.columns[index]!),
    ];
    const rows: SqlValue[][] = [];
    const leftMatched = new Array<boolean>(left.rows.length).fill(false);
    const rightMatched = new Array<boolean>(right.rows.length).fill(false);
    for (let leftIndex = 0; leftIndex < left.rows.length; leftIndex += 1) {
        checkStatementDeadline();
        const leftRow = left.rows[leftIndex]!;
        for (let rightIndex = 0; rightIndex < right.rows.length; rightIndex += 1) {
            checkStatementDeadline();
            const rightRow = right.rows[rightIndex]!;
            let matched = true;
            for (let position = 0; position < names.length; position += 1) {
                const a = leftRow[leftIndexes[position]!] ?? null;
                const b = rightRow[rightIndexes[position]!] ?? null;
                if (a === null || b === null || compareValues(a, b) !== 0) {
                    matched = false;
                    break;
                }
            }
            if (!matched) continue;
            rows.push([
                ...leftIndexes.map((index) => leftRow[index] ?? null),
                ...leftRest.map((index) => leftRow[index] ?? null),
                ...rightRest.map((index) => rightRow[index] ?? null),
            ]);
            leftMatched[leftIndex] = true;
            rightMatched[rightIndex] = true;
        }
    }
    const leftNulls = leftRest.map(() => null);
    if (item.joinType === 'left' || item.joinType === 'full') {
        for (let index = 0; index < left.rows.length; index += 1) {
            if (leftMatched[index]) continue;
            const leftRow = left.rows[index]!;
            rows.push([
                ...leftIndexes.map((position) => leftRow[position] ?? null),
                ...leftRest.map((rest) => leftRow[rest] ?? null),
                ...rightRest.map(() => null),
            ]);
        }
    }
    if (item.joinType === 'right' || item.joinType === 'full') {
        for (let index = 0; index < right.rows.length; index += 1) {
            if (rightMatched[index]) continue;
            const rightRow = right.rows[index]!;
            rows.push([
                ...rightIndexes.map((position) => rightRow[position] ?? null),
                ...leftNulls,
                ...rightRest.map((rest) => rightRow[rest] ?? null),
            ]);
        }
    }
    void database;
    void params;
    void outer;
    return { columns, rows };
}

function crossJoin(left: RowSet, right: RowSet): RowSet {
    const columns = [...left.columns, ...right.columns];
    const rows: SqlValue[][] = [];
    for (const leftRow of left.rows) {
        for (const rightRow of right.rows) {
            checkStatementDeadline();
            rows.push([...leftRow, ...rightRow]);
        }
    }
    return { columns, rows };
}

function buildRelation(database: Database, ref: RelationRef, params: SqlValue[], context?: Context, where?: Expr, ordered?: OrderedAccess): RowSet {
    const alias = ref.alias ?? ref.name;
    if (ref.args === undefined) {
        for (let index = cteScopes.length - 1; index >= 0; index -= 1) {
            const cte = cteScopes[index]!.get(ref.name.toLowerCase());
            if (cte === undefined) continue;
            return { columns: cte.columns.map((column) => ({ alias, name: column.name, type: column.type })), rows: cte.rows };
        }
    }
    if (ref.args !== undefined) {
        const lowered = ref.name.toLowerCase();
        if (lowered === 'pg_partition_ancestors') {
            const argument = ref.args[0] === undefined ? null : evaluate(database, ref.args[0], context ?? emptyContext(), params);
            const columns = functionColumns(ref);
            const values: SqlValue[] = ref.ordinality === true ? [argument, 1] : [argument];
            return { columns, rows: argument === null ? [] : [values] };
        }
        if (lowered === 'unnest') {
            const argument = ref.args[0] === undefined ? null : evaluate(database, ref.args[0], context ?? emptyContext(), params);
            const values = argument === null ? [] : splitArray(argument);
            const columns = functionColumns(ref);
            return { columns, rows: values.map((value, index) => (ref.ordinality === true ? [value, index + 1] : [value])) };
        }
        throw new ServerError('42883', `function ${ref.name}(${ref.args.length} arguments) does not exist`, undefined, ref.start);
    }
    const system = ref.schema === 'pg_catalog' ? systemColumns(ref.name) : ref.schema === undefined ? systemColumns(ref.name) : undefined;
    if (system) {
        const table = catalogTables(
            database.catalog,
            database.databases,
            database.roles,
            database.session.pgCursors?.() ?? [],
        ).get(ref.name);
        const oid = systemRelationOidForName(ref.name) ?? 0;
        return {
            columns: [
                ...(table?.columns ?? system).map((column) => ({ alias, name: column.name, type: column.type })),
                { alias, name: 'tableoid', type: typeOf('oid'), hidden: true },
            ],
            rows: (table?.rows ?? []).map((row) => [...row, oid]),
        };
    }
    if (ref.schema !== undefined && ref.schema !== 'public') throw new ServerError('3F000', `schema "${ref.schema}" does not exist`, undefined, ref.start);
    const relation = relationByName(database.catalog, ref.name);
    if (!relation) throw new ServerError('42P01', `relation "${ref.name}" does not exist`, undefined, ref.start);
    checkGrantOnTable(database, relation, 'SELECT');
    if (relation.relkind === 'v') return expandView(database, relation, ref, params, context);
    const columns: ColumnMeta[] = database.catalog.columns
        .filter((column) => column.relid === relation.oid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({ name: column.name, type: typeByOid(column.typeOid, column.typmod) }));
    if (where !== undefined) {
        const indexColumns = indexColumnsOf(database, relation.oid);
        const aliases = new Set([ref.name.toLowerCase(), relation.name.toLowerCase(), alias.toLowerCase()]);
        const plan = planRelationAccess(
            database,
            materializedIndexesOf(database.catalog, relation.oid),
            indexColumns,
            aliases,
            where,
            params,
        );
        if (plan !== null) return scanIndexRows(database, relation, columns, alias, plan);
    }
    else if (ordered !== undefined && ordered.items.length > 0) {
        // 纯 `ORDER BY` 查询：索引键序与排序要求一致时按序扫描，取够 `LIMIT` 即停。
        const plan = planOrderedAccess(
            materializedIndexesOf(database.catalog, relation.oid),
            indexColumnsOf(database, relation.oid),
            new Set([ref.name.toLowerCase(), relation.name.toLowerCase(), alias.toLowerCase()]),
            ordered.items,
        );
        if (plan !== null) return scanIndexRows(database, relation, columns, alias, plan, ordered.limit, true);
    }
    const rows: SqlValue[][] = [];
    for (const row of database.table(relation.oid).values()) {
        checkStatementDeadline();
        rows.push([...row, relation.oid]);
    }
    return {
        columns: [
            ...columns.map((column) => ({ alias, name: column.name, type: column.type })),
            { alias, name: 'tableoid', type: typeOf('oid'), hidden: true },
        ],
        rows,
    };
}

/** View oids currently being expanded, for the `42P17` cycle guard. */
const viewExpansions: number[] = [];

/**
 * Expands a view relation by running its stored query, so a view never copies
 * data. Column names and types come from the definition captured at
 * `CREATE VIEW` time, the rows from the live base relations.
 */
function expandView(database: Database, relation: UserRelation, ref: RelationRef, params: SqlValue[], outer: Context | undefined): RowSet {
    if (viewExpansions.includes(relation.oid)) {
        throw new ServerError('42P17', `infinite recursion detected in rules for relation "${relation.name}"`);
    }
    const stored = database.catalog.views.find((view) => view.oid === relation.oid);
    if (stored === undefined) throw new ServerError('42P01', `relation "${relation.name}" does not exist`, undefined, ref.start);
    const alias = ref.alias ?? ref.name;
    const declared = database.catalog.columns
        .filter((column) => column.relid === relation.oid)
        .sort((left, right) => left.attnum - right.attnum);
    viewExpansions.push(relation.oid);
    try {
        const select = parseViewQuery(stored.definition);
        const result = executeSelect(database, select, params, outer);
        return {
            columns: result.fields.map((field, index) => {
                const column = declared[index];
                return column === undefined
                    ? { alias, name: field.name, type: field.type }
                    : { alias, name: column.name, type: typeByOid(column.typeOid, column.typmod) };
            }),
            rows: result.rows,
        };
    } finally {
        viewExpansions.pop();
    }
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
            return lookup(database, context, column.qualifier, column.name, params, column.start);
        }
        case 'cast':
            return evaluateCast(database, expr as CastExpr, context, params);
        case 'unary': {
            const unary = expr as UnaryExpr;
            const value = evaluate(database, unary.expr, context, params);
            if (unary.op === 'not') return value === null ? null : value !== true;
            if (value === null) return null;
            if (unary.op === '-' && typeof value === 'string') {
                // Unquoted numeric literals keep their scale as strings.
                return negateNumericText(value);
            }
            if (typeof value !== 'number') return value;
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
            const candidates = node.select
                ? executeSelect(database, node.select, params, context).rows.map((row) => row[0] ?? null)
                : node.list.map((item) => evaluate(database, item, context, params));
            for (const candidate of candidates) {
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
            return evaluateCall(database, expr as FunctionExpr, context, params);
        case 'default':
            return null;
        case 'star':
        case 'subscript':
            throw new ServerError('0A000', 'feature not supported', `${expr.kind} is not implemented`);
    }
}

function lookup(database: Database, context: Context, qualifier: string | undefined, name: string, params: SqlValue[], start?: number): SqlValue {
    let current: Context | undefined = context;
    while (current) {
        const binding = findBinding({ columns: current.columns, outer: undefined }, qualifier, name, start);
        if (binding) {
            const index = current.columns.indexOf(binding);
            return current.row[index] ?? null;
        }
        if (qualifier !== undefined && current.columns.some((column) => matchesAlias(column, qualifier))) {
            throw new ServerError('42703', `column ${qualifier}.${name} does not exist`, undefined, start);
        }
        current = current.outer;
    }
    throw new ServerError('42703', `column "${name}" does not exist`, undefined, start);
}

function evaluateCast(database: Database, expr: CastExpr, context: Context, params: SqlValue[]): SqlValue {
    const value = evaluate(database, expr.expr, context, params);
    try {
        return castValue(value, expr.type, {
            relationName: (oid) => relationDisplayName(database.catalog, oid),
            relationOid: (text) => relationOidForName(database.catalog, text),
            functionName: (oid) => functionNameFor(oid),
        });
    }
    catch (error) {
        // Range errors surface from the executor without a source position.
        if (error instanceof ServerError && error.position === undefined && error.code !== '22003') error.position = expr.expr.start;
        throw error;
    }
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
    if (['=', '<>', '<', '>', '<=', '>='].includes(expr.op)) {
        // Cross-type comparisons between `numeric` and a floating point type
        // resolve to the float operator in PostgreSQL, so compare as doubles.
        const scope: Scope = { columns: context.columns, outer: context.outer };
        const leftType = fieldType(database, expr.left, scope, params);
        const rightType = fieldType(database, expr.right, scope, params);
        return compareOperation(expr.op, left, right, leftType, rightType);
    }
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

/** Flips the sign of a numeric spelling without losing its scale. */
function negateNumericText(text: string): string {
    const special = numericSpecial(text);
    if (special === 'NaN') return 'NaN';
    if (special === 'Infinity') return '-Infinity';
    if (special === '-Infinity') return 'Infinity';
    const bare = text.trim().replace(/^[-+]/, '');
    if (/^0*(\.0*)?$/.test(bare)) return bare;
    return `-${bare}`;
}

/** Converts one numeric value to the double PostgreSQL's float operators use. */
function toDouble(value: SqlValue): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const special = numericSpecial(String(value));
    if (special === 'NaN') return Number.NaN;
    if (special === 'Infinity') return Infinity;
    if (special === '-Infinity') return -Infinity;
    return Number(value);
}

/** Orders two doubles with PostgreSQL's `NaN`-last rule. */
function compareDoubles(left: number, right: number): number {
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

function compareOperation(op: string, left: SqlValue, right: SqlValue, leftType?: DataType, rightType?: DataType): SqlValue {
    if (left === null || right === null) return null;
    const floating = [leftType?.key, rightType?.key].some((key) => key === 'float4' || key === 'float8');
    const compared = floating ? compareDoubles(toDouble(left), toDouble(right)) : compareValues(left, right);
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
    const special = numericSpecial(String(value));
    if (special === 'NaN') return Number.NaN;
    if (special === 'Infinity') return Infinity;
    if (special === '-Infinity') return -Infinity;
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

/** Formats bytes the way `pg_size_pretty` does, promoting only at ten of each unit. */
function pgSizePretty(bytes: number): string {
    const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 10 * 1024 && unit < units.length - 1) {
        value = Math.floor(value / 1024);
        unit += 1;
    }
    return `${value} ${units[unit]}`;
}

function splitArray(value: SqlValue): SqlValue[] {
    if (value === null) return [];
    if (Array.isArray(value)) return value as SqlValue[];
    const text = String(value);
    if (text.length === 0) return [];
    if (text.startsWith('{') && text.endsWith('}')) return parseArrayLiteral(text.slice(1, -1));
    return text.split(/\s+/);
}

/** Parses the inside of a PostgreSQL array literal such as `{=c/postgres,postgres=CTc/postgres}`. */
function parseArrayLiteral(body: string): SqlValue[] {
    if (body.length === 0) return [];
    const values: SqlValue[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index]!;
        if (character === '\\') {
            current += body[index + 1] ?? '';
            index += 1;
        } else if (character === '"') {
            quoted = !quoted;
        } else if (character === ',' && !quoted) {
            values.push(current);
            current = '';
        } else {
            current += character;
        }
    }
    values.push(current);
    return values;
}

function evaluateFunction(database: Database, expr: FunctionExpr, context: Context, params: SqlValue[]): SqlValue {
    const name = expr.name.toLowerCase();
    if (name === 'coalesce') {
        for (const argument of expr.args) {
            const value = evaluate(database, argument, context, params);
            if (value !== null) return value;
        }
        return null;
    }
    if (name === 'nullif') {
        const left = evaluate(database, expr.args[0] ?? { kind: 'literal', value: null, text: 'NULL' }, context, params);
        const right = evaluate(database, expr.args[1] ?? { kind: 'literal', value: null, text: 'NULL' }, context, params);
        if (left === null) return null;
        if (right !== null && compareValues(left, right) === 0) return null;
        return left;
    }
    const args = expr.args.map((argument) => evaluate(database, argument, context, params));
    switch (name) {
        case 'pg_get_userbyid':
            return pgGetUserById(args[0] ?? null, database.roles);
        case 'pg_table_is_visible':
            return pgTableIsVisible(args[0] ?? null, database.catalog);
        case 'pg_relation_is_publishable':
            return pgRelationIsPublishable();
        case 'pg_get_expr':
            return pgGetExpr(args[0] ?? null);
        case 'pg_get_indexdef':
            return pgGetIndexDef(database.catalog, args[0] ?? null, args[2] === null ? true : args[2] !== false);
        case 'pg_get_constraintdef':
            return pgGetConstraintDef(database.catalog, args[0] ?? null, args[1] === null ? true : args[1] !== false);
        case 'nextval':
            return nextval(database, args[0] ?? null);
        case 'lastval': {
            if (database.session.lastValue === null) {
                throw new ServerError('55000', 'lastval is not yet defined in this session');
            }
            return database.session.lastValue;
        }
        case 'currval': {
            const sequence = resolveSequence(database, args[0] ?? null);
            const value = database.session.lastBySequence.get(sequence.oid);
            if (value === undefined) {
                throw new ServerError('55000', `currval of sequence "${sequence.name}" is not yet defined in this session`);
            }
            return value;
        }
        case 'length':
        case 'char_length': {
            const text = args[0];
            if (text === null || text === undefined) return null;
            const rendered = formatValue(text, TEXT);
            return rendered === null ? null : rendered.length;
        }
        case 'format_type':
            return formatTypeByOid(args[0] ?? null, args[1] ?? -1);
        case 'pg_get_statisticsobjdef_columns':
            return null;
        case 'pg_partition_ancestors':
            // Partition hierarchy is flat here, so a relation is its own ancestor.
            return args[0] ?? null;
        case 'array_to_string': {
            if ((args[0] ?? null) === null) return null;
            const array = splitArray(args[0] ?? null);
            const separator = formatValue(args[1] ?? ',', TEXT) ?? ',';
            return array.map((item) => String(item)).join(separator);
        }
        case 'pg_encoding_to_char':
            return pgEncodingToChar(args[0] ?? null);
        case 'has_database_privilege': {
            const text = (value: SqlValue | undefined) => formatValue(value ?? null, TEXT) ?? '';
            const [first, second, third] = args;
            return third === undefined
                ? hasDatabasePrivilege(database.databases, database.roles, database.session.user, text(first), text(second))
                : hasDatabasePrivilege(database.databases, database.roles, text(first), text(second), text(third));
        }
        case 'pg_database_size':
        case 'pg_tablespace_size':
            // Databases and tablespaces share one physical store, so every
            // argument reports the same footprint.
            return database.storeBytes();
        case 'pg_tablespace_location':
            // Only the seeded `pg_default`/`pg_global` tablespaces exist and
            // both report an empty location, matching a fresh cluster.
            return '';
        case 'pg_table_size':
        case 'pg_total_relation_size':
        case 'pg_relation_size': {
            const relation = database.catalog.relations.find((candidate) => candidate.oid === Number(args[0] ?? 0));
            if (!relation) return 0;
            // Indexes carry no separate storage: they are catalog metadata.
            if (relation.relkind === 'i') return 0;
            return database.relationBytes(relation.oid);
        }
        case 'pg_indexes_size': {
            const relation = database.catalog.relations.find((candidate) => candidate.oid === Number(args[0] ?? 0));
            if (!relation || relation.relkind !== 'r') return 0;
            const count = database.catalog.indexes.filter((index) => index.relid === relation.oid).length;
            return count === 0 ? 0 : database.relationBytes(relation.oid) * count;
        }
        case 'obj_description': {
            const classOid = typeof args[1] === 'string' ? systemRelationOidForName(args[1]) : typeof args[1] === 'number' ? args[1] : null;
            if (classOid === null) return null;
            return objectDescription(classOid, Number(args[0]));
        }
        case 'col_description':
            return null;
        case 'pg_describe_object':
            return describeObject(args[0] ?? null, args[1] ?? null);
        case 'pg_type_is_visible':
        case 'pg_conversion_is_visible':
        case 'pg_operator_is_visible':
        case 'pg_opclass_is_visible':
        case 'pg_opfamily_is_visible':
        case 'pg_amop_is_visible':
        case 'pg_amproc_is_visible':
        case 'pg_ts_config_is_visible':
        case 'pg_ts_dict_is_visible':
        case 'pg_ts_parser_is_visible':
        case 'pg_ts_template_is_visible':
            return true;
        case 'pg_size_pretty':
            return pgSizePretty(Number(args[0] ?? 0));
        case 'shobj_description': {
            const descriptions: Record<string, string> = {
                '1': 'default template for new databases',
                '4': 'unmodifiable empty database',
                '5': 'default administrative connection database',
            };
            return descriptions[String(args[0] ?? '')] ?? null;
        }
        case 'pg_function_is_visible':
            return true;
        case 'pg_get_function_result':
        case 'pg_get_function_arguments':
        case 'pg_get_functiondef':
            return null;
        case 'pg_get_function_identity_arguments':
            return '';
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
            throw new ServerError('42883', `function ${expr.name}(${args.length} arguments) does not exist`, undefined, expr.start);
    }
}

function pgEncodingToChar(value: SqlValue): SqlValue {
    const encoding = Number(value);
    if (!Number.isFinite(encoding)) return null;
    const names: Record<number, string> = { 0: 'SQL_ASCII', 6: 'UTF8', 8: 'LATIN1' };
    return names[encoding] ?? null;
}

// ---------------------------------------------------------------------------
// Aggregates and windows
// ---------------------------------------------------------------------------

function evaluateCall(database: Database, expr: FunctionExpr, context: Context, params: SqlValue[]): SqlValue {
    if (expr.over !== undefined) {
        const values = context.windowValues?.get(expr);
        if (values === undefined || context.windowIndex === undefined) {
            throw new ServerError('0A000', 'feature not supported', 'window functions are only supported in a query target or ORDER BY');
        }
        return values[context.windowIndex] ?? null;
    }
    if (AGGREGATE_NAMES.has(expr.name.toLowerCase())) return evaluateAggregate(database, expr, context, params);
    return evaluateFunction(database, expr, context, params);
}

function evaluateAggregate(database: Database, expr: FunctionExpr, context: Context, params: SqlValue[]): SqlValue {
    const group = context.group;
    if (group === undefined) {
        throw new ServerError('0A000', 'feature not supported', 'aggregate functions are only supported in grouped queries');
    }
    const name = expr.name.toLowerCase();
    let rows = group;
    if (expr.filter !== undefined) {
        const filter = expr.filter;
        rows = rows.filter((row) => evaluate(database, filter, row, params) === true);
    }
    if (expr.orderBy !== undefined) rows = sortGroupRows(database, rows, expr.orderBy, params);
    if (expr.star) {
        if (name !== 'count') throw new ServerError('42809', `aggregate ${expr.name}(*) does not accept a star`);
        return rows.length;
    }
    const scope: Scope = {
        columns: context.columns,
        outer: context.outer ? { columns: context.outer.columns, outer: undefined } : undefined,
    };
    const argumentTypes = expr.args.map((arg) => fieldType(database, arg, scope, params));
    const columns = expr.args.map((arg) =>
        rows.map((row) => {
            checkStatementDeadline();
            return evaluate(database, arg, row, params);
        }),
    );
    return aggregateValue(name, columns, expr.distinct === true, expr.name, argumentTypes[0]);
}

/** Orders one aggregate's input rows by an `ORDER BY` inside the call. */
function sortGroupRows(database: Database, rows: Context[], orderBy: OrderItem[], params: SqlValue[]): Context[] {
    return rows
        .map((row) => ({ row, values: row.row, keys: orderBy.map((item) => evaluate(database, item.expr, row, params)) }))
        .sort((left, right) => compareEntries(left, right, orderBy))
        .map((entry) => entry.row);
}

function aggregateValue(name: string, columns: SqlValue[][], distinct: boolean, displayName: string, argumentType: DataType | undefined): SqlValue {
    const raw = columns[0] ?? [];
    // `DISTINCT` aggregates sort their inputs before dropping duplicates, and
    // that sort order is what `array_agg` and `string_agg` expose.
    let order = raw.map((value, index) => ({ value, index }));
    if (distinct) {
        order.sort((left, right) => compareWithNulls(left.value, right.value, { direction: 'ASC' } as OrderItem));
        const seen = new Set<string>();
        order = order.filter((entry) => {
            const key = JSON.stringify(entry.value);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    const values = order.map((entry) => entry.value);
    switch (name) {
        case 'count':
            return values.filter((value) => value !== null).length;
        case 'sum': {
            const numbers = values.filter((value): value is Exclude<SqlValue, null> => value !== null);
            if (numbers.length === 0) return null;
            if (argumentType?.key === 'float4') return numbers.reduce<number>((total, value) => Math.fround(total + Number(value)), 0);
            if (argumentType?.key === 'float8') return numbers.reduce<number>((total, value) => total + Number(value), 0);
            return decimalSum(numbers);
        }
        case 'avg': {
            const numbers = values.filter((value): value is Exclude<SqlValue, null> => value !== null);
            if (numbers.length === 0) return null;
            if (argumentType?.key === 'float4' || argumentType?.key === 'float8') {
                return numbers.reduce<number>((total, value) => total + Number(value), 0) / numbers.length;
            }
            return decimalAverage(numbers);
        }
        case 'min':
        case 'max': {
            let best: SqlValue = null;
            for (const value of values) {
                if (value === null) continue;
                if (best === null) {
                    best = value;
                    continue;
                }
                const compared = compareValues(value, best);
                if (name === 'min' ? compared < 0 : compared > 0) best = value;
            }
            return best;
        }
        case 'string_agg': {
            let text = '';
            let appended = 0;
            for (const entry of order) {
                if (entry.value === null) continue;
                if (appended > 0) {
                    const delimiter = columns[1]?.[entry.index];
                    text += delimiter === null || delimiter === undefined ? '' : String(delimiter);
                }
                text += formatValue(entry.value, argumentType ?? TEXT) ?? '';
                appended += 1;
            }
            return appended === 0 ? null : text;
        }
        case 'array_agg':
            return arrayValueText(arrayOf(argumentType ?? TEXT), values);
        case 'bool_and':
        case 'every':
        case 'bool_or': {
            let seen = false;
            let result = name === 'bool_or' ? false : true;
            for (const value of values) {
                if (value === null) continue;
                seen = true;
                const flag = value === true;
                if (name === 'bool_or') result = result || flag;
                else result = result && flag;
            }
            return seen ? result : null;
        }
        default:
            throw new ServerError('0A000', 'feature not supported', `aggregate ${displayName} is not implemented`);
    }
}

interface Decimal {
    negative: boolean;
    magnitude: bigint;
    scale: number;
}

function decimalParse(value: SqlValue): Decimal {
    let text = typeof value === 'number' ? String(value) : String(value);
    if (/[eE]/.test(text)) {
        const number = Number(value);
        text = number.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
    }
    const match = /^([+-])?(\d*)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new ServerError('22P02', `invalid input syntax for type numeric: "${text}"`);
    const fraction = match[3] ?? '';
    return { negative: match[1] === '-', magnitude: BigInt(`${match[2] || '0'}${fraction}`), scale: fraction.length };
}

function renderDecimal(negative: boolean, magnitude: bigint, scale: number): string {
    const digits = magnitude.toString();
    if (scale === 0) return `${magnitude === 0n ? '' : negative ? '-' : ''}${digits}`;
    const padded = digits.padStart(scale + 1, '0');
    const split = padded.length - scale;
    return `${magnitude === 0n ? '' : negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

function decimalSum(values: Exclude<SqlValue, null>[]): string {
    const decimals = values.map(decimalParse);
    const scale = Math.max(...decimals.map((decimal) => decimal.scale));
    let total = 0n;
    for (const decimal of decimals) {
        const scaled = decimal.magnitude * 10n ** BigInt(scale - decimal.scale);
        total += decimal.negative ? -scaled : scaled;
    }
    return renderDecimal(total < 0n, total < 0n ? -total : total, scale);
}

/**
 * Leading base-10000 digit and its weight, matching `select_div_scale`.
 *
 * PostgreSQL picks a division display scale from this, which is why `2/2`
 * renders twenty fractional digits while `3/2` renders sixteen.
 */
function numericLeading(magnitude: bigint, dscale: number): { weight: number; first: number } {
    if (magnitude === 0n) return { weight: 0, first: 0 };
    const digits = magnitude.toString().padStart(dscale + 1, '0');
    const split = digits.length - dscale;
    const integer = digits.slice(0, split).replace(/^0+/, '');
    if (integer.length === 0) {
        const fraction = digits.slice(split);
        for (let offset = 0; offset < fraction.length; offset += 4) {
            const group = Number(fraction.slice(offset, offset + 4).padEnd(4, '0'));
            if (group !== 0) return { weight: -1 - Math.floor(offset / 4), first: group };
        }
        return { weight: 0, first: 0 };
    }
    const lead = integer.length % 4;
    const groups = Math.ceil(integer.length / 4);
    return { weight: groups - 1, first: Number(integer.slice(0, lead === 0 ? 4 : lead)) };
}

/** PostgreSQL's `select_div_scale`: at least sixteen significant digits. */
function divisionScale(dividend: bigint, dscale: number, divisor: bigint): number {
    const left = numericLeading(dividend < 0n ? -dividend : dividend, dscale);
    const right = numericLeading(divisor < 0n ? -divisor : divisor, 0);
    const quotientWeight = left.weight - right.weight - (left.first <= right.first ? 1 : 0);
    return Math.min(Math.max(16 - quotientWeight * 4, dscale, 0), 1000);
}

function decimalAverage(values: Exclude<SqlValue, null>[]): string {
    const decimals = values.map(decimalParse);
    const scale = Math.max(...decimals.map((decimal) => decimal.scale));
    let total = 0n;
    for (const decimal of decimals) {
        const scaled = decimal.magnitude * 10n ** BigInt(scale - decimal.scale);
        total += decimal.negative ? -scaled : scaled;
    }
    const divisor = BigInt(values.length);
    const rscale = divisionScale(total, scale, divisor);
    let numerator = total * 10n ** BigInt(rscale);
    const denominator = divisor * 10n ** BigInt(scale);
    let quotient = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder !== 0n) {
        const absolute = remainder < 0n ? -remainder : remainder;
        if (absolute * 2n >= denominator) quotient += numerator < 0n ? -1n : 1n;
    }
    numerator = quotient;
    return renderDecimal(numerator < 0n, numerator < 0n ? -numerator : numerator, rscale);
}

function compareWindowKeys(left: SqlValue[], right: SqlValue[], orderBy: OrderItem[]): number {
    for (let index = 0; index < orderBy.length; index += 1) {
        const item = orderBy[index]!;
        const compared = compareWithNulls(left[index] ?? null, right[index] ?? null, item);
        if (compared !== 0) return compared;
    }
    return 0;
}

function defaultWindowFrame(spec: WindowSpec): WindowFrame {
    if (spec.orderBy.length > 0) {
        return { mode: 'range', start: { type: 'unbounded-preceding' }, end: { type: 'current-row' } };
    }
    return { mode: 'range', start: { type: 'unbounded-preceding' }, end: { type: 'unbounded-following' } };
}

function computeWindows(
    database: Database,
    nodes: FunctionExpr[],
    contexts: Context[],
    params: SqlValue[],
    target: Map<FunctionExpr, SqlValue[]>,
): void {
    for (const node of nodes) {
        const spec = node.over!;
        const values: SqlValue[] = Array.from({ length: contexts.length }, () => null);
        const partitions = new Map<string, number[]>();
        contexts.forEach((context, index) => {
            const key = JSON.stringify(spec.partitionBy.map((expr) => evaluate(database, expr, context, params)));
            const bucket = partitions.get(key);
            if (bucket) bucket.push(index);
            else partitions.set(key, [index]);
        });
        for (const indices of partitions.values()) {
            const items = indices.map((index) => ({
                index,
                keys: spec.orderBy.map((item) => evaluate(database, item.expr, contexts[index]!, params)),
            }));
            if (spec.orderBy.length > 0) items.sort((left, right) => compareWindowKeys(left.keys, right.keys, spec.orderBy));
            const count = items.length;
            const peerStart = new Array<number>(count).fill(0);
            const peerEnd = new Array<number>(count).fill(0);
            let cursor = 0;
            while (cursor < count) {
                let end = cursor;
                while (end + 1 < count && compareWindowKeys(items[cursor]!.keys, items[end + 1]!.keys, spec.orderBy) === 0) end += 1;
                for (let index = cursor; index <= end; index += 1) {
                    peerStart[index] = cursor;
                    peerEnd[index] = end;
                }
                cursor = end + 1;
            }
            const denseRank = new Array<number>(count).fill(0);
            let group = 0;
            for (let index = 0; index < count; index += 1) {
                if (index > 0 && compareWindowKeys(items[index - 1]!.keys, items[index]!.keys, spec.orderBy) !== 0) group += 1;
                denseRank[index] = group + 1;
            }

            for (let position = 0; position < count; position += 1) {
                const item = items[position]!;
                values[item.index] = windowValue(database, node, spec, contexts, items, position, peerStart, peerEnd, denseRank, params);
            }
        }
        target.set(node, values);
    }
}

function windowValue(
    database: Database,
    node: FunctionExpr,
    spec: WindowSpec,
    contexts: Context[],
    items: { index: number; keys: SqlValue[] }[],
    position: number,
    peerStart: number[],
    peerEnd: number[],
    denseRank: number[],
    params: SqlValue[],
): SqlValue {
    const name = node.name.toLowerCase();
    if (name === 'row_number') return position + 1;
    if (name === 'rank') return peerStart[position]! + 1;
    if (name === 'dense_rank') return denseRank[position]!;
    if (name === 'lag' || name === 'lead') {
        const current = contexts[items[position]!.index]!;
        const offset = node.args[1] === undefined ? 1 : Number(evaluate(database, node.args[1], current, params));
        const targetPosition = name === 'lag' ? position - offset : position + offset;
        if (targetPosition < 0 || targetPosition >= items.length) {
            return node.args[2] === undefined ? null : evaluate(database, node.args[2], current, params);
        }
        const targetContext = contexts[items[targetPosition]!.index]!;
        return evaluate(database, node.args[0]!, targetContext, params);
    }
    const frame = spec.frame ?? defaultWindowFrame(spec);
    const hasOrder = spec.orderBy.length > 0;
    const start = frameBoundPosition(frame.start, true, position, items.length, peerStart, peerEnd, hasOrder, frame, database, contexts[items[position]!.index]!, params);
    const end = frameBoundPosition(frame.end, false, position, items.length, peerStart, peerEnd, hasOrder, frame, database, contexts[items[position]!.index]!, params);
    if (name === 'count' && node.star) return Math.max(0, end - start + 1);
    const collected: SqlValue[] = [];
    for (let index = start; index <= end; index += 1) {
        collected.push(evaluate(database, node.args[0]!, contexts[items[index]!.index]!, params));
    }
    const scopeContext = contexts[items[position]!.index]!;
    const scope: Scope = {
        columns: scopeContext.columns,
        outer: scopeContext.outer ? { columns: scopeContext.outer.columns, outer: undefined } : undefined,
    };
    const argumentType = node.args[0] === undefined ? undefined : fieldType(database, node.args[0], scope, params);
    return aggregateValue(name, [collected], node.distinct === true, node.name, argumentType);
}

function frameBoundPosition(
    bound: FrameBound,
    isStart: boolean,
    position: number,
    count: number,
    peerStart: number[],
    peerEnd: number[],
    hasOrder: boolean,
    frame: WindowFrame,
    database: Database,
    context: Context,
    params: SqlValue[],
): number {
    switch (bound.type) {
        case 'unbounded-preceding':
            return 0;
        case 'unbounded-following':
            return count - 1;
        case 'current-row':
            if (frame.mode === 'range' && hasOrder) return isStart ? peerStart[position]! : peerEnd[position]!;
            return position;
        case 'preceding': {
            if (frame.mode === 'range') throw new ServerError('0A000', 'feature not supported', 'RANGE frames with an offset are not implemented');
            const offset = Number(evaluate(database, bound.offset!, context, params));
            return Math.max(0, position - offset);
        }
        case 'following': {
            if (frame.mode === 'range') throw new ServerError('0A000', 'feature not supported', 'RANGE frames with an offset are not implemented');
            const offset = Number(evaluate(database, bound.offset!, context, params));
            return Math.min(count - 1, position + offset);
        }
    }
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const BTREE_OID = 403;
const HASH_OID = 405;

/** Index access methods this server stores in the catalog. */
const INDEX_METHODS: Record<string, number> = { btree: BTREE_OID, hash: HASH_OID };

function allocateOid(catalog: CatalogDoc): number {
    const oid = catalog.nextOid;
    catalog.nextOid += 1;
    return oid;
}

function addSequence(catalog: CatalogDoc, tableOid: number, name: string, ownerOid: number): number {
    const oid = allocateOid(catalog);
    catalog.relations.push({
        oid,
        name,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'S',
        relam: 0,
        owner: ownerOid,
        relhasindex: false,
    });
    catalog.sequences.push({ oid, name, relid: tableOid, lastValue: 0 });
    return oid;
}

interface IndexRecordOptions {
    name: string;
    unique: boolean;
    primary: boolean;
    method?: string;
    predicate?: string | null;
    /** Structured keys, stored only when the index carries an expression key. */
    keys?: UserIndexKey[];
    /** When set, a `p`/`u` constraint backed by this index is created too. */
    constraintName?: string;
}

function addIndexRecord(database: Database, relid: number, attnums: number[], options: IndexRecordOptions): number {
    const catalog = database.catalog;
    if (catalog.relations.some((relation) => relation.name === options.name)) {
        throw new ServerError('42P07', `relation "${options.name}" already exists`);
    }
    const indexOid = allocateOid(catalog);
    let constraintOid: number | null = null;
    if (options.constraintName !== undefined) {
        constraintOid = allocateOid(catalog);
        catalog.constraints.push({
            oid: constraintOid,
            name: options.constraintName,
            relid,
            contype: options.primary ? 'p' : 'u',
            indexOid,
            conkey: attnums,
            confrelid: 0,
            confkey: [],
            confupdtype: ' ',
            confdeltype: ' ',
            convalidated: true,
            checkSource: null,
        });
    }
    catalog.relations.push({
        oid: indexOid,
        name: options.name,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'i',
        relam: INDEX_METHODS[(options.method ?? 'btree').toLowerCase()] ?? BTREE_OID,
        owner: currentRoleOid(database),
        relhasindex: false,
    });
    catalog.indexes.push({
        oid: indexOid,
        name: options.name,
        relid,
        unique: options.unique,
        primary: options.primary,
        method: options.method ?? 'btree',
        indkey: attnums,
        keys: options.keys,
        predicate: options.predicate ?? null,
        constraintOid,
        materialized: false,
    });
    const record = catalog.indexes[catalog.indexes.length - 1]!;
    // 只有编码器支持的 btree 索引才落盘维护，其余索引如实退回全表扫描。
    record.materialized = materializedIndexKeys(catalog, record) !== null;
    database.markCatalogDirty();
    return indexOid;
}

function attnumsFor(catalog: CatalogDoc, relid: number, names: string[]): number[] {
    return names.map((columnName) => {
        const column = catalog.columns.find((candidate) => candidate.relid === relid && candidate.name === columnName);
        if (!column) throw new ServerError('42703', `column "${columnName}" does not exist`);
        return column.attnum;
    });
}

function addCheckConstraint(
    database: Database,
    relid: number,
    name: string,
    source: string,
    notValid: boolean,
): void {
    const catalog = database.catalog;
    if (catalog.constraints.some((constraint) => constraint.relid === relid && constraint.name === name)) {
        throw new ServerError('42710', `constraint "${name}" for relation already exists`);
    }
    catalog.constraints.push({
        oid: allocateOid(catalog),
        name,
        relid,
        contype: 'c',
        indexOid: null,
        conkey: [],
        confrelid: 0,
        confkey: [],
        confupdtype: ' ',
        confdeltype: ' ',
        convalidated: !notValid,
        checkSource: source,
    });
    database.markCatalogDirty();
}

/** Resolves the referenced columns of a foreign key, defaulting to the parent key. */
function resolveReference(catalog: CatalogDoc, childRelid: number, reference: ReferenceClause): { confrelid: number; confkey: number[] } {
    const parent = relationByName(catalog, reference.table.name);
    if (!parent || parent.relkind !== 'r') {
        throw new ServerError('42P01', `relation "${reference.table.name}" does not exist`);
    }
    if (reference.columns !== undefined) {
        return { confrelid: parent.oid, confkey: attnumsFor(catalog, parent.oid, reference.columns) };
    }
    const primary = catalog.constraints.find((constraint) => constraint.relid === parent.oid && constraint.contype === 'p');
    if (!primary) {
        throw new ServerError(
            '42830',
            `there is no unique constraint matching given keys for referenced table "${parent.name}"`,
        );
    }
    return { confrelid: parent.oid, confkey: [...primary.conkey] };
}

function addForeignKey(
    database: Database,
    relid: number,
    tableName: string,
    conkey: number[],
    reference: ReferenceClause,
    nameOverride: string | undefined,
): void {
    const catalog = database.catalog;
    const resolved = resolveReference(catalog, relid, reference);
    let name = nameOverride;
    if (name === undefined) {
        const names = conkey.map((attnum) => catalog.columns.find((column) => column.relid === relid && column.attnum === attnum)?.name ?? `attnum${attnum}`);
        name = `${tableName}_${names.join('_')}_fkey`;
    }
    if (catalog.constraints.some((constraint) => constraint.relid === relid && constraint.name === name)) {
        throw new ServerError('42710', `constraint "${name}" for relation already exists`);
    }
    catalog.constraints.push({
        oid: allocateOid(catalog),
        name,
        relid,
        contype: 'f',
        indexOid: null,
        conkey,
        confrelid: resolved.confrelid,
        confkey: resolved.confkey,
        confupdtype: reference.onUpdate ?? 'a',
        confdeltype: reference.onDelete ?? 'a',
        confmatchtype: reference.match,
        condeferrable: reference.condeferrable,
        condeferred: reference.condeferred,
        convalidated: true,
        checkSource: null,
    });
    database.markCatalogDirty();
}

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
    // Temporary tables live in the session's `pg_temp` namespace and do not
    // require `CREATE` on `public`; they are dropped when the session ends.
    if (statement.persistence !== 't') checkGrant(database, { type: 'schema', name: 'public' }, 'CREATE');
    const ownerOid = currentRoleOid(database);

    const names = new Set<string>();
    for (const column of statement.columns) {
        if (names.has(column.name)) throw new ServerError('42701', `column "${column.name}" specified more than once`);
        names.add(column.name);
    }
    if (statement.columns.some((column) => column.primaryKey) && statement.constraints.some((constraint) => constraint.kind === 'primary')) {
        throw new ServerError('42P16', `multiple primary keys for table "${statement.table.name}" are not defined`);
    }

    const tableOid = allocateOid(catalog);
    const relation = {
        oid: tableOid,
        name: statement.table.name,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'r' as const,
        relam: 2,
        owner: ownerOid,
        relhasindex: false,
        persistence: statement.persistence ?? 'p',
    };

    const prepared: {
        column: ColumnDef;
        typeOid: number;
        typmod: number;
        defaultText: string | null;
        defaultValue: SqlValue;
        defaultKind: 'value' | 'sequence' | null;
        sequenceOid: number | null;
    }[] = [];
    for (const column of statement.columns) {
        let defaultText: string | null = null;
        let defaultValue: SqlValue = null;
        let defaultKind: 'value' | 'sequence' | null = null;
        let sequenceOid: number | null = null;
        if (column.identity !== undefined) {
            const sequenceName = `${statement.table.name}_${column.name}_seq`.slice(0, 63);
            sequenceOid = addSequence(catalog, tableOid, sequenceName, ownerOid);
            // Identity columns have no `pg_attrdef` entry, so `atthasdef` stays false.
            defaultKind = 'sequence';
            column.notNull = true;
        }
        else if (column.serial !== undefined) {
            const sequenceName = `${statement.table.name}_${column.name}_seq`.slice(0, 63);
            sequenceOid = addSequence(catalog, tableOid, sequenceName, ownerOid);
            defaultText = `nextval('${sequenceName}'::regclass)`;
            defaultKind = 'sequence';
            column.notNull = true;
        }
        else if (column.defaultExpr !== undefined) {
            defaultValue = coerce(evaluate(database, column.defaultExpr, emptyContext(), []), column.type);
            defaultText = renderDefault(defaultValue, column.type);
            defaultKind = 'value';
        }
        prepared.push({
            column,
            typeOid: typeOid(column.type),
            typmod: column.type.typmod,
            defaultText,
            defaultValue,
            defaultKind,
            sequenceOid,
        });
    }

    catalog.relations.push(relation);
    prepared.forEach((entry, index) => {
        const defaultOid = entry.defaultText === null ? null : allocateOid(catalog);
        catalog.columns.push({
            relid: tableOid,
            attnum: index + 1,
            name: entry.column.name,
            typeOid: entry.typeOid,
            typmod: entry.typmod,
            notNull: entry.column.notNull,
            defaultText: entry.defaultText,
            defaultValue: entry.defaultValue,
            defaultKind: entry.defaultKind,
            sequenceOid: entry.sequenceOid,
            defaultOid,
            identity: entry.column.identity === 'always' ? 'a' : entry.column.identity === 'default' ? 'd' : '',
        });
    });

    // Column-level checks are registered before table constraints in `pg_constraint`.
    for (const column of statement.columns) {
        if (!column.check) continue;
        addCheckConstraint(
            database,
            tableOid,
            column.check.name ?? `${statement.table.name}_${column.name}_check`,
            column.check.source,
            false,
        );
    }

    for (const constraint of statement.constraints) {
        if (constraint.kind === 'primary' || constraint.kind === 'unique') {
            const attnums = attnumsFor(catalog, tableOid, constraint.columns);
            const primary = constraint.kind === 'primary';
            const indexName = constraint.name ?? (primary
                ? `${statement.table.name}_pkey`
                : `${statement.table.name}_${constraint.columns.join('_')}_key`);
            addIndexRecord(database, tableOid, attnums, {
                name: indexName,
                unique: true,
                primary,
                constraintName: indexName,
            });
            if (primary) {
                for (const attnum of attnums) {
                    const column = catalog.columns.find((candidate) => candidate.relid === tableOid && candidate.attnum === attnum);
                    if (column) column.notNull = true;
                }
            }
            continue;
        }
        if (constraint.kind === 'check') {
            addCheckConstraint(
                database,
                tableOid,
                constraint.name ?? `${statement.table.name}_check`,
                constraint.source,
                constraint.notValid,
            );
            continue;
        }
        if (constraint.kind === 'foreign') {
            addForeignKey(
                database,
                tableOid,
                statement.table.name,
                attnumsFor(catalog, tableOid, constraint.columns),
                constraint.reference,
                constraint.name,
            );
        }
    }

    for (const column of statement.columns) {
        if (column.unique) {
            const attnums = attnumsFor(catalog, tableOid, [column.name]);
            addIndexRecord(database, tableOid, attnums, {
                name: `${statement.table.name}_${column.name}_key`,
                unique: true,
                primary: false,
                constraintName: `${statement.table.name}_${column.name}_key`,
            });
        }
        if (column.primaryKey) {
            addIndexRecord(database, tableOid, attnumsFor(catalog, tableOid, [column.name]), {
                name: `${statement.table.name}_pkey`,
                unique: true,
                primary: true,
                constraintName: `${statement.table.name}_pkey`,
            });
        }
        if (column.references) {
            addForeignKey(database, tableOid, statement.table.name, attnumsFor(catalog, tableOid, [column.name]), column.references, undefined);
        }
    }

    catalog.nextRowId[String(tableOid)] = 1;
    database.markCatalogDirty();
    return { kind: 'command', tag: 'CREATE TABLE' };
}

/** Renders one index expression the way `pg_get_indexdef` does. */
function deparseIndexExpression(expr: Expr, pretty: boolean): string | undefined {
    switch (expr.kind) {
        case 'column':
            return (expr as ColumnExpr).name;
        case 'literal': {
            const literal = expr as LiteralExpr;
            if (literal.value === null) return 'NULL';
            if (typeof literal.value === 'boolean') return literal.value ? 'true' : 'false';
            if (literal.numeric === true) return literal.text;
            return `'${String(literal.value).replace(/'/g, "''")}'::text`;
        }
        case 'binary': {
            const binary = expr as BinaryExpr;
            const left = deparseIndexExpression(binary.left, pretty);
            const right = deparseIndexExpression(binary.right, pretty);
            if (left === undefined || right === undefined) return undefined;
            return `(${left} ${binary.op} ${right})`;
        }
        case 'unary': {
            const unary = expr as UnaryExpr;
            const inner = deparseIndexExpression(unary.expr, pretty);
            if (inner === undefined) return undefined;
            return `(${unary.op} ${inner})`;
        }
        case 'cast': {
            const cast = expr as CastExpr;
            const inner = deparseIndexExpression(cast.expr, pretty);
            if (inner === undefined) return undefined;
            const target = formatType(cast.type);
            return pretty ? `${inner}::${target}` : `(${inner})::${target}`;
        }
        case 'function': {
            const call = expr as FunctionExpr;
            if (call.star || call.schema !== undefined) return undefined;
            const args = call.args.map((argument) => deparseIndexExpression(argument, pretty));
            if (args.some((argument) => argument === undefined)) return undefined;
            return `${call.name}(${args.join(', ')})`;
        }
        default:
            return undefined;
    }
}

/** Every column an index expression reads, including nested operands. */
function indexExpressionColumns(expr: Expr): ColumnExpr[] {
    const found: ColumnExpr[] = [];
    const walk = (node: Expr): void => {
        if (node.kind === 'column') found.push(node as ColumnExpr);
        for (const child of expressionChildren(node)) walk(child);
    };
    walk(expr);
    return found;
}

function checkIndexExpressionColumns(catalog: CatalogDoc, relid: number, expr: Expr): void {
    for (const column of indexExpressionColumns(expr)) {
        const exists = catalog.columns.some((candidate) => candidate.relid === relid && candidate.name === column.name);
        if (!exists) throw new ServerError('42703', `column "${column.name}" does not exist`, undefined, column.start);
    }
}

function createIndex(database: Database, statement: CreateIndexStatement): Outcome {
    const catalog = database.catalog;
    if (statement.table.schema !== undefined && statement.table.schema !== 'public') {
        throw new ServerError('3F000', `schema "${statement.table.schema}" does not exist`);
    }
    const relation = relationByName(catalog, statement.table.name);
    if (!relation || relation.relkind !== 'r') throw new ServerError('42P01', `relation "${statement.table.name}" does not exist`);
    checkTableOwner(database, relation);
    const method = statement.method.toLowerCase();
    if (!(method in INDEX_METHODS)) {
        if (['gist', 'spgist', 'gin', 'brin'].includes(method)) {
            throw new ServerError('0A000', 'feature not supported', `access method "${method}" is not implemented`);
        }
        throw new ServerError('42704', `access method "${statement.method}" does not exist`);
    }
    if (catalog.relations.some((candidate) => candidate.name === statement.name)) {
        if (statement.ifNotExists) {
            return {
                kind: 'command',
                tag: 'CREATE INDEX',
                notices: [{ code: '00000', message: `relation "${statement.name}" already exists, skipping` }],
            };
        }
        throw new ServerError('42P07', `relation "${statement.name}" already exists`);
    }
    if (method === 'hash') {
        if (statement.unique) throw new ServerError('0A000', 'access method "hash" does not support unique indexes');
        if (statement.keys.some((key) => key.desc)) throw new ServerError('0A000', 'access method "hash" does not support ASC/DESC options');
        if (statement.include.length > 0) throw new ServerError('0A000', 'access method "hash" does not support included columns');
        if (statement.keys.some((key) => key.nulls !== undefined)) {
            throw new ServerError('0A000', 'access method "hash" does not support NULLS FIRST/LAST options');
        }
    }
    const keys: UserIndexKey[] = [];
    for (const key of statement.keys) {
        let column = key.column;
        if (key.expression !== undefined && key.expression.kind === 'column') column = (key.expression as ColumnExpr).name;
        if (column !== undefined) {
            const attnum = attnumsFor(catalog, relation.oid, [column])[0] ?? 0;
            keys.push({ attnum, desc: key.desc, nullsFirst: key.nullsFirst });
            continue;
        }
        const expression = key.expression;
        if (expression === undefined) continue;
        checkIndexExpressionColumns(catalog, relation.oid, expression);
        const pretty = deparseIndexExpression(expression, true);
        const raw = deparseIndexExpression(expression, false);
        if (pretty === undefined || raw === undefined) {
            throw new ServerError('0A000', 'feature not supported', 'index expressions of this form are not implemented');
        }
        keys.push({
            attnum: 0,
            expression: pretty,
            pretty,
            // Non-pretty output keeps one extra pair around operator-style expressions.
            raw: expression.kind === 'function' ? raw : `(${raw})`,
            desc: key.desc,
            nullsFirst: key.nullsFirst,
        });
    }
    const include = attnumsFor(catalog, relation.oid, statement.include);
    const indkey = [...keys.map((key) => key.attnum), ...include];
    const predicate = statement.whereSource ?? null;
    if (statement.unique) {
        const shape = shapeForRelation(database, relation);
        const labels = keys.map((key) => indexKeyLabel(shape, key)).join(', ');
        const parsed = statement.where ?? null;
        const seen = new Set<string>();
        for (const values of database.table(relation.oid).values()) {
            if (parsed && evaluate(database, parsed, rowContext(relation, catalog, values), []) !== true) continue;
            const key = indexKeyValues(database, shape, keys, values);
            if (key.some((value) => value === null)) continue;
            const rendered = JSON.stringify(key.map((value) => formatValue(value, TEXT)));
            if (seen.has(rendered)) {
                throw new ServerError(
                    '23505',
                    `could not create unique index "${statement.name}"`,
                    `Key (${labels})=(${key.map((value) => formatValue(value, TEXT)).join(', ')}) is duplicated.`,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { schema: schemaNameOf(relation), table: relation.name },
                );
            }
            seen.add(rendered);
        }
    }
    const indexOid = addIndexRecord(database, relation.oid, indkey, {
        name: statement.name,
        unique: statement.unique,
        primary: false,
        method,
        predicate,
        keys,
    });
    const record = database.catalog.indexes.find((candidate) => candidate.oid === indexOid);
    const materialized = record === undefined ? null : materializedIndexKeys(database.catalog, record);
    if (record !== undefined && materialized !== null) {
        backfillIndex(database, relation, { oid: record.oid, name: record.name, unique: record.unique, keys: materialized });
    }
    return { kind: 'command', tag: 'CREATE INDEX' };
}

function dropIndex(database: Database, statement: DropIndexStatement): Outcome {
    const catalog = database.catalog;
    const notices: { code: string; message: string }[] = [];
    // Resolve and validate every name before touching the catalog so a failing
    // name in a multi-name statement leaves the earlier ones in place.
    const targets: UserRelation[] = [];
    for (const requested of statement.names) {
        if (requested.schema !== undefined && requested.schema !== 'public') {
            throw new ServerError('3F000', `schema "${requested.schema}" does not exist`);
        }
        const index = catalog.indexes.find((candidate) => candidate.name === requested.name);
        const relation = index === undefined ? undefined : catalog.relations.find((candidate) => candidate.oid === index.oid);
        if (!index || !relation) {
            if (statement.ifExists) {
                notices.push({ code: '00000', message: `index "${requested.name}" does not exist, skipping` });
                continue;
            }
            throw new ServerError('42704', `index "${requested.name}" does not exist`);
        }
        checkTableOwner(database, relation);
        if (index.constraintOid !== null) {
            const constraint = catalog.constraints.find((candidate) => candidate.oid === index.constraintOid);
            const table = catalog.relations.find((candidate) => candidate.oid === index.relid);
            const constraintName = constraint?.name ?? requested.name;
            const tableName = table?.name ?? '';
            throw new ServerError(
                '2BP01',
                `cannot drop index ${requested.name} because constraint ${constraintName} on table ${tableName} requires it`,
                undefined,
                undefined,
                `You can drop constraint ${constraintName} on table ${tableName} instead.`,
            );
        }
        targets.push(relation);
    }
    if (targets.length > 0) {
        const oids = new Set(targets.map((target) => target.oid));
        for (const oid of oids) purgeIndexEntries(database, oid);
        catalog.relations = catalog.relations.filter((candidate) => !oids.has(candidate.oid));
        catalog.indexes = catalog.indexes.filter((candidate) => !oids.has(candidate.oid));
        catalog.constraints = catalog.constraints.filter((constraint) => constraint.indexOid === null || !oids.has(constraint.indexOid));
        database.markCatalogDirty();
    }
    return notices.length === 0 ? { kind: 'command', tag: 'DROP INDEX' } : { kind: 'command', tag: 'DROP INDEX', notices };
}

function alterTable(database: Database, statement: AlterTableStatement): Outcome {
    const catalog = database.catalog;
    const relation = relationByName(catalog, statement.table.name);
    if (!relation || relation.relkind !== 'r') throw new ServerError('42P01', `relation "${statement.table.name}" does not exist`);
    checkTableOwner(database, relation);
    const action = statement.action;
    if (action.kind === 'owner') {
        const role = findRole(database.roles, action.role);
        if (!role) throw new ServerError('42704', `role "${action.role}" does not exist`);
        relation.owner = role.oid;
        database.markCatalogDirty();
        return { kind: 'command', tag: 'ALTER TABLE' };
    }
    if (action.kind === 'validate') {
        const constraint = catalog.constraints.find((candidate) => candidate.relid === relation.oid && candidate.name === action.name);
        if (!constraint) throw new ServerError('42704', `constraint "${action.name}" of relation "${relation.name}" does not exist`);
        if (!constraint.convalidated) {
            validateConstraint(database, relation, constraint);
            constraint.convalidated = true;
            database.markCatalogDirty();
        }
        return { kind: 'command', tag: 'ALTER TABLE' };
    }
    if (action.kind === 'add-check') {
        const name = action.name ?? `${relation.name}_check`;
        addCheckConstraint(database, relation.oid, name, action.source, action.notValid);
        if (!action.notValid) {
            validateCheck(database, relation, name, action.source);
        }
        return { kind: 'command', tag: 'ALTER TABLE' };
    }
    const conkey = attnumsFor(catalog, relation.oid, action.columns);
    addForeignKey(database, relation.oid, relation.name, conkey, action.reference, action.name);
    const name = action.name ?? `${relation.name}_${action.columns.join('_')}_fkey`;
    validateForeignKeys(database, relation, name);
    return { kind: 'command', tag: 'ALTER TABLE' };
}

function dropTable(database: Database, statement: DropTableStatement): Outcome {
    const catalog = database.catalog;
    const relation = relationByName(catalog, statement.table.name);
    if (!relation) {
        if (statement.ifExists) return { kind: 'command', tag: 'DROP TABLE' };
        throw new ServerError('42P01', `table "${statement.table.name}" does not exist`);
    }
    if (relation.relkind !== 'r') throw new ServerError('42P01', `table "${statement.table.name}" does not exist`);
    checkTableOwner(database, relation);
    const viewDependents = dependentViewClosure(catalog, relation.name);
    if (viewDependents.length > 0 && !statement.cascade) {
        throw new ServerError(
            '2BP01',
            `cannot drop table ${relation.name} because other objects depend on it`,
            viewDependents.map((view) => `view ${view.name} depends on table ${relation.name}`).join('\n'),
            undefined,
            'Use DROP ... CASCADE to drop the dependent objects too.',
        );
    }
    const referencing = catalog.relations.filter((candidate) => catalog.constraints.some((constraint) => constraint.confrelid === relation.oid && constraint.contype === 'f' && constraint.relid === candidate.oid));
    if (referencing.length > 0 && !statement.cascade) {
        throw new ServerError(
            '2BP01',
            `cannot drop table "${relation.name}" because other objects depend on it`,
            `Referenced by foreign key constraints on table(s) ${referencing.map((candidate) => `"${candidate.name}"`).join(', ')}.`,
        );
    }
    const indexOids = catalog.indexes.filter((index) => index.relid === relation.oid).map((index) => index.oid);
    for (const indexOid of indexOids) purgeIndexEntries(database, indexOid);
    const sequenceOids = catalog.sequences.filter((sequence) => sequence.relid === relation.oid).map((sequence) => sequence.oid);
    catalog.relations = catalog.relations.filter((candidate) => candidate.oid !== relation.oid && !indexOids.includes(candidate.oid) && !sequenceOids.includes(candidate.oid));
    catalog.columns = catalog.columns.filter((column) => column.relid !== relation.oid);
    catalog.indexes = catalog.indexes.filter((index) => index.relid !== relation.oid);
    catalog.constraints = catalog.constraints.filter((constraint) => constraint.relid !== relation.oid && constraint.confrelid !== relation.oid);
    catalog.sequences = catalog.sequences.filter((sequence) => sequence.relid !== relation.oid);
    delete catalog.nextRowId[String(relation.oid)];
    for (const key of [...database.table(relation.oid).keys()]) database.deleteRow(relation.oid, key);
    const notices: { code: string; message: string; severity?: 'NOTICE' | 'WARNING' }[] = [];
    for (const view of viewDependents) {
        removeViewRelation(database, view);
        notices.push({ code: '00000', message: `drop cascades to view ${view.name}` });
    }
    database.markCatalogDirty();
    return notices.length === 0 ? { kind: 'command', tag: 'DROP TABLE' } : { kind: 'command', tag: 'DROP TABLE', notices };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Views whose stored definition reads the relation called `name`.
 *
 * Dependencies are tracked by name, the same way the engine resolves every
 * other relation reference. The walk covers `FROM` items, expression
 * subqueries and `WITH` clauses, so a view nested over another view is found.
 */
function dependentViews(catalog: CatalogDoc, name: string): UserRelation[] {
    const wanted = name.toLowerCase();
    const refs = (select: SelectStatement): boolean => {
        const coreRefs = (core: SelectStatement['core']): boolean =>
            core.from.some((item) => itemRefs(item, wanted)) ||
            core.targets.some((target) => exprRefs(target.expr, wanted)) ||
            (core.where !== undefined && exprRefs(core.where, wanted)) ||
            core.groupBy.some((expr) => exprRefs(expr, wanted)) ||
            (core.having !== undefined && exprRefs(core.having, wanted));
        return (
            select.with?.ctes.some((cte) => refs(cte.select)) === true ||
            coreRefs(select.core) ||
            select.unions.some((union) => coreRefs(union.core))
        );
    };
    const itemRefs = (item: FromItem, name2: string): boolean => {
        if (item.kind === 'relation') return item.args === undefined && item.name.toLowerCase() === name2;
        if (item.kind === 'subquery') return refs(item.select);
        return itemRefs(item.left, name2) || itemRefs(item.right, name2);
    };
    const exprRefs = (expr: Expr, name2: string): boolean => {
        switch (expr.kind) {
            case 'subquery':
                return refs((expr as SubqueryExpr).select);
            case 'exists':
                return refs((expr as { select: SelectStatement }).select);
            case 'in': {
                const node = expr as InExpr;
                if (node.select !== undefined && refs(node.select)) return true;
                return node.list.some((item) => exprRefs(item, name2));
            }
            default:
                return expressionChildren(expr).some((child) => exprRefs(child, name2));
        }
    };
    return catalog.relations.filter((relation) => {
        if (relation.relkind !== 'v') return false;
        const stored = catalog.views.find((view) => view.oid === relation.oid);
        if (stored === undefined) return false;
        try {
            return refs(parseViewQuery(stored.definition));
        } catch {
            return false;
        }
    });
}

/**
 * Every view that depends on `name`, directly or through another view, so a
 * cascading drop removes the whole chain instead of leaving a dangling view.
 * `exclude` keeps the relation being dropped out of its own dependent list.
 */
function dependentViewClosure(catalog: CatalogDoc, name: string, exclude?: number): UserRelation[] {
    const found: UserRelation[] = [];
    const seen = new Set<number>();
    const pending = [name.toLowerCase()];
    const searched = new Set(pending);
    while (pending.length > 0) {
        const current = pending.shift()!;
        for (const view of dependentViews(catalog, current)) {
            if (seen.has(view.oid) || view.oid === exclude) continue;
            seen.add(view.oid);
            found.push(view);
            if (!searched.has(view.name.toLowerCase())) {
                searched.add(view.name.toLowerCase());
                pending.push(view.name.toLowerCase());
            }
        }
    }
    return found;
}

/** Removes a view relation and its columns from the catalog document. */
function removeViewRelation(database: Database, relation: UserRelation): void {
    const catalog = database.catalog;
    catalog.relations = catalog.relations.filter((candidate) => candidate.oid !== relation.oid);
    catalog.columns = catalog.columns.filter((column) => column.relid !== relation.oid);
    catalog.views = catalog.views.filter((view) => view.oid !== relation.oid);
}

/**
 * Resolves the output columns of a stored view query. The query runs once so a
 * missing base relation fails at `CREATE VIEW`, the way PostgreSQL parses the
 * definition at definition time.
 */
function resolveViewColumns(database: Database, select: SelectStatement, aliases: string[] | undefined): { name: string; type: DataType }[] {
    const result = executeSelect(database, select, [], undefined);
    if (aliases !== undefined && aliases.length > result.fields.length) {
        throw new ServerError('42601', 'CREATE VIEW specifies more column names than columns');
    }
    const names = aliases ?? result.fields.map((field) => field.name);
    const columns = result.fields.map((field, index) => ({ name: names[index] ?? field.name, type: field.type }));
    const seen = new Set<string>();
    for (const column of columns) {
        if (seen.has(column.name)) throw new ServerError('42701', `column "${column.name}" specified more than once`);
        seen.add(column.name);
    }
    return columns;
}

function createView(database: Database, statement: CreateViewStatement): Outcome {
    const catalog = database.catalog;
    if (statement.view.schema !== undefined && statement.view.schema !== 'public') {
        throw new ServerError('3F000', `schema "${statement.view.schema}" does not exist`);
    }
    const existing = relationByName(catalog, statement.view.name);
    if (existing !== undefined && statement.orReplace && existing.relkind !== 'v') {
        throw new ServerError('42809', `"${statement.view.name}" is not a view`);
    }
    if (existing !== undefined && !statement.orReplace) {
        throw new ServerError('42P07', `relation "${statement.view.name}" already exists`);
    }
    checkGrant(database, { type: 'schema', name: 'public' }, 'CREATE');
    const columns = resolveViewColumns(database, statement.select, statement.columns);
    if (existing !== undefined) {
        // `CREATE OR REPLACE VIEW` may only append columns; existing names and
        // types keep their positions, matching `checkViewTupleDesc`.
        const previous = catalog.columns
            .filter((column) => column.relid === existing.oid)
            .sort((left, right) => left.attnum - right.attnum);
        if (previous.length > columns.length) throw new ServerError('42P16', 'cannot drop columns from view');
        for (let index = 0; index < previous.length; index += 1) {
            const old = previous[index]!;
            const next = columns[index]!;
            if (old.name !== next.name) {
                throw new ServerError(
                    '42P16',
                    `cannot change name of view column "${old.name}" to "${next.name}"`,
                    undefined,
                    undefined,
                    'Use ALTER VIEW ... RENAME COLUMN ... to change name of view column instead.',
                );
            }
            const oldType = typeByOid(old.typeOid, old.typmod);
            if (oldType.key !== next.type.key || oldType.typmod !== next.type.typmod) {
                throw new ServerError(
                    '42P16',
                    `cannot change data type of view column "${old.name}" from ${formatType(oldType)} to ${formatType(next.type)}`,
                );
            }
        }
        catalog.columns = catalog.columns.filter((column) => column.relid !== existing.oid);
        columns.forEach((column, index) => {
            catalog.columns.push({
                relid: existing.oid,
                attnum: index + 1,
                name: column.name,
                typeOid: typeOid(column.type),
                typmod: column.type.typmod,
                notNull: false,
                defaultText: null,
                defaultValue: null,
                defaultKind: null,
                sequenceOid: null,
                defaultOid: null,
                identity: '',
            });
        });
        const stored = catalog.views.find((view) => view.oid === existing.oid);
        if (stored !== undefined) stored.definition = statement.source;
        database.markCatalogDirty();
        return { kind: 'command', tag: 'CREATE VIEW' };
    }
    const viewOid = allocateOid(catalog);
    catalog.relations.push({
        oid: viewOid,
        name: statement.view.name,
        namespace: PUBLIC_NAMESPACE,
        relkind: 'v',
        relam: 0,
        owner: currentRoleOid(database),
        relhasindex: false,
    });
    columns.forEach((column, index) => {
        catalog.columns.push({
            relid: viewOid,
            attnum: index + 1,
            name: column.name,
            typeOid: typeOid(column.type),
            typmod: column.type.typmod,
            notNull: false,
            defaultText: null,
            defaultValue: null,
            defaultKind: null,
            sequenceOid: null,
            defaultOid: null,
            identity: '',
        });
    });
    catalog.views.push({ oid: viewOid, definition: statement.source });
    database.markCatalogDirty();
    return { kind: 'command', tag: 'CREATE VIEW' };
}

function dropView(database: Database, statement: DropViewStatement): Outcome {
    const catalog = database.catalog;
    const notices: { code: string; message: string; severity?: 'NOTICE' | 'WARNING' }[] = [];
    for (const ref of statement.views) {
        const relation = relationByName(catalog, ref.name);
        if (relation === undefined || relation.relkind !== 'v') {
            if (statement.ifExists) {
                notices.push({ code: '00000', message: `view "${ref.name}" does not exist, skipping` });
                continue;
            }
            throw new ServerError('42P01', `view "${ref.name}" does not exist`, undefined, ref.start);
        }
        checkTableOwner(database, relation);
        const dependents = dependentViewClosure(catalog, relation.name, relation.oid);
        if (dependents.length > 0 && !statement.cascade) {
            throw new ServerError(
                '2BP01',
                `cannot drop view ${relation.name} because other objects depend on it`,
                dependents.map((view) => `view ${view.name} depends on view ${relation.name}`).join('\n'),
                undefined,
                'Use DROP ... CASCADE to drop the dependent objects too.',
            );
        }
        removeViewRelation(database, relation);
        for (const view of dependents) {
            removeViewRelation(database, view);
            notices.push({ code: '00000', message: `drop cascades to view ${view.name}` });
        }
    }
    database.markCatalogDirty();
    return notices.length === 0 ? { kind: 'command', tag: 'DROP VIEW' } : { kind: 'command', tag: 'DROP VIEW', notices };
}

// ---------------------------------------------------------------------------
// VACUUM / ANALYZE
// ---------------------------------------------------------------------------

/**
 * `VACUUM` and `ANALYZE` share the relation checks: a missing relation is
 * `42P01`, anything that is not a table or index is skipped with a `01000`
 * warning. The engine keeps no dead tuples, so both commands are no-ops.
 */
function maintenanceTarget(database: Database, table: RelationRef): { skipped: boolean; name: string } | null {
    const relation = relationByName(database.catalog, table.name);
    if (relation === undefined) {
        if (systemColumns(table.name) !== undefined && table.schema === undefined) return null;
        throw new ServerError('42P01', `relation "${table.name}" does not exist`, undefined, table.start);
    }
    if (relation.relkind !== 'r' && relation.relkind !== 'i') {
        return { skipped: true, name: relation.name };
    }
    return { skipped: false, name: relation.name };
}

function runVacuum(database: Database, statement: VacuumStatement): Outcome {
    const notices: { code: string; message: string; severity?: 'NOTICE' | 'WARNING' }[] = [];
    if (statement.table !== undefined) {
        const target = maintenanceTarget(database, statement.table);
        if (target !== null && target.skipped) {
            notices.push({ code: '01000', severity: 'WARNING', message: `skipping "${target.name}" --- cannot vacuum non-tables or special system tables` });
        }
    }
    return notices.length === 0 ? { kind: 'command', tag: 'VACUUM' } : { kind: 'command', tag: 'VACUUM', notices };
}

function runAnalyze(database: Database, statement: AnalyzeStatement): Outcome {
    const notices: { code: string; message: string; severity?: 'NOTICE' | 'WARNING' }[] = [];
    if (statement.table !== undefined) {
        const target = maintenanceTarget(database, statement.table);
        if (target !== null && target.skipped) {
            notices.push({ code: '01000', severity: 'WARNING', message: `skipping "${target.name}" --- cannot analyze non-tables or special system tables` });
        }
        else if (target !== null && statement.columns !== undefined) {
            const columns = database.catalog.columns.filter((column) => column.relid === relationByName(database.catalog, statement.table!.name)?.oid);
            for (const name of statement.columns) {
                if (!columns.some((column) => column.name === name)) {
                    throw new ServerError('42703', `column "${name}" of relation "${target.name}" does not exist`);
                }
            }
        }
    }
    return notices.length === 0 ? { kind: 'command', tag: 'ANALYZE' } : { kind: 'command', tag: 'ANALYZE', notices };
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

interface TableShape {
    oid: number;
    name: string;
    namespace: number;
    columns: {
        attnum: number;
        name: string;
        type: DataType;
        notNull: boolean;
        defaultText: string | null;
        defaultValue: SqlValue;
        defaultKind: 'value' | 'sequence' | null;
        sequenceOid: number | null;
        identity: string;
    }[];
    uniqueIndexes: {
        name: string;
        keys: { attnum: number; expression: Expr | null; pretty: string | null }[];
        predicate: Expr | null;
    }[];
    /** Materialized btree indexes whose leading keys the planner may use. */
    indexes: MaterializedIndex[];
    checks: { name: string; expr: Expr }[];
    foreignKeys: {
        name: string;
        conkey: number[];
        confrelid: number;
        confkey: number[];
        confupdtype: string;
        confdeltype: string;
        confmatchtype: string;
    }[];
}

function shapeForRelation(database: Database, relation: { oid: number; name: string; namespace: number }): TableShape {
    const catalog = database.catalog;
    const columns = catalog.columns
        .filter((column) => column.relid === relation.oid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({
            attnum: column.attnum,
            name: column.name,
            type: typeByOid(column.typeOid, column.typmod),
            notNull: column.notNull,
            defaultText: column.defaultText,
            defaultValue: column.defaultValue,
            defaultKind: column.defaultKind,
            sequenceOid: column.sequenceOid,
            identity: column.identity ?? '',
        }));
    const uniqueIndexes = catalog.indexes
        .filter((index) => index.relid === relation.oid && index.unique)
        .map((index) => {
            const indexKeys: UserIndexKey[] = index.keys ?? index.indkey.map((attnum) => ({ attnum }));
            return {
                name: index.name,
                keys: indexKeys.map((key) => ({
                    attnum: key.attnum,
                    expression: key.expression === undefined ? null : parseExpression(key.expression),
                    pretty: key.pretty ?? null,
                })),
                predicate: index.predicate === null ? null : parseExpression(index.predicate),
            };
        });
    const checks = catalog.constraints
        .filter((constraint) => constraint.relid === relation.oid && constraint.contype === 'c' && constraint.checkSource !== null)
        .map((constraint) => ({ name: constraint.name, expr: parseExpression(constraint.checkSource ?? '') }));
    const foreignKeys = catalog.constraints
        .filter((constraint) => constraint.relid === relation.oid && constraint.contype === 'f')
        .map((constraint) => ({
            name: constraint.name,
            conkey: constraint.conkey,
            confrelid: constraint.confrelid,
            confkey: constraint.confkey,
            confupdtype: constraint.confupdtype,
            confdeltype: constraint.confdeltype,
            confmatchtype: constraint.confmatchtype ?? 's',
        }));
    return { oid: relation.oid, name: relation.name, namespace: relation.namespace, columns, uniqueIndexes, indexes: materializedIndexesOf(catalog, relation.oid), checks, foreignKeys };
}

/** The schema name PostgreSQL reports in `s` for a relation-level error. */
function schemaNameOf(shape: { namespace: number }): string {
    return SYSTEM_NAMESPACES.find((namespace) => namespace.oid === shape.namespace)?.name ?? 'public';
}

function shapeForOid(database: Database, oid: number): TableShape {
    const relation = database.catalog.relations.find((candidate) => candidate.oid === oid && candidate.relkind === 'r');
    if (!relation) throw new ServerError('42P01', `relation with OID ${oid} does not exist`);
    return shapeForRelation(database, relation);
}

function tableShape(database: Database, ref: RelationRef): TableShape {
    if (ref.schema !== undefined && ref.schema !== 'public') {
        throw new ServerError('3F000', `schema "${ref.schema}" does not exist`, undefined, ref.start);
    }
    const relation = relationByName(database.catalog, ref.name);
    if (!relation || relation.relkind !== 'r') {
        throw new ServerError('42P01', `relation "${ref.name}" does not exist`, undefined, ref.start);
    }
    return shapeForRelation(database, relation);
}

/* ------------------------------------------------------------------------- *
 * 索引访问路径
 *
 * 只有满足以下条件的 btree 索引才落盘维护并参与计划：键全是普通列、类型有
 * 可比较的字节编码、不是部分索引。其余索引如实退回全表扫描，不假装可用。
 * 条目键 = 排序编码后的键值 + 0x00 + 行号，值为整行数据（覆盖索引），因此
 * 索引扫描不读取堆表。EXPLAIN 与执行器共用 `planRelationAccess`。
 * ------------------------------------------------------------------------- */

interface IndexKeyShape {
    attnum: number;
    type: DataType;
    desc: boolean;
    nullsFirst: boolean;
}

interface MaterializedIndex {
    oid: number;
    name: string;
    unique: boolean;
    keys: IndexKeyShape[];
}

interface IndexScanPlan {
    index: MaterializedIndex;
    /** 前导列的等值约束，按索引键顺序。 */
    equality: SqlValue[];
    lower: { value: SqlValue; inclusive: boolean } | null;
    upper: { value: SqlValue; inclusive: boolean } | null;
    /** 真正交给索引的谓词文本，用于 EXPLAIN 的 Index Cond。 */
    conditions: string[];
}

/** 只有这些类型能编码成与 `compareValues` 同序的字节串。 */
function isIndexScanType(type: DataType): boolean {
    switch (type.key) {
        case 'bool':
        case 'int2':
        case 'int4':
        case 'int8':
        case 'oid':
        case 'date':
        case 'timestamp':
        case 'timestamptz':
        case 'uuid':
            return true;
        default:
            return false;
    }
}

function materializedIndexKeys(catalog: CatalogDoc, index: { relid: number; method: string; predicate: string | null; indkey: number[]; keys?: { attnum: number; desc?: boolean; nullsFirst?: boolean; expression?: string }[] }): IndexKeyShape[] | null {
    if (index.method.toLowerCase() !== 'btree' || index.predicate !== null) return null;
    const source: { attnum: number; desc?: boolean; nullsFirst?: boolean; expression?: string }[] =
        index.keys ?? index.indkey.map((attnum) => ({ attnum }));
    if (source.length === 0) return null;
    const keys: IndexKeyShape[] = [];
    for (const key of source) {
        if (key.attnum <= 0 || key.expression !== undefined) return null;
        const column = catalog.columns.find((candidate) => candidate.relid === index.relid && candidate.attnum === key.attnum);
        if (!column) return null;
        const type = typeByOid(column.typeOid, column.typmod);
        if (!isIndexScanType(type)) return null;
        keys.push({ attnum: key.attnum, type, desc: key.desc === true, nullsFirst: key.nullsFirst === true });
    }
    return keys;
}

function materializedIndexesOf(catalog: CatalogDoc, relid: number): MaterializedIndex[] {
    const indexes: MaterializedIndex[] = [];
    for (const index of catalog.indexes) {
        if (index.relid !== relid || index.materialized !== true) continue;
        const keys = materializedIndexKeys(catalog, index);
        if (keys === null) continue;
        indexes.push({ oid: index.oid, name: index.name, unique: index.unique, keys });
    }
    return indexes;
}

function indexInt64(value: SqlValue): bigint {
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'boolean') return value ? 1n : 0n;
    return BigInt(String(value).trim());
}

/** 键值的负载字节：同一类型内保持与 SQL 排序一致。 */
function indexPayload(value: SqlValue, type: DataType): number[] {
    switch (type.key) {
        case 'bool':
            return [value === true || value === 't' || value === 'true' ? 0x01 : 0x00];
        case 'int2':
        case 'int4':
        case 'int8':
        case 'oid': {
            const sortable = BigInt.asUintN(64, indexInt64(value)) ^ 0x8000000000000000n;
            const bytes: number[] = [];
            for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number((sortable >> shift) & 0xffn));
            return bytes;
        }
        default: {
            // UTF-8 字节序与字符串比较同序；0x00 转义、0x00 0x00 结尾保证前缀无关。
            const bytes: number[] = [];
            for (const byte of Buffer.from(String(value), 'utf8')) {
                bytes.push(byte);
                if (byte === 0x00) bytes.push(0x01);
            }
            bytes.push(0x00, 0x00);
            return bytes;
        }
    }
}

function encodeIndexValues(values: SqlValue[], keys: IndexKeyShape[]): Uint8Array {
    const bytes: number[] = [];
    for (let position = 0; position < keys.length; position += 1) {
        const key = keys[position]!;
        const value = values[position] ?? null;
        if (value === null) {
            bytes.push(key.nullsFirst ? 0x00 : 0xff);
            continue;
        }
        bytes.push(key.nullsFirst ? 0x01 : 0xfe);
        for (const byte of indexPayload(value, key.type)) bytes.push(key.desc ? 0xff - byte : byte);
    }
    return new Uint8Array(bytes);
}

function appendIndexBound(bytes: Uint8Array, extra: number[]): Uint8Array {
    const merged = new Uint8Array(bytes.length + extra.length);
    merged.set(bytes, 0);
    merged.set(extra, bytes.length);
    return merged;
}

function indexEntryKey(index: MaterializedIndex, rowKey: string, values: SqlValue[]): string {
    const keyValues = index.keys.map((key) => values[key.attnum - 1] ?? null);
    const bytes = encodeIndexValues(keyValues, index.keys);
    return Buffer.concat([Buffer.from(bytes), Buffer.from([0x00]), Buffer.from(rowKey, 'latin1')]).toString('latin1');
}

function maintainIndexInsert(database: Database, shape: TableShape, rowKey: string, values: SqlValue[]): void {
    for (const index of shape.indexes) database.putIndexEntry(index.oid, indexEntryKey(index, rowKey, values), values);
}

function maintainIndexDelete(database: Database, shape: TableShape, rowKey: string, values: SqlValue[]): void {
    for (const index of shape.indexes) database.deleteIndexEntry(index.oid, indexEntryKey(index, rowKey, values));
}

function backfillIndex(database: Database, relation: { oid: number }, index: MaterializedIndex): void {
    for (const [rowKey, values] of database.table(relation.oid)) {
        database.putIndexEntry(index.oid, indexEntryKey(index, rowKey, values), values);
    }
}

function purgeIndexEntries(database: Database, indexOid: number): void {
    for (const entry of database.scanIndex(indexOid, null, null, null)) database.deleteIndexEntry(indexOid, entry.key);
}

function flattenConjuncts(expr: Expr): Expr[] {
    if (expr.kind === 'binary' && expr.op === 'and') return [...flattenConjuncts(expr.left), ...flattenConjuncts(expr.right)];
    return [expr];
}

/** 不含列引用、子查询或窗口的子表达式，可以安全地在计划阶段求值。 */
function isConstantExpr(expr: Expr): boolean {
    switch (expr.kind) {
        case 'column':
        case 'star':
        case 'default':
        case 'subquery':
        case 'exists':
            return false;
        case 'in':
            return isConstantExpr(expr.expr) && expr.select === undefined && expr.list.every(isConstantExpr);
        case 'any':
            return isConstantExpr(expr.left) && isConstantExpr(expr.array);
        case 'function':
            return !expr.star && expr.over === undefined && expr.args.every(isConstantExpr) && (expr.filter === undefined || isConstantExpr(expr.filter));
        default:
            return expressionChildren(expr).every(isConstantExpr);
    }
}

interface IndexColumn {
    attnum: number;
    name: string;
    type: DataType;
}

function indexColumnOf(expr: Expr, columns: IndexColumn[], aliases: Set<string>): IndexColumn | null {
    if (expr.kind !== 'column') return null;
    if (expr.qualifier !== undefined && !aliases.has(expr.qualifier.toLowerCase())) return null;
    return columns.find((column) => column.name === expr.name) ?? null;
}

interface IndexCondition {
    column: IndexColumn;
    op: '=' | '>' | '>=' | '<' | '<=';
    value: SqlValue;
    text: string;
}

function flipComparison(op: string): IndexCondition['op'] | null {
    switch (op) {
        case '=':
            return '=';
        case '<':
            return '>';
        case '<=':
            return '>=';
        case '>':
            return '<';
        case '>=':
            return '<=';
        default:
            return null;
    }
}

function indexConditionOf(
    database: Database,
    conjunct: Expr,
    columns: IndexColumn[],
    aliases: Set<string>,
    params: SqlValue[],
): IndexCondition | null {
    if (conjunct.kind !== 'binary') return null;
    const op = conjunct.op;
    if (op !== '=' && op !== '<' && op !== '<=' && op !== '>' && op !== '>=') return null;
    const left = indexColumnOf(conjunct.left, columns, aliases);
    const right = indexColumnOf(conjunct.right, columns, aliases);
    let column: IndexColumn | null = null;
    let constant: Expr | null = null;
    let effective: IndexCondition['op'] = op;
    if (left !== null && right === null && isConstantExpr(conjunct.right)) {
        column = left;
        constant = conjunct.right;
    }
    else if (right !== null && left === null && isConstantExpr(conjunct.left)) {
        column = right;
        constant = conjunct.left;
        // `5 < id` 与 `id > 5` 等价，常量在左侧时翻转比较方向。
        effective = flipComparison(op) ?? op;
    }
    if (column === null || constant === null) return null;
    let value: SqlValue;
    try {
        value = coerce(evaluate(database, constant, emptyContext(), params), column.type);
    }
    catch {
        // 常量本身无法转换时交给普通 WHERE 求值报错，计划阶段不吞错也不硬撑。
        return null;
    }
    const text = deparseIndexExpression(conjunct, true);
    return { column, op: effective, value, text: text ?? `(${column.name} ${effective} ...)` };
}

/** 为单表 WHERE 选一条索引访问路径；没有可用索引时返回 `null` 表示全表扫描。 */
function planRelationAccess(
    database: Database,
    indexes: MaterializedIndex[],
    columns: IndexColumn[],
    aliases: Set<string>,
    where: Expr,
    params: SqlValue[],
): IndexScanPlan | null {
    if (indexes.length === 0) return null;
    const conditions: IndexCondition[] = [];
    for (const conjunct of flattenConjuncts(where)) {
        const condition = indexConditionOf(database, conjunct, columns, aliases, params);
        if (condition !== null) conditions.push(condition);
    }
    if (conditions.length === 0) return null;
    let best: IndexScanPlan | null = null;
    let bestScore = -1;
    for (const index of indexes) {
        let equalityCount = 0;
        let lower: IndexScanPlan['lower'] = null;
        let upper: IndexScanPlan['upper'] = null;
        const used: string[] = [];
        for (let position = 0; position < index.keys.length; position += 1) {
            const key = index.keys[position]!;
            const matching = conditions.filter((condition) => condition.column.attnum === key.attnum);
            if (matching.length === 0) break;
            const equality = matching.find((condition) => condition.op === '=');
            if (position === equalityCount && equality) {
                used.push(equality.text);
                equalityCount += 1;
                continue;
            }
            if (position !== equalityCount) break;
            for (const condition of matching) {
                if (condition.op === '>') lower = { value: condition.value, inclusive: false };
                else if (condition.op === '>=') lower = { value: condition.value, inclusive: true };
                else if (condition.op === '<') upper = { value: condition.value, inclusive: false };
                else if (condition.op === '<=') upper = { value: condition.value, inclusive: true };
                else continue;
                used.push(condition.text);
            }
            break;
        }
        if (equalityCount === 0 && lower === null && upper === null) continue;
        // 等值前缀越长越优先，其次唯一索引，再其次有范围界。
        const score = equalityCount * 10 + (index.unique ? 2 : 0) + (lower !== null || upper !== null ? 1 : 0);
        if (score <= bestScore) continue;
        const equality: SqlValue[] = [];
        for (let position = 0; position < equalityCount; position += 1) {
            const key = index.keys[position]!;
            const condition = conditions.find((candidate) => candidate.column.attnum === key.attnum && candidate.op === '=')!;
            equality.push(condition.value);
        }
        best = { index, equality, lower, upper, conditions: used };
        bestScore = score;
    }
    return best;
}

/**
 * 为无 WHERE 的 `ORDER BY` 选一条有序索引路径。
 * 要求 `ORDER BY` 的每一项都逐位对上索引键的方向与 NULL 位置，否则如实返回 `null`。
 */
function planOrderedAccess(
    indexes: MaterializedIndex[],
    columns: IndexColumn[],
    aliases: Set<string>,
    items: OrderItem[],
): IndexScanPlan | null {
    if (items.length === 0) return null;
    let best: IndexScanPlan | null = null;
    for (const index of indexes) {
        if (items.length > index.keys.length) continue;
        let matched = true;
        for (let position = 0; position < items.length; position += 1) {
            const item = items[position]!;
            const key = index.keys[position]!;
            const column = indexColumnOf(item.expr, columns, aliases);
            const descending = item.direction === 'DESC';
            // 未写 NULLS 时按 PG 默认：升序 NULLS LAST，降序 NULLS FIRST。
            const nullsFirst = item.nulls === undefined ? descending : item.nulls === 'FIRST';
            if (column === null || column.attnum !== key.attnum || descending !== key.desc || nullsFirst !== key.nullsFirst) {
                matched = false;
                break;
            }
        }
        if (!matched) continue;
        if (best === null || index.keys.length < best.index.keys.length) {
            best = { index, equality: [], lower: null, upper: null, conditions: [] };
        }
    }
    return best;
}

function scanIndexRows(database: Database, relation: { oid: number; name: string }, columns: ColumnMeta[], alias: string, plan: IndexScanPlan, limit = 0, ordered = false): RowSet {
    const keys = plan.index.keys;
    const prefix = plan.equality.length > 0 ? encodeIndexValues(plan.equality, keys.slice(0, plan.equality.length)) : null;
    let after: Uint8Array | null = null;
    let before: Uint8Array | null = null;
    const boundKeys = keys.slice(0, plan.equality.length + 1);
    // 降序键的字节是反码，索引里的升序方向对应值的大小反向，上下界要互换。
    const descendingBound = keys[plan.equality.length]?.desc === true;
    if (plan.lower) {
        const bound = encodeIndexValues([...plan.equality, plan.lower.value], boundKeys);
        // 闭下界用键本身作游标：条目键始终是 键+0x00+行号，必然大于键。
        if (descendingBound) before = plan.lower.inclusive ? appendIndexBound(bound, [0x00, 0xff]) : bound;
        else after = plan.lower.inclusive ? bound : appendIndexBound(bound, [0x00, 0xff]);
    }
    if (plan.upper) {
        const bound = encodeIndexValues([...plan.equality, plan.upper.value], boundKeys);
        if (descendingBound) after = plan.upper.inclusive ? bound : appendIndexBound(bound, [0x00, 0xff]);
        else before = plan.upper.inclusive ? appendIndexBound(bound, [0x00, 0xff]) : bound;
    }
    // 唯一索引的全键等值查找最多命中一行，给原生扫描一个上限，避免它走完整段索引。
    const singleRow = plan.index.unique
        && plan.lower === null
        && plan.upper === null
        && plan.equality.length === plan.index.keys.length;
    const entries = database.scanIndex(plan.index.oid, prefix, after, before, limit > 0 ? limit : singleRow ? 1 : 0);
    database.scanStats.push({
        relation: relation.name,
        indexOid: plan.index.oid,
        index: plan.index.name,
        indexCond: plan.conditions.join(' AND '),
        keysScanned: entries.length,
        rowsFetched: entries.length,
    });
    const bindings: Binding[] = columns.map((column) => ({ alias, name: column.name, type: column.type }));
    bindings.push({ alias, name: 'tableoid', type: typeOf('oid'), hidden: true });
    return { columns: bindings, rows: entries.map((entry) => [...entry.values, relation.oid]), ordered };
}

function indexColumnsOf(database: Database, relid: number): IndexColumn[] {
    return database.catalog.columns
        .filter((column) => column.relid === relid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({ attnum: column.attnum, name: column.name, type: typeByOid(column.typeOid, column.typmod) }));
}

function explainLines(database: Database, statement: SelectStatement, params: SqlValue[], analyze: boolean): string[] {
    if (statement.core.from.length === 0) return ['Result'];
    if (
        statement.core.from.length !== 1
        || statement.unions.length > 0
        || statement.with !== undefined
        || statement.core.values !== undefined
        || statement.core.groupBy.length > 0
        || statement.core.having !== undefined
        || statement.core.distinct
    ) {
        throw new ServerError('0A000', 'feature not supported', 'EXPLAIN is implemented for a single-relation SELECT without grouping or set operations');
    }
    const item = statement.core.from[0];
    if (item === undefined || item.kind !== 'relation' || item.args !== undefined) {
        throw new ServerError('0A000', 'feature not supported', 'EXPLAIN is implemented for a single-relation SELECT without grouping or set operations');
    }
    const ref = item;
    if (ref.schema !== undefined && ref.schema !== 'public') {
        throw new ServerError('3F000', `schema "${ref.schema}" does not exist`, undefined, ref.start);
    }
    const relation = relationByName(database.catalog, ref.name);
    if (!relation || relation.relkind !== 'r') {
        throw new ServerError('0A000', 'feature not supported', 'EXPLAIN is implemented for user tables only', ref.start);
    }
    const alias = ref.alias ?? ref.name;
    const columns = indexColumnsOf(database, relation.oid);
    const aliases = new Set([ref.name.toLowerCase(), relation.name.toLowerCase(), alias.toLowerCase()]);
    const plan = statement.core.where
        ? planRelationAccess(database, materializedIndexesOf(database.catalog, relation.oid), columns, aliases, statement.core.where, params)
        : statement.orderBy.length > 0
            ? planOrderedAccess(materializedIndexesOf(database.catalog, relation.oid), columns, aliases, statement.orderBy)
            : null;
    let head = plan ? `Index Scan using ${plan.index.name} on ${relation.name}` : `Seq Scan on ${relation.name}`;
    let stat: IndexScanStat | undefined;
    if (analyze) {
        database.scanStats.length = 0;
        executeSelect(database, statement, params, undefined);
        stat = plan ? database.scanStats.find((candidate) => candidate.indexOid === plan.index.oid) : undefined;
        if (plan && !stat) {
            throw new ServerError('XX000', 'internal error', 'the executor did not consume the planned index scan');
        }
        if (stat) head += ` (keys scanned=${stat.keysScanned}, rows fetched=${stat.rowsFetched})`;
    }
    const lines = [head];
    if (plan && plan.conditions.length > 0) lines.push(`  Index Cond: ${plan.conditions.join(' AND ')}`);
    if (!plan && statement.core.where) {
        const filter = deparseIndexExpression(statement.core.where, true);
        lines.push(`  Filter: ${filter ?? '(expression)'}`);
    }
    return lines;
}

function explainStatement(database: Database, statement: ExplainStatement, params: SqlValue[]): Outcome {
    if (statement.statement.kind !== 'select') {
        throw new ServerError('0A000', 'feature not supported', 'EXPLAIN is implemented for SELECT only');
    }
    const lines = explainLines(database, statement.statement, params, statement.analyze);
    return {
        kind: 'rows',
        fields: [{ name: 'QUERY PLAN', type: TEXT }],
        rows: lines.map((line) => [line]),
        tag: 'EXPLAIN',
    };
}


function rowContext(shape: { oid: number; name: string }, catalog: CatalogDoc, values: SqlValue[]): Context {
    const columns: Binding[] = catalog.columns
        .filter((column) => column.relid === shape.oid)
        .sort((left, right) => left.attnum - right.attnum)
        .map((column) => ({ alias: shape.name, name: column.name, type: typeByOid(column.typeOid, column.typmod) }));
    return { columns, row: values, outer: undefined };
}

function resolveSequence(database: Database, value: SqlValue): { oid: number; name: string } {
    const catalog = database.catalog;
    let sequence: { oid: number; name: string } | undefined;
    if (typeof value === 'number') {
        sequence = catalog.sequences.find((candidate) => candidate.oid === value);
    }
    else if (typeof value === 'string') {
        const trimmed = value.trim();
        const name = trimmed.includes('.') ? trimmed.slice(trimmed.lastIndexOf('.') + 1) : trimmed;
        sequence = catalog.sequences.find((candidate) => candidate.name === name);
    }
    if (!sequence) {
        throw new ServerError('42P01', `relation "${String(value ?? '')}" does not exist`);
    }
    return sequence;
}

function nextval(database: Database, value: SqlValue): number {
    const sequence = resolveSequence(database, value);
    return database.nextSequence(sequence.oid);
}

/** Evaluates a column default, advancing a sequence when the column is serial. */
function columnDefault(database: Database, column: { defaultKind: 'value' | 'sequence' | null; sequenceOid: number | null; defaultValue: SqlValue }): SqlValue {
    if (column.defaultKind === 'sequence' && column.sequenceOid !== null) {
        return database.nextSequence(column.sequenceOid);
    }
    return column.defaultValue;
}

function renderRow(values: SqlValue[], shape: TableShape): string {
    return values
        .map((value, index) => {
            const column = shape.columns[index];
            if (value === null) return 'null';
            return column ? formatValue(value, column.type) : String(value);
        })
        .join(', ');
}

function enforceChecks(database: Database, shape: TableShape, values: SqlValue[]): void {
    // PostgreSQL evaluates CHECK constraints in name order, not creation order.
    const checks = [...shape.checks].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const check of checks) {
        // A CHECK passes when it evaluates to NULL, only FALSE fails.
        if (evaluate(database, check.expr, rowContext(shape, database.catalog, values), []) === false) {
            throw new ServerError(
                '23514',
                `new row for relation "${shape.name}" violates check constraint "${check.name}"`,
                `Failing row contains (${renderRow(values, shape)}).`,
                undefined,
                undefined,
                undefined,
                check.name,
                { schema: schemaNameOf(shape), table: shape.name },
            );
        }
    }
}

function parentHasKey(database: Database, fk: TableShape['foreignKeys'][number], key: SqlValue[]): boolean {
    for (const values of database.table(fk.confrelid).values()) {
        const existing = fk.confkey.map((attnum) => values[attnum - 1] ?? null);
        if (existing.some((value) => value === null)) continue;
        if (existing.every((value, position) => compareValues(value, key[position] ?? null) === 0)) return true;
    }
    return false;
}

function enforceForeignKeys(database: Database, shape: TableShape, values: SqlValue[]): void {
    for (const fk of shape.foreignKeys) {
        const key = fk.conkey.map((attnum) => values[attnum - 1] ?? null);
        const nulls = key.filter((value) => value === null).length;
        if (fk.confmatchtype === 'f') {
            if (nulls === key.length) continue;
            if (nulls > 0) {
                throw new ServerError(
                    '23503',
                    `insert or update on table "${shape.name}" violates foreign key constraint "${fk.name}"`,
                    'MATCH FULL does not allow mixing of null and nonnull key values.',
                    undefined,
                    undefined,
                    undefined,
                    fk.name,
                    { schema: schemaNameOf(shape), table: shape.name },
                );
            }
        }
        else if (nulls > 0) continue;
        if (parentHasKey(database, fk, key)) continue;
        const parent = database.catalog.relations.find((candidate) => candidate.oid === fk.confrelid);
        const labels = fk.conkey.map((attnum) => shape.columns.find((column) => column.attnum === attnum)?.name ?? `attnum${attnum}`).join(', ');
        const rendered = key.map((value) => (value === null ? 'null' : formatValue(value, TEXT))).join(', ');
        throw new ServerError(
            '23503',
            `insert or update on table "${shape.name}" violates foreign key constraint "${fk.name}"`,
            `Key (${labels})=(${rendered}) is not present in table "${parent?.name ?? fk.confrelid}".`,
            undefined,
            undefined,
            undefined,
            fk.name,
            { schema: schemaNameOf(shape), table: shape.name },
        );
    }
}

function insertRows(database: Database, statement: InsertStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    checkGrantOnOid(database, shape.oid, 'INSERT');
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
        const values: SqlValue[] = new Array(shape.columns.length).fill(null);
        const provided = new Set<number>();
        source.forEach((expr, index) => {
            const column = targetColumns[index];
            if (!column) return;
            provided.add(column.attnum);
            let raw: SqlValue;
            if (column.identity !== '' && statement.overriding === 'user') {
                raw = columnDefault(database, column);
            }
            else {
                if (column.identity === 'a' && expr.kind !== 'default' && statement.overriding !== 'system') {
                    throw new ServerError(
                        '428C9',
                        `cannot insert a non-DEFAULT value into column "${column.name}"`,
                        `Column "${column.name}" is an identity column defined as GENERATED ALWAYS.`,
                        undefined,
                        'Use OVERRIDING SYSTEM VALUE to override.',
                    );
                }
                raw = expr.kind === 'default' ? columnDefault(database, column) : evaluate(database, expr, emptyContext(), params);
            }
            values[column.attnum - 1] = coerce(raw, column.type);
        });
        for (const column of shape.columns) {
            if (!provided.has(column.attnum)) values[column.attnum - 1] = columnDefault(database, column);
        }
        for (const column of shape.columns) {
            if (column.notNull && (values[column.attnum - 1] ?? null) === null) {
                throw new ServerError('23502', `null value in column "${column.name}" of relation "${shape.name}" violates not-null constraint`, undefined, undefined, undefined, undefined, undefined, {
                    schema: schemaNameOf(shape),
                    table: shape.name,
                    column: column.name,
                });
            }
        }
        enforceChecks(database, shape, values);
        enforceForeignKeys(database, shape, values);
        const key = database.insertRow(shape.oid, values);
        maintainIndexInsert(database, shape, key, values);
        inserted.push({ key, values });
        checkUnique(database, shape, values, new Set([key]));
    }
    return returningOutcome(database, statement.returning, shape, inserted, params, `INSERT 0 ${inserted.length}`);
}

function validateRowShape(database: Database, shape: TableShape, values: SqlValue[]): void {
    for (const column of shape.columns) {
        if (column.notNull && (values[column.attnum - 1] ?? null) === null) {
            throw new ServerError('23502', `null value in column "${column.name}" of relation "${shape.name}" violates not-null constraint`, undefined, undefined, undefined, undefined, undefined, {
                schema: schemaNameOf(shape),
                table: shape.name,
                column: column.name,
            });
        }
    }
    enforceChecks(database, shape, values);
    enforceForeignKeys(database, shape, values);
}

/** Applies `ON DELETE` actions when a referenced row goes away. */
function removeRow(database: Database, shape: TableShape, key: string, values: SqlValue[], seen: Set<string>): void {
    const marker = `${shape.oid}:${key}`;
    if (seen.has(marker)) return;
    seen.add(marker);
    const catalog = database.catalog;
    for (const constraint of catalog.constraints) {
        if (constraint.contype !== 'f' || constraint.confrelid !== shape.oid) continue;
        const child = shapeForOid(database, constraint.relid);
        const parentKey = constraint.confkey.map((attnum) => values[attnum - 1] ?? null);
        // A null parent key never identifies a referenced row.
        if (parentKey.some((value) => value === null)) continue;
        const matches = [...database.table(child.oid).entries()].filter(([, childValues]) =>
            constraint.conkey.every((attnum, position) => compareValues(childValues[attnum - 1] ?? null, parentKey[position] ?? null) === 0),
        );
        if (matches.length === 0) continue;
        if (constraint.confdeltype === 'c') {
            for (const [childKey, childValues] of matches) removeRow(database, child, childKey, childValues, seen);
            continue;
        }
        if (constraint.confdeltype === 'n') {
            for (const [childKey, childValues] of matches) {
                const next = [...childValues];
                for (const attnum of constraint.conkey) next[attnum - 1] = null;
                validateRowShape(database, child, next);
                maintainIndexDelete(database, child, childKey, childValues);
                database.updateRow(child.oid, childKey, next);
                maintainIndexInsert(database, child, childKey, next);
                checkUnique(database, child, next, new Set([childKey]));
            }
            continue;
        }
        if (constraint.confdeltype === 'd') {
            for (const [childKey, childValues] of matches) {
                const next = [...childValues];
                for (const attnum of constraint.conkey) {
                    const column = child.columns.find((candidate) => candidate.attnum === attnum);
                    next[attnum - 1] = column ? columnDefault(database, column) : null;
                }
                validateRowShape(database, child, next);
                maintainIndexDelete(database, child, childKey, childValues);
                database.updateRow(child.oid, childKey, next);
                maintainIndexInsert(database, child, childKey, next);
                checkUnique(database, child, next, new Set([childKey]));
            }
            continue;
        }
        const labels = constraint.confkey.map((attnum) => shape.columns.find((column) => column.attnum === attnum)?.name ?? `attnum${attnum}`).join(', ');
        const rendered = parentKey.map((value) => (value === null ? 'null' : formatValue(value, TEXT))).join(', ');
        throw new ServerError(
            '23503',
            `update or delete on table "${shape.name}" violates foreign key constraint "${constraint.name}" on table "${child.name}"`,
            `Key (${labels})=(${rendered}) is still referenced from table "${child.name}".`,
            undefined,
            undefined,
            undefined,
            constraint.name,
            { schema: schemaNameOf(shape), table: shape.name },
        );
    }
    maintainIndexDelete(database, shape, key, values);
    database.deleteRow(shape.oid, key);
}

function updateRows(database: Database, statement: UpdateStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    checkGrantOnOid(database, shape.oid, 'UPDATE');
    for (const assignment of statement.assignments) {
        if (!shape.columns.some((column) => column.name === assignment.column)) {
            throw new ServerError('42703', `column "${assignment.column}" of relation "${shape.name}" does not exist`);
        }
    }
    const alias = statement.table.name;
    const columns: Binding[] = shape.columns.map((column) => ({ alias, name: column.name, type: column.type }));
    const rows = database.table(shape.oid);
    // Snapshot the old arrays: `updateRow` replaces them before ON UPDATE runs.
    const original = new Map(rows);
    const updated: { key: string; values: SqlValue[] }[] = [];
    for (const [key, values] of [...rows.entries()]) {
        const context: Context = { columns, row: values, outer: undefined };
        if (statement.where && evaluate(database, statement.where, context, params) !== true) continue;
        const next = [...values];
        for (const assignment of statement.assignments) {
            const column = shape.columns.find((candidate) => candidate.name === assignment.column)!;
            if (column.identity === 'a' && assignment.value.kind !== 'default') {
                throw new ServerError(
                    '428C9',
                    `column "${column.name}" can only be updated to DEFAULT`,
                    `Column "${column.name}" is an identity column defined as GENERATED ALWAYS.`,
                );
            }
            const raw = assignment.value.kind === 'default'
                ? columnDefault(database, column)
                : evaluate(database, assignment.value, context, params);
            next[column.attnum - 1] = coerce(raw, column.type);
        }
        validateRowShape(database, shape, next);
        updated.push({ key, values: next });
    }
    for (const row of updated) {
        maintainIndexDelete(database, shape, row.key, original.get(row.key) ?? row.values);
        database.updateRow(shape.oid, row.key, row.values);
        maintainIndexInsert(database, shape, row.key, row.values);
    }
    propagateParentUpdates(database, shape, updated, original);
    for (const row of updated) checkUnique(database, shape, row.values, new Set([row.key]));
    return returningOutcome(database, statement.returning, shape, updated, params, `UPDATE ${updated.length}`);
}

/** Applies `ON UPDATE` actions for foreign keys that point at this table. */
function propagateParentUpdates(
    database: Database,
    shape: TableShape,
    updated: { key: string; values: SqlValue[] }[],
    original: Map<string, SqlValue[]>,
): void {
    const catalog = database.catalog;
    for (const constraint of catalog.constraints) {
        if (constraint.contype !== 'f' || constraint.confrelid !== shape.oid) continue;
        const child = shapeForOid(database, constraint.relid);
        for (const row of updated) {
            const before = original.get(row.key);
            if (!before) continue;
            const oldKey = constraint.confkey.map((attnum) => before[attnum - 1] ?? null);
            const newKey = constraint.confkey.map((attnum) => row.values[attnum - 1] ?? null);
            if (oldKey.some((value) => value === null)) continue;
            if (oldKey.every((value, position) => compareValues(value, newKey[position] ?? null) === 0)) continue;
            const matches = [...database.table(child.oid).entries()].filter(([, childValues]) =>
                constraint.conkey.every((attnum, position) => compareValues(childValues[attnum - 1] ?? null, oldKey[position] ?? null) === 0),
            );
            for (const [childKey, childValues] of matches) {
                if (constraint.confupdtype === 'c') {
                    const next = [...childValues];
                    constraint.conkey.forEach((attnum, position) => {
                        next[attnum - 1] = newKey[position] ?? null;
                    });
                    validateRowShape(database, child, next);
                    maintainIndexDelete(database, child, childKey, childValues);
                    database.updateRow(child.oid, childKey, next);
                    maintainIndexInsert(database, child, childKey, next);
                    checkUnique(database, child, next, new Set([childKey]));
                    continue;
                }
                if (constraint.confupdtype === 'n') {
                    const next = [...childValues];
                    for (const attnum of constraint.conkey) next[attnum - 1] = null;
                    validateRowShape(database, child, next);
                    maintainIndexDelete(database, child, childKey, childValues);
                    database.updateRow(child.oid, childKey, next);
                    maintainIndexInsert(database, child, childKey, next);
                    checkUnique(database, child, next, new Set([childKey]));
                    continue;
                }
                if (constraint.confupdtype === 'd') {
                    const next = [...childValues];
                    for (const attnum of constraint.conkey) {
                        const column = child.columns.find((candidate) => candidate.attnum === attnum);
                        next[attnum - 1] = column ? columnDefault(database, column) : null;
                    }
                    validateRowShape(database, child, next);
                    maintainIndexDelete(database, child, childKey, childValues);
                    database.updateRow(child.oid, childKey, next);
                    maintainIndexInsert(database, child, childKey, next);
                    checkUnique(database, child, next, new Set([childKey]));
                    continue;
                }
                const labels = constraint.confkey.map((attnum) => shape.columns.find((column) => column.attnum === attnum)?.name ?? `attnum${attnum}`).join(', ');
                const rendered = oldKey.map((value) => (value === null ? 'null' : formatValue(value, TEXT))).join(', ');
                throw new ServerError(
                    '23503',
                    `update or delete on table "${shape.name}" violates foreign key constraint "${constraint.name}" on table "${child.name}"`,
                    `Key (${labels})=(${rendered}) is still referenced from table "${child.name}".`,
                    undefined,
                    undefined,
                    undefined,
                    constraint.name,
                    { schema: schemaNameOf(shape), table: shape.name },
                );
            }
        }
    }
}

function deleteRows(database: Database, statement: DeleteStatement, params: SqlValue[]): Outcome {
    const shape = tableShape(database, statement.table);
    checkGrantOnOid(database, shape.oid, 'DELETE');
    const alias = statement.table.name;
    const columns: Binding[] = shape.columns.map((column) => ({ alias, name: column.name, type: column.type }));
    const rows = database.table(shape.oid);
    const removed: { key: string; values: SqlValue[] }[] = [];
    for (const [key, values] of [...rows.entries()]) {
        const context: Context = { columns, row: values, outer: undefined };
        if (statement.where && evaluate(database, statement.where, context, params) !== true) continue;
        removed.push({ key, values });
    }
    const seen = new Set<string>();
    for (const row of removed) removeRow(database, shape, row.key, row.values, seen);
    return returningOutcome(database, statement.returning, shape, removed, params, `DELETE ${removed.length}`);
}

/** Scans the relation and reports the first row that violates a check. */
function validateCheck(database: Database, relation: { oid: number; name: string; namespace: number }, name: string, source: string): void {
    const expr = parseExpression(source);
    for (const values of database.table(relation.oid).values()) {
        if (evaluate(database, expr, rowContext(relation, database.catalog, values), []) === false) {
            throw new ServerError(
                '23514',
                `check constraint "${name}" of relation "${relation.name}" is violated by some row`,
                undefined,
                undefined,
                undefined,
                undefined,
                name,
                { schema: schemaNameOf(relation), table: relation.name },
            );
        }
    }
}

/** Scans the relation and reports the first row that violates a foreign key. */
function validateForeignKeys(database: Database, relation: { oid: number; name: string; namespace: number }, name: string): void {
    const constraint = database.catalog.constraints.find((candidate) => candidate.relid === relation.oid && candidate.contype === 'f' && candidate.name === name);
    if (!constraint) return;
    const shape = shapeForRelation(database, relation);
    const fk = shape.foreignKeys.find((candidate) => candidate.name === name);
    if (!fk) return;
    for (const values of database.table(relation.oid).values()) {
        const key = fk.conkey.map((attnum) => values[attnum - 1] ?? null);
        const nulls = key.filter((value) => value === null).length;
        if (fk.confmatchtype === 'f') {
            if (nulls === key.length) continue;
            if (nulls > 0) {
                throw new ServerError(
                    '23503',
                    `insert or update on table "${relation.name}" violates foreign key constraint "${name}"`,
                    'MATCH FULL does not allow mixing of null and nonnull key values.',
                    undefined,
                    undefined,
                    undefined,
                    name,
                    { schema: schemaNameOf(relation), table: relation.name },
                );
            }
        }
        else if (nulls > 0) continue;
        if (parentHasKey(database, fk, key)) continue;
        const parent = database.catalog.relations.find((candidate) => candidate.oid === fk.confrelid);
        const labels = fk.conkey.map((attnum) => shape.columns.find((column) => column.attnum === attnum)?.name ?? `attnum${attnum}`).join(', ');
        const rendered = key.map((value) => (value === null ? 'null' : formatValue(value, TEXT))).join(', ');
        throw new ServerError(
            '23503',
            `insert or update on table "${relation.name}" violates foreign key constraint "${name}"`,
            `Key (${labels})=(${rendered}) is not present in table "${parent?.name ?? fk.confrelid}".`,
            undefined,
            undefined,
            undefined,
            name,
            { schema: schemaNameOf(relation), table: relation.name },
        );
    }
}

function validateConstraint(database: Database, relation: { oid: number; name: string; namespace: number }, constraint: { name: string; contype: string; checkSource: string | null }): void {
    if (constraint.contype === 'c') validateCheck(database, relation, constraint.name, constraint.checkSource ?? '');
    else if (constraint.contype === 'f') validateForeignKeys(database, relation, constraint.name);
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

/** Label PostgreSQL prints for one key in a unique-violation `DETAIL`. */
function indexKeyLabel(shape: TableShape, key: { attnum: number; pretty?: string | null }): string {
    if (key.pretty !== undefined && key.pretty !== null) return key.pretty;
    return shape.columns.find((column) => column.attnum === key.attnum)?.name ?? `attnum${key.attnum}`;
}

/** Evaluates the key values of one row for a unique index. */
function indexKeyValues(database: Database, shape: TableShape, keys: UserIndexKey[], values: SqlValue[]): SqlValue[] {
    const context = rowContext(shape, database.catalog, values);
    return keys.map((key) => key.expression === undefined
        ? values[key.attnum - 1] ?? null
        : evaluate(database, parseExpression(key.expression), context, []));
}

function checkUnique(database: Database, shape: TableShape, values: SqlValue[], skipKeys: Set<string>): void {
    const rows = database.table(shape.oid);
    for (const index of shape.uniqueIndexes) {
        if (index.predicate && evaluate(database, index.predicate, rowContext(shape, database.catalog, values), []) !== true) continue;
        const candidate = index.keys.map((key) => key.expression === null
            ? values[key.attnum - 1] ?? null
            : evaluate(database, key.expression, rowContext(shape, database.catalog, values), []));
        if (candidate.some((value) => value === null)) continue;
        for (const [key, other] of rows) {
            if (skipKeys.has(key)) continue;
            const existing = index.keys.map((key2) => key2.expression === null
                ? other[key2.attnum - 1] ?? null
                : evaluate(database, key2.expression, rowContext(shape, database.catalog, other), []));
            if (existing.some((value) => value === null)) continue;
            const same = candidate.every((value, position) => compareValues(value, existing[position] ?? null) === 0);
            if (!same) continue;
            const labels = index.keys.map((key2) => indexKeyLabel(shape, key2)).join(', ');
            const rendered = candidate.map((value) => formatValue(value, TEXT)).join(', ');
            throw new ServerError('23505', `duplicate key value violates unique constraint "${index.name}"`, `Key (${labels})=(${rendered}) already exists.`, undefined, undefined, undefined, index.name, {
                schema: schemaNameOf(shape),
                table: shape.name,
            });
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

// ---------------------------------------------------------------------------
// Roles and privileges
// ---------------------------------------------------------------------------

function command(tag: string, notices?: { code: string; message: string }[]): Outcome {
    return notices && notices.length > 0 ? { kind: 'command', tag, notices } : { kind: 'command', tag };
}

function roleOrThrow(database: Database, name: string): ClusterRole {
    const role = findRole(database.roles, name);
    if (!role) throw new ServerError('42704', `role "${name}" does not exist`);
    return role;
}

function canCreateRoles(actor: ClusterRole): boolean {
    return actor.rolsuper || actor.rolcreaterole;
}

/**
 * Derives the stored secret for one `PASSWORD` clause. `password_encryption`
 * defaults to `scram-sha-256`; `md5` is accepted by `SET` but rejected here
 * because this server does not implement the MD5 handshake. A literal that is
 * already a SCRAM verifier is stored as written, like PostgreSQL.
 */
function rolePasswordVerifier(database: Database, password: string): string {
    const encryption = database.session.passwordEncryption?.() ?? 'scram-sha-256';
    if (encryption.toLowerCase() === 'md5') throw new ServerError('0A000', 'md5 password authentication is not supported');
    if (password.startsWith('SCRAM-SHA-256$')) {
        if (parseScramVerifier(password) === null) throw new ServerError('22023', 'invalid SCRAM verifier');
        return password;
    }
    return formatScramVerifier(deriveScramSecret(password));
}

function createRole(database: Database, statement: CreateRoleStatement): Outcome {
    const actor = currentRole(database);
    if (!canCreateRoles(actor)) throw new ServerError('42501', 'permission denied to create role');
    if (statement.options.rolsuper && !actor.rolsuper) throw new ServerError('42501', 'must be superuser to create superusers');
    if (statement.options.rolreplication && !actor.rolsuper) throw new ServerError('42501', 'must be superuser to create replication users');
    if (findRole(database.roles, statement.name)) throw new ServerError('42710', `role "${statement.name}" already exists`);
    const oid = Math.max(database.cluster.nextRoleOid(), ...database.roles.map((role) => role.oid + 1));
    // 角色表默认与集群目录共享，追加必须先拿到本消息的可写副本。
    database.mutableRoles().push({
        oid,
        rolname: statement.name,
        rolsuper: statement.options.rolsuper ?? false,
        rolinherit: statement.options.rolinherit ?? true,
        rolcreaterole: statement.options.rolcreaterole ?? false,
        rolcreatedb: statement.options.rolcreatedb ?? false,
        rolcanlogin: statement.options.rolcanlogin ?? false,
        rolreplication: statement.options.rolreplication ?? false,
        rolbypassrls: statement.options.rolbypassrls ?? false,
        rolconnlimit: statement.options.rolconnlimit ?? -1,
        ...(typeof statement.options.password === 'string'
            ? { rolpassword: rolePasswordVerifier(database, statement.options.password) }
            : {}),
    });
    database.markRolesDirty();
    return command('CREATE ROLE');
}

/** Rewrites the role name inside every ACL literal that mentions it. */
function renameAclReferences(database: Database, oldName: string, newName: string): void {
    const rewrite = (text: string | null | undefined): string | null | undefined => {
        if (text === null || text === undefined) return text;
        const entries = parseAcl(text).map((entry) => ({
            ...entry,
            grantee: entry.grantee === oldName ? newName : entry.grantee,
            grantor: entry.grantor === oldName ? newName : entry.grantor,
        }));
        return formatAcl(entries);
    };
    for (const row of database.databases) {
        const acl = database.databaseAcl(row.datname);
        if (acl !== null && acl !== undefined && parseAcl(acl).some((entry) => entry.grantor === oldName || entry.grantee === oldName)) {
            database.setDatabaseAcl(row.datname, rewrite(acl) ?? null);
        }
    }
    let catalogChanged = false;
    for (const relation of database.catalog.relations) {
        if (relation.relacl !== null && relation.relacl !== undefined
            && parseAcl(relation.relacl).some((entry) => entry.grantor === oldName || entry.grantee === oldName)) {
            relation.relacl = rewrite(relation.relacl) ?? null;
            catalogChanged = true;
        }
    }
    for (const [key, text] of Object.entries(database.catalog.namespaceAcls ?? {})) {
        if (parseAcl(text).some((entry) => entry.grantor === oldName || entry.grantee === oldName)) {
            database.catalog.namespaceAcls![key] = rewrite(text) ?? '{}';
            catalogChanged = true;
        }
    }
    if (catalogChanged) database.markCatalogDirty();
}

function alterRole(database: Database, statement: AlterRoleStatement): Outcome {
    // 后面的改名与选项写入是原地修改，先从共享的集群角色表切出可写副本。
    database.mutableRoles();
    const actor = currentRole(database);
    const target = roleOrThrow(database, statement.name);
    if (!actor.rolsuper && (!actor.rolcreaterole || target.rolsuper)) {
        throw new ServerError('42501', `permission denied`);
    }
    if (statement.options.rolsuper && !actor.rolsuper) throw new ServerError('42501', 'must be superuser to alter superusers');
    if (statement.rename !== undefined) {
        if (findRole(database.roles, statement.rename)) throw new ServerError('42710', `role "${statement.rename}" already exists`);
        renameAclReferences(database, target.rolname, statement.rename);
        target.rolname = statement.rename;
    }
    if (statement.options.password !== undefined) {
        target.rolpassword =
            statement.options.password === null ? undefined : rolePasswordVerifier(database, statement.options.password);
    }
    const { password: _password, ...flags } = statement.options;
    for (const [key, value] of Object.entries(flags) as [keyof ClusterRole, boolean | number][]) {
        (target[key] as boolean | number) = value;
    }
    database.markRolesDirty();
    return command('ALTER ROLE');
}

function dropRole(database: Database, statement: DropRoleStatement): Outcome {
    const actor = currentRole(database);
    if (!canCreateRoles(actor)) throw new ServerError('42501', 'permission denied');
    const notices: { code: string; message: string }[] = [];
    for (const name of statement.names) {
        const target = findRole(database.roles, name);
        if (!target) {
            if (!statement.ifExists) throw new ServerError('42704', `role "${name}" does not exist`);
            notices.push({ code: '00000', message: `role "${name}" does not exist, skipping` });
            continue;
        }
        const dependency = database.databases.find((row) => row.datdba === target.oid);
        if (dependency) {
            throw new ServerError(
                '2BP01',
                `role "${name}" cannot be dropped because some objects depend on it`,
                `owner of database ${dependency.datname}`,
            );
        }
        const ownedRelation = database.catalog.relations.find((relation) => relation.owner === target.oid);
        if (ownedRelation) {
            throw new ServerError(
                '2BP01',
                `role "${name}" cannot be dropped because some objects depend on it`,
                `owner of table ${ownedRelation.name}`,
            );
        }
        database.roles = database.roles.filter((role) => role.oid !== target.oid);
    }
    database.markRolesDirty();
    return command('DROP ROLE', notices);
}

/** Owner name recorded as grantor for `GRANT`/`REVOKE` on one object. */
function objectOwnerName(database: Database, statement: GrantStatement | RevokeStatement): string {
    if (statement.objectType === 'database') {
        const row = database.databases.find((candidate) => candidate.datname === statement.objectName);
        if (!row) throw new ServerError('3D000', `database "${statement.objectName}" does not exist`);
        const name = pgGetUserById(row.datdba, database.roles);
        return typeof name === 'string' ? name : 'postgres';
    }
    if (statement.objectType === 'schema') {
        if (namespaceOid(statement.objectName) === undefined) throw new ServerError('3F000', `schema "${statement.objectName}" does not exist`);
        return statement.objectName === 'public' ? 'pg_database_owner' : 'postgres';
    }
    const relation = relationByName(database.catalog, statement.objectName);
    if (!relation) throw new ServerError('42P01', `relation "${statement.objectName}" does not exist`);
    const name = pgGetUserById(relation.owner, database.roles);
    return typeof name === 'string' ? name : 'postgres';
}

function authorizeGrant(database: Database, statement: GrantStatement | RevokeStatement, grantor: string): void {
    const actor = currentRole(database);
    if (actor.rolsuper || actor.rolname === grantor) return;
    if (statement.objectType === 'schema' && statement.objectName === 'public') {
        const row = database.databases.find((candidate) => candidate.datname === database.session.database);
        if (row && pgGetUserById(row.datdba, database.roles) === actor.rolname) return;
    }
    throw new ServerError('42501', `permission denied for ${statement.objectType} ${statement.objectName}`);
}

function checkGrantees(database: Database, grantees: string[]): void {
    for (const grantee of grantees) {
        if (grantee === '') continue;
        if (!findRole(database.roles, grantee)) throw new ServerError('42704', `role "${grantee}" does not exist`);
    }
}

function grantPrivileges(database: Database, statement: GrantStatement): Outcome {
    const grantor = objectOwnerName(database, statement);
    authorizeGrant(database, statement, grantor);
    const letters = privilegeLetters(statement.objectType, statement.privileges);
    if (letters.length === 0) throw new ServerError('42601', 'syntax error', `unrecognized privilege type: "${statement.privileges.join(', ')}"`);
    checkGrantees(database, statement.grantees);
    if (statement.objectType === 'database') {
        const acl = database.databaseAcl(statement.objectName);
        const entries = acl === null || acl === undefined ? defaultAcl('database', grantor) : parseAcl(acl);
        database.setDatabaseAcl(
            statement.objectName,
            formatAcl(grantAcl(entries, 'database', statement.grantees, letters, grantor, statement.grantOption)),
        );
        return command('GRANT');
    }
    if (statement.objectType === 'schema') {
        const namespace = SYSTEM_NAMESPACES.find((candidate) => candidate.name === statement.objectName)!;
        const text = database.catalog.namespaceAcls?.[String(namespace.oid)] ?? defaultNamespaceAcl(namespace.name);
        const entries = text === null ? [] : parseAcl(text);
        database.catalog.namespaceAcls = { ...(database.catalog.namespaceAcls ?? {}) };
        database.catalog.namespaceAcls[String(namespace.oid)] =
            formatAcl(grantAcl(entries, 'schema', statement.grantees, letters, grantor, statement.grantOption));
        database.markCatalogDirty();
        return command('GRANT');
    }
    const relation = relationByName(database.catalog, statement.objectName)!;
    const entries = relation.relacl === null || relation.relacl === undefined
        ? defaultAcl('table', grantor)
        : parseAcl(relation.relacl);
    relation.relacl = formatAcl(grantAcl(entries, 'table', statement.grantees, letters, grantor, statement.grantOption));
    database.markCatalogDirty();
    return command('GRANT');
}

function revokePrivileges(database: Database, statement: RevokeStatement): Outcome {
    const grantor = objectOwnerName(database, statement);
    authorizeGrant(database, statement, grantor);
    const letters = privilegeLetters(statement.objectType, statement.privileges);
    if (letters.length === 0) throw new ServerError('42601', 'syntax error', `unrecognized privilege type: "${statement.privileges.join(', ')}"`);
    checkGrantees(database, statement.grantees);
    const touched = (existing: string | null | undefined): boolean =>
        existing !== null && existing !== undefined
        || statement.grantees.some((grantee) => grantee === '' || grantee === grantor);
    if (statement.objectType === 'database') {
        const acl = database.databaseAcl(statement.objectName);
        if (!touched(acl)) return command('REVOKE');
        const entries = acl === null || acl === undefined ? defaultAcl('database', grantor) : parseAcl(acl);
        database.setDatabaseAcl(
            statement.objectName,
            formatAcl(revokeAcl(entries, 'database', statement.grantees, letters, statement.grantOptionOnly)),
        );
        return command('REVOKE');
    }
    if (statement.objectType === 'schema') {
        const namespace = SYSTEM_NAMESPACES.find((candidate) => candidate.name === statement.objectName)!;
        const text = database.catalog.namespaceAcls?.[String(namespace.oid)] ?? defaultNamespaceAcl(namespace.name);
        if (!touched(text)) return command('REVOKE');
        const entries = text === null ? [] : parseAcl(text);
        database.catalog.namespaceAcls = { ...(database.catalog.namespaceAcls ?? {}) };
        database.catalog.namespaceAcls[String(namespace.oid)] =
            formatAcl(revokeAcl(entries, 'schema', statement.grantees, letters, statement.grantOptionOnly));
        database.markCatalogDirty();
        return command('REVOKE');
    }
    const relation = relationByName(database.catalog, statement.objectName)!;
    if (!touched(relation.relacl)) return command('REVOKE');
    const entries = relation.relacl === null || relation.relacl === undefined
        ? defaultAcl('table', grantor)
        : parseAcl(relation.relacl);
    relation.relacl = formatAcl(revokeAcl(entries, 'table', statement.grantees, letters, statement.grantOptionOnly));
    database.markCatalogDirty();
    return command('REVOKE');
}
