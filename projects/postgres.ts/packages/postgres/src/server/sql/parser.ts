/** Lexer, AST and recursive-descent parser for the SQL subset the server runs. */

import { ServerError } from '../errors.ts';
import { arrayOf, type DataType, type SqlValue, typeFromName } from './types.ts';

export interface ExprBase {
    kind: string;
    /** Zero-based source offset of the expression, used for error positions. */
    start?: number;
}

export interface LiteralExpr extends ExprBase {
    kind: 'literal';
    value: SqlValue;
    /** Source spelling, used for `NULL`, booleans and untyped numerics. */
    text: string;
    /** True for an unquoted numeric literal, whose value keeps its scale. */
    numeric?: boolean;
}

export interface ParamExpr extends ExprBase {
    kind: 'param';
    index: number;
}

export interface ColumnExpr extends ExprBase {
    kind: 'column';
    qualifier: string | undefined;
    name: string;
}

export interface FrameBound {
    type: 'unbounded-preceding' | 'preceding' | 'current-row' | 'following' | 'unbounded-following';
    offset?: Expr;
}

export interface WindowFrame {
    mode: 'rows' | 'range';
    start: FrameBound;
    end: FrameBound;
}

export interface WindowSpec {
    partitionBy: Expr[];
    orderBy: OrderItem[];
    frame: WindowFrame | undefined;
}

export interface FunctionExpr extends ExprBase {
    kind: 'function';
    schema: string | undefined;
    name: string;
    args: Expr[];
    star: boolean;
    /** `count(DISTINCT x)`. */
    distinct?: boolean;
    /** Window specification when the call carries `OVER (...)`. */
    over?: WindowSpec;
}

export interface CastExpr extends ExprBase {
    kind: 'cast';
    expr: Expr;
    type: DataType;
}

export interface UnaryExpr extends ExprBase {
    kind: 'unary';
    op: string;
    expr: Expr;
}

export interface BinaryExpr extends ExprBase {
    kind: 'binary';
    op: string;
    left: Expr;
    right: Expr;
}

export interface AnyExpr extends ExprBase {
    kind: 'any';
    op: string;
    left: Expr;
    array: Expr;
}

export interface CaseExpr extends ExprBase {
    kind: 'case';
    operand: Expr | undefined;
    whens: { when: Expr; then: Expr }[];
    otherwise: Expr | undefined;
}

export interface SubqueryExpr extends ExprBase {
    kind: 'subquery';
    select: SelectStatement;
}

export interface ExistsExpr extends ExprBase {
    kind: 'exists';
    select: SelectStatement;
}

export interface InExpr extends ExprBase {
    kind: 'in';
    expr: Expr;
    list: Expr[];
    /** `IN (SELECT ...)`, exactly one of `list` and `select` is set. */
    select: SelectStatement | undefined;
    negated: boolean;
}

export interface IsNullExpr extends ExprBase {
    kind: 'isnull';
    expr: Expr;
    negated: boolean;
}

export interface CollateExpr extends ExprBase {
    kind: 'collate';
    expr: Expr;
    collation: string;
}

export interface ArrayExpr extends ExprBase {
    kind: 'array';
    elements: Expr[] | undefined;
    select: SelectStatement | undefined;
}

export interface SubscriptExpr extends ExprBase {
    kind: 'subscript';
    expr: Expr;
    index: Expr;
}

export interface StarExpr extends ExprBase {
    kind: 'star';
    qualifier: string | undefined;
}

/** The `DEFAULT` keyword, valid only inside `INSERT ... VALUES`. */
export interface DefaultExpr extends ExprBase {
    kind: 'default';
}

/** Every expression the parser can produce, discriminated by `kind`. */
export type Expr =
    | LiteralExpr
    | ParamExpr
    | ColumnExpr
    | FunctionExpr
    | CastExpr
    | UnaryExpr
    | BinaryExpr
    | AnyExpr
    | CaseExpr
    | SubqueryExpr
    | ExistsExpr
    | InExpr
    | IsNullExpr
    | CollateExpr
    | ArrayExpr
    | SubscriptExpr
    | StarExpr
    | DefaultExpr;

export interface Target {
    expr: Expr;
    alias: string | undefined;
}

export interface OrderItem {
    expr: Expr;
    direction: 'ASC' | 'DESC';
    nulls: 'FIRST' | 'LAST' | undefined;
}

export interface RelationRef {
    kind: 'relation';
    schema: string | undefined;
    name: string;
    alias: string | undefined;
    /** Zero-based source offset of the relation reference. */
    start?: number;
    /** Present when the reference is a set-returning function call in `FROM`. */
    args: Expr[] | undefined;
    /** `WITH ORDINALITY` adds a trailing position column. */
    ordinality?: boolean;
    /** `AS alias(c1, c2, ...)` renames the function's output columns. */
    columnAliases?: string[];
}

export interface SubqueryRef {
    kind: 'subquery';
    select: SelectStatement;
    alias: string | undefined;
    /** `AS alias(c1, c2, ...)` renames the subquery's output columns. */
    columns?: string[];
}

export interface JoinRef {
    kind: 'join';
    left: FromItem;
    right: FromItem;
    joinType: 'inner' | 'left' | 'right' | 'full' | 'cross';
    on: Expr | undefined;
    /** `JOIN ... USING (a, b)`; mutually exclusive with `on`. */
    using?: string[];
}

export type FromItem = RelationRef | SubqueryRef | JoinRef;

export interface SelectCore {
    kind: 'select';
    targets: Target[];
    from: FromItem[];
    where: Expr | undefined;
    groupBy: Expr[];
    having: Expr | undefined;
    distinct: boolean;
    /** `VALUES (...), (...)` when the core is a values list instead of a SELECT. */
    values: Expr[][] | undefined;
}

export interface CommonTableExpression {
    name: string;
    columns: string[] | undefined;
    select: SelectStatement;
}

export interface WithClause {
    recursive: boolean;
    ctes: CommonTableExpression[];
}

export interface SelectStatement {
    kind: 'select';
    core: SelectCore;
    unions: { all: boolean; op: 'union' | 'intersect' | 'except'; core: SelectCore }[];
    orderBy: OrderItem[];
    limit: Expr | undefined;
    offset: Expr | undefined;
    /** `WITH [RECURSIVE] ...` attached to this query. */
    with?: WithClause;
}

export interface InsertStatement {
    kind: 'insert';
    table: RelationRef;
    columns: string[] | undefined;
    rows: Expr[][];
    defaultValues: boolean;
    returning: Target[] | undefined;
}

export interface UpdateStatement {
    kind: 'update';
    table: RelationRef;
    assignments: { column: string; value: Expr }[];
    where: Expr | undefined;
    returning: Target[] | undefined;
}

export interface DeleteStatement {
    kind: 'delete';
    table: RelationRef;
    where: Expr | undefined;
    returning: Target[] | undefined;
}

/** `serial`-family pseudo types, resolved to `int2`/`int4`/`int8` by the parser. */
export type SerialKind = 'small' | 'normal' | 'big';

/** One `REFERENCES` clause: target relation, columns and referential actions. */
export interface ReferenceClause {
    table: RelationRef;
    columns: string[] | undefined;
    onDelete: 'a' | 'r' | 'c' | 'n' | 'd' | undefined;
    onUpdate: 'a' | 'r' | 'c' | 'n' | 'd' | undefined;
}

export interface ColumnCheck {
    name: string | undefined;
    expr: Expr;
    /** Source spelling of the expression, rendered by `pg_get_constraintdef`. */
    source: string;
}

export interface ColumnDef {
    name: string;
    type: DataType;
    notNull: boolean;
    defaultExpr: Expr | undefined;
    primaryKey: boolean;
    unique: boolean;
    serial: SerialKind | undefined;
    check: ColumnCheck | undefined;
    references: ReferenceClause | undefined;
}

export interface PrimaryKeyConstraint {
    kind: 'primary' | 'unique';
    name: string | undefined;
    columns: string[];
}

export interface CheckConstraint {
    kind: 'check';
    name: string | undefined;
    expr: Expr;
    source: string;
    notValid: boolean;
}

export interface ForeignKeyConstraint {
    kind: 'foreign';
    name: string | undefined;
    columns: string[];
    reference: ReferenceClause;
}

export type TableConstraint = PrimaryKeyConstraint | CheckConstraint | ForeignKeyConstraint;

export interface CreateTableStatement {
    kind: 'create-table';
    table: RelationRef;
    ifNotExists: boolean;
    columns: ColumnDef[];
    constraints: TableConstraint[];
}

export interface DropTableStatement {
    kind: 'drop-table';
    table: RelationRef;
    ifExists: boolean;
    cascade: boolean;
}

export interface CreateIndexStatement {
    kind: 'create-index';
    name: string;
    table: RelationRef;
    unique: boolean;
    ifNotExists: boolean;
    method: string;
    columns: string[];
    where: Expr | undefined;
    /** Source spelling of the predicate, rendered by `pg_get_indexdef`. */
    whereSource: string | undefined;
}

export interface DropIndexStatement {
    kind: 'drop-index';
    name: string;
    ifExists: boolean;
    cascade: boolean;
}

export type AlterTableAction =
    | { kind: 'add-check'; name: string | undefined; expr: Expr; source: string; notValid: boolean }
    | { kind: 'add-foreign'; name: string | undefined; columns: string[]; reference: ReferenceClause }
    | { kind: 'validate'; name: string };

export interface AlterTableStatement {
    kind: 'alter-table';
    table: RelationRef;
    action: AlterTableAction;
}

export interface TransactionStatement {
    kind: 'transaction';
    command: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback-to';
    name: string | undefined;
}

export type Statement =
    | SelectStatement
    | InsertStatement
    | UpdateStatement
    | DeleteStatement
    | CreateTableStatement
    | DropTableStatement
    | CreateIndexStatement
    | DropIndexStatement
    | AlterTableStatement
    | TransactionStatement;

type TokenKind = 'ident' | 'qident' | 'number' | 'string' | 'param' | 'op' | 'punct' | 'eof';

interface Token {
    kind: TokenKind;
    value: string;
    upper: string;
    start: number;
}

const MULTI_OPERATORS = ['!~*', '::', '<>', '<=', '>=', '!=', '!~', '||', '~*'];

const RESERVED = new Set([
    'ABORT',
    'ACTION',
    'ADD',
    'ALL',
    'ALTER',
    'AND',
    'ANY',
    'AS',
    'ASC',
    'BEGIN',
    'BETWEEN',
    'BY',
    'CASCADE',
    'CASE',
    'CAST',
    'CHECK',
    'COLLATE',
    'COMMIT',
    'CONSTRAINT',
    'CREATE',
    'CROSS',
    'CURRENT',
    'DEFAULT',
    'DELETE',
    'DESC',
    'DISTINCT',
    'DROP',
    'ELSE',
    'END',
    'EXCEPT',
    'EXISTS',
    'FALSE',
    'FOLLOWING',
    'FOREIGN',
    'FROM',
    'FULL',
    'GROUP',
    'HAVING',
    'IF',
    'ILIKE',
    'IN',
    'INDEX',
    'INNER',
    'INSERT',
    'INTERSECT',
    'INTO',
    'IS',
    'JOIN',
    'KEY',
    'LEFT',
    'LIKE',
    'LIMIT',
    'NOT',
    'NULL',
    'NULLS',
    'OFFSET',
    'ON',
    'OR',
    'ORDER',
    'OUTER',
    'OVER',
    'PARTITION',
    'PRECEDING',
    'PRIMARY',
    'RANGE',
    'RECURSIVE',
    'REFERENCES',
    'RELEASE',
    'RESTRICT',
    'RETURNING',
    'RIGHT',
    'ROLLBACK',
    'ROWS',
    'SAVEPOINT',
    'SELECT',
    'SET',
    'SOME',
    'START',
    'TABLE',
    'TEXT',
    'THEN',
    'TRANSACTION',
    'TRUE',
    'UNBOUNDED',
    'UNION',
    'UNIQUE',
    'UPDATE',
    'USING',
    'VALID',
    'VALIDATE',
    'VALUES',
    'WHEN',
    'WHERE',
    'WORK',
]);

function syntax(message: string, token: Token): ServerError {
    const near = token.kind === 'eof' ? 'end of input' : token.value;
    // PostgreSQL spells the generic parse failure `syntax error at [or near]`,
    // with no DETAIL. Keep the caret position either way.
    if (message === 'syntax error') {
        return new ServerError('42601', `syntax error at ${token.kind === 'eof' ? 'end of input' : `or near "${near}"`}`, undefined, token.start);
    }
    return new ServerError('42601', message, `near "${near}"`, token.start);
}

class Lexer {
    private readonly sql: string;
    private offset = 0;

    constructor(sql: string) {
        this.sql = sql;
    }

    tokens(): Token[] {
        const result: Token[] = [];
        while (true) {
            this.skipTrivia();
            if (this.offset >= this.sql.length) {
                result.push({ kind: 'eof', value: '', upper: '', start: this.offset });
                return result;
            }
            result.push(this.scan());
        }
    }

    private skipTrivia(): void {
        while (this.offset < this.sql.length) {
            const character = this.sql[this.offset] ?? '';
            if (/\s/.test(character)) {
                this.offset += 1;
                continue;
            }
            if (character === '-' && this.sql[this.offset + 1] === '-') {
                const end = this.sql.indexOf('\n', this.offset);
                this.offset = end === -1 ? this.sql.length : end + 1;
                continue;
            }
            if (character === '/' && this.sql[this.offset + 1] === '*') {
                const end = this.sql.indexOf('*/', this.offset + 2);
                this.offset = end === -1 ? this.sql.length : end + 2;
                continue;
            }
            return;
        }
    }

    private scan(): Token {
        const start = this.offset;
        const character = this.sql[start] ?? '';
        if ((character === 'E' || character === 'e') && this.sql[start + 1] === "'") {
            return this.scanEscapeString(start);
        }
        if (/[A-Za-z_]/.test(character)) {
            let end = start + 1;
            while (end < this.sql.length && /[A-Za-z0-9_$]/.test(this.sql[end] ?? '')) end += 1;
            const value = this.sql.slice(start, end);
            this.offset = end;
            return { kind: 'ident', value, upper: value.toUpperCase(), start };
        }
        if (character === '"') {
            let end = start + 1;
            let value = '';
            while (end < this.sql.length) {
                const current = this.sql[end] ?? '';
                if (current === '"') {
                    if (this.sql[end + 1] === '"') {
                        value += '"';
                        end += 2;
                        continue;
                    }
                    this.offset = end + 1;
                    return { kind: 'qident', value, upper: value.toUpperCase(), start };
                }
                value += current;
                end += 1;
            }
            throw new ServerError('42601', 'unterminated quoted identifier');
        }
        if (character === "'") {
            let end = start + 1;
            let value = '';
            while (end < this.sql.length) {
                const current = this.sql[end] ?? '';
                if (current === "'") {
                    if (this.sql[end + 1] === "'") {
                        value += "'";
                        end += 2;
                        continue;
                    }
                    this.offset = end + 1;
                    return { kind: 'string', value, upper: '', start };
                }
                value += current;
                end += 1;
            }
            throw new ServerError('42601', 'unterminated string literal');
        }
        if (/[0-9]/.test(character)) {
            let end = start;
            while (end < this.sql.length && /[0-9]/.test(this.sql[end] ?? '')) end += 1;
            if (this.sql[end] === '.' && /[0-9]/.test(this.sql[end + 1] ?? '')) {
                end += 1;
                while (end < this.sql.length && /[0-9]/.test(this.sql[end] ?? '')) end += 1;
            }
            if ((this.sql[end] === 'e' || this.sql[end] === 'E') && /[0-9+-]/.test(this.sql[end + 1] ?? '')) {
                end += 1;
                if (this.sql[end] === '+' || this.sql[end] === '-') end += 1;
                while (end < this.sql.length && /[0-9]/.test(this.sql[end] ?? '')) end += 1;
            }
            const value = this.sql.slice(start, end);
            this.offset = end;
            return { kind: 'number', value, upper: value, start };
        }
        if (character === '$' && /[0-9]/.test(this.sql[start + 1] ?? '')) {
            let end = start + 1;
            while (end < this.sql.length && /[0-9]/.test(this.sql[end] ?? '')) end += 1;
            const value = this.sql.slice(start + 1, end);
            this.offset = end;
            return { kind: 'param', value, upper: value, start };
        }
        for (const operator of MULTI_OPERATORS) {
            if (this.sql.startsWith(operator, start)) {
                this.offset = start + operator.length;
                return { kind: 'op', value: operator, upper: operator, start };
            }
        }
        if ('()[]{},;.'.includes(character)) {
            this.offset = start + 1;
            return { kind: 'punct', value: character, upper: character, start };
        }
        if ('=<>+-*/%~:'.includes(character)) {
            this.offset = start + 1;
            return { kind: 'op', value: character, upper: character, start };
        }
        throw new ServerError('42601', `unexpected character "${character}"`);
    }

    /** `E'...'`: a string literal that honours backslash escapes. */
    private scanEscapeString(start: number): Token {
        let end = start + 2;
        let value = '';
        while (end < this.sql.length) {
            const current = this.sql[end] ?? '';
            if (current === "'") {
                if (this.sql[end + 1] === "'") {
                    value += "'";
                    end += 2;
                    continue;
                }
                this.offset = end + 1;
                return { kind: 'string', value, upper: '', start };
            }
            if (current === '\\') {
                const escaped = this.sql[end + 1] ?? '';
                const mapped: Record<string, string> = {
                    n: '\n',
                    t: '\t',
                    r: '\r',
                    b: '\b',
                    f: '\f',
                    '\\': '\\',
                    "'": "'",
                    '"': '"',
                };
                value += mapped[escaped] ?? escaped;
                end += 2;
                continue;
            }
            value += current;
            end += 1;
        }
        throw new ServerError('42601', 'unterminated string literal', undefined, start);
    }
}

class Parser {
    private readonly sql: string;
    private readonly tokens: Token[];
    private index = 0;

    constructor(sql: string) {
        this.sql = sql;
        this.tokens = new Lexer(sql).tokens();
    }

    /** Source text of the tokens consumed since `start`, trimmed. */
    private sourceSince(start: number): string {
        return this.sql.slice(start, this.peek().start).trim();
    }

    parseStatement(): Statement {
        const token = this.peek();
        if (token.upper === 'SELECT') return this.parseSelect();
        if (token.upper === 'WITH') {
            const withClause = this.parseWith();
            if (this.at('SELECT') || this.at('VALUES')) {
                const select = this.parseSelect();
                select.with = withClause;
                return select;
            }
            throw new ServerError('0A000', 'feature not supported', 'data-modifying statements in WITH are not implemented');
        }
        if (token.upper === 'INSERT') return this.parseInsert();
        if (token.upper === 'UPDATE') return this.parseUpdate();
        if (token.upper === 'DELETE') return this.parseDelete();
        if (token.upper === 'CREATE') return this.parseCreate();
        if (token.upper === 'DROP') return this.parseDrop();
        if (token.upper === 'ALTER') return this.parseAlter();
        if (token.upper === 'BEGIN' || token.upper === 'START') return this.parseBegin();
        if (token.upper === 'COMMIT' || token.upper === 'END') return this.parseTransaction('commit');
        if (token.upper === 'ROLLBACK' || token.upper === 'ABORT') return this.parseRollback();
        if (token.upper === 'SAVEPOINT') {
            this.next();
            return { kind: 'transaction', command: 'savepoint', name: this.identifier() };
        }
        if (token.upper === 'RELEASE') {
            this.next();
            this.accept('SAVEPOINT');
            return { kind: 'transaction', command: 'release', name: this.identifier() };
        }
        throw new ServerError('0A000', 'feature not supported', `statement is not implemented: ${token.upper || 'end of input'}`);
    }

    peek(offset = 0): Token {
        return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] ?? this.tokens[this.tokens.length - 1]!;
    }

    private next(): Token {
        const token = this.peek();
        if (token.kind !== 'eof') this.index += 1;
        return token;
    }

    private at(value: string): boolean {
        const token = this.peek();
        return token.upper === value || token.value === value;
    }

    private accept(value: string): boolean {
        if (!this.at(value)) return false;
        this.index += 1;
        return true;
    }

    private expect(value: string): Token {
        const token = this.peek();
        if (!this.at(value)) throw syntax(`syntax error: expected "${value}"`, token);
        this.index += 1;
        return token;
    }

    private identifier(): string {
        const token = this.peek();
        if (token.kind === 'ident' || token.kind === 'qident') {
            this.index += 1;
            return token.kind === 'qident' ? token.value : token.value.toLowerCase();
        }
        throw syntax('syntax error: expected an identifier', token);
    }

    private parseWith(): WithClause {
        this.expect('WITH');
        const recursive = this.accept('RECURSIVE');
        const ctes: CommonTableExpression[] = [];
        do {
            const name = this.identifier();
            let columns: string[] | undefined;
            if (this.at('(')) {
                this.next();
                columns = [];
                do {
                    columns.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
            }
            this.expect('AS');
            this.expect('(');
            const select = this.parseSelect();
            this.expect(')');
            ctes.push({ name, columns, select });
        } while (this.accept(','));
        return { recursive, ctes };
    }

    private parseSelect(): SelectStatement {
        const core = this.parseSelectCore();
        const unions: SelectStatement['unions'] = [];
        while (this.at('UNION') || this.at('INTERSECT') || this.at('EXCEPT')) {
            const operator = this.next().upper.toLowerCase() as 'union' | 'intersect' | 'except';
            const all = this.accept('ALL');
            unions.push({ all, op: operator, core: this.parseSelectCore() });
        }
        const orderBy = this.at('ORDER') ? this.parseOrderBy() : [];
        let limit: Expr | undefined;
        let offset: Expr | undefined;
        if (this.at('OFFSET')) {
            this.next();
            offset = this.parseExpr();
            this.accept('ROW');
            this.accept('ROWS');
        }
        if (this.at('LIMIT')) {
            this.next();
            limit = this.accept('ALL') ? undefined : this.parseExpr();
        }
        return { kind: 'select', core, unions, orderBy, limit, offset };
    }

    private parseSelectCore(): SelectCore {
        if (this.at('VALUES')) {
            this.next();
            const values: Expr[][] = [];
            do {
                this.expect('(');
                values.push(this.parseExprList());
                this.expect(')');
            } while (this.accept(','));
            return {
                kind: 'select',
                targets: [],
                from: [],
                where: undefined,
                groupBy: [],
                having: undefined,
                distinct: false,
                values,
            };
        }
        this.expect('SELECT');
        const distinct = this.accept('DISTINCT');
        this.accept('ALL');
        const targets: Target[] = [];
        do {
            targets.push(this.parseTarget());
        } while (this.accept(','));
        const from = this.at('FROM') ? this.parseFrom() : [];
        const where = this.at('WHERE') ? (this.next(), this.parseExpr()) : undefined;
        const groupBy = this.at('GROUP') ? (this.next(), this.expect('BY'), this.parseExprList()) : [];
        const having = this.at('HAVING') ? (this.next(), this.parseExpr()) : undefined;
        return { kind: 'select', targets, from, where, groupBy, having, distinct, values: undefined };
    }

    private parseTarget(): Target {
        if (this.at('*')) {
            this.next();
            return { expr: { kind: 'star', qualifier: undefined } satisfies StarExpr, alias: undefined };
        }
        const expr = this.parseExpr();
        if (this.at('AS')) {
            this.next();
            return { expr, alias: this.identifier() };
        }
        const token = this.peek();
        if ((token.kind === 'ident' || token.kind === 'qident') && !RESERVED.has(token.upper)) {
            this.next();
            return { expr, alias: token.kind === 'qident' ? token.value : token.value.toLowerCase() };
        }
        return { expr, alias: undefined };
    }

    private parseFrom(): FromItem[] {
        this.expect('FROM');
        const items: FromItem[] = [this.parseJoin()];
        while (this.accept(',')) items.push(this.parseJoin());
        return items;
    }

    private parseJoin(): FromItem {
        let left = this.parseFromPrimary();
        while (true) {
            let joinType: JoinRef['joinType'] | undefined;
            if (this.at('JOIN')) {
                this.next();
                joinType = 'inner';
            }
            else if (this.at('INNER')) {
                this.next();
                this.expect('JOIN');
                joinType = 'inner';
            }
            else if (this.at('CROSS')) {
                this.next();
                this.expect('JOIN');
                left = { kind: 'join', left, right: this.parseFromPrimary(), joinType: 'cross', on: undefined };
                continue;
            }
            else if (this.at('LEFT') || this.at('RIGHT') || this.at('FULL')) {
                const keyword = this.next().upper;
                this.accept('OUTER');
                this.expect('JOIN');
                joinType = keyword === 'LEFT' ? 'left' : keyword === 'RIGHT' ? 'right' : 'full';
            }
            if (joinType === undefined) return left;
            const right = this.parseFromPrimary();
            if (this.at('USING')) {
                this.next();
                this.expect('(');
                const using: string[] = [];
                do {
                    using.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
                left = { kind: 'join', left, right, joinType, on: undefined, using };
                continue;
            }
            const on = this.at('ON') ? (this.next(), this.parseExpr()) : undefined;
            if (on === undefined && joinType !== 'inner') throw syntax('syntax error: expected "ON" or "USING"', this.peek());
            left = { kind: 'join', left, right, joinType, on };
        }
    }

    private parseFromPrimary(): FromItem {
        if (this.at('(')) {
            this.next();
            if (this.at('SELECT') || this.at('VALUES')) {
                return this.parseFromSubquery(this.parseSelect());
            }
            if (this.at('WITH')) {
                const withClause = this.parseWith();
                if (!this.at('SELECT') && !this.at('VALUES')) {
                    throw new ServerError('0A000', 'feature not supported', 'data-modifying statements in WITH are not implemented');
                }
                const select = this.parseSelect();
                select.with = withClause;
                return this.parseFromSubquery(select);
            }
            const nested = this.parseFrom()[0];
            this.expect(')');
            if (!nested) throw syntax('syntax error: empty join item', this.peek());
            return nested;
        }
        const startToken = this.peek();
        const names = this.parseNamePath();
        if (this.at('(')) {
            // A set-returning function in FROM: parsed, but only executed when
            // the surrounding subquery itself runs.
            this.next();
            const args = this.at(')') ? [] : this.parseExprList();
            this.expect(')');
            let ordinality = false;
            if (this.at('WITH')) {
                this.next();
                this.expect('ORDINALITY');
                ordinality = true;
            }
            let alias: string | undefined;
            let columnAliases: string[] | undefined;
            if (this.at('AS')) {
                this.next();
                alias = this.identifier();
            } else {
                const next = this.peek();
                if ((next.kind === 'ident' || next.kind === 'qident') && !RESERVED.has(next.upper)) {
                    this.next();
                    alias = next.kind === 'qident' ? next.value : next.value.toLowerCase();
                }
            }
            if (alias !== undefined && this.at('(')) {
                this.next();
                columnAliases = [];
                do {
                    columnAliases.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
            }
            const schema = names.length > 1 ? names[names.length - 2] : undefined;
            return { kind: 'relation', schema, name: names[names.length - 1] ?? '', alias, start: startToken.start, args, ordinality, columnAliases };
        }
        const alias = this.parseAlias();
        const schema = names.length > 1 ? names[names.length - 2] : undefined;
        const name = names[names.length - 1] ?? '';
        return { kind: 'relation', schema, name, alias, start: startToken.start, args: undefined };
    }

    /** Consumes `) [AS] alias [(c1, c2, ...)]` for a parenthesised subquery. */
    private parseFromSubquery(select: SelectStatement): SubqueryRef {
        this.expect(')');
        const alias = this.parseAlias();
        let columns: string[] | undefined;
        if (alias !== undefined && this.at('(')) {
            this.next();
            columns = [];
            do {
                columns.push(this.identifier());
            } while (this.accept(','));
            this.expect(')');
        }
        return { kind: 'subquery', select, alias, columns };
    }

    private parseAlias(): string | undefined {
        if (this.at('AS')) {
            this.next();
            return this.identifier();
        }
        const token = this.peek();
        if ((token.kind === 'ident' || token.kind === 'qident') && !RESERVED.has(token.upper)) {
            this.next();
            return token.kind === 'qident' ? token.value : token.value.toLowerCase();
        }
        return undefined;
    }

    private parseNamePath(): string[] {
        const names = [this.identifier()];
        while (this.at('.')) {
            this.next();
            names.push(this.identifier());
        }
        return names;
    }

    private parseOrderBy(): OrderItem[] {
        this.expect('ORDER');
        this.expect('BY');
        const items: OrderItem[] = [];
        do {
            const expr = this.parseExpr();
            let direction: 'ASC' | 'DESC' = 'ASC';
            if (this.accept('ASC')) direction = 'ASC';
            else if (this.accept('DESC')) direction = 'DESC';
            let nulls: 'FIRST' | 'LAST' | undefined;
            if (this.at('NULLS')) {
                this.next();
                if (this.accept('FIRST')) nulls = 'FIRST';
                else {
                    this.expect('LAST');
                    nulls = 'LAST';
                }
            }
            items.push({ expr, direction, nulls });
        } while (this.accept(','));
        return items;
    }

    private parseExprList(): Expr[] {
        const list: Expr[] = [];
        do {
            list.push(this.parseExpr());
        } while (this.accept(','));
        return list;
    }

    parseExpr(): Expr {
        return this.parseOr();
    }

    private parseOr(): Expr {
        let left = this.parseAnd();
        while (this.at('OR')) {
            this.next();
            left = { kind: 'binary', op: 'or', left, right: this.parseAnd() } satisfies BinaryExpr;
        }
        return left;
    }

    private parseAnd(): Expr {
        let left = this.parseNot();
        while (this.at('AND')) {
            this.next();
            left = { kind: 'binary', op: 'and', left, right: this.parseNot() } satisfies BinaryExpr;
        }
        return left;
    }

    private parseNot(): Expr {
        if (this.at('NOT')) {
            this.next();
            return { kind: 'unary', op: 'not', expr: this.parseNot() } satisfies UnaryExpr;
        }
        return this.parseComparison();
    }

    private parseComparison(): Expr {
        let left = this.parseAdditive();
        while (true) {
            const token = this.peek();
            if (token.kind === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>=', '~', '!~', '~*', '!~*'].includes(token.value)) {
                this.next();
                const op = token.value === '!=' ? '<>' : token.value;
                if (this.at('ANY') || this.at('SOME') || this.at('ALL')) {
                    this.next();
                    this.expect('(');
                    const array = this.parseExpr();
                    this.expect(')');
                    left = { kind: 'any', op, left, array } satisfies AnyExpr;
                    continue;
                }
                left = { kind: 'binary', op, left, right: this.parseAdditive() } satisfies BinaryExpr;
                continue;
            }
            if (this.at('IS')) {
                this.next();
                const negated = this.accept('NOT');
                this.expect('NULL');
                left = { kind: 'isnull', expr: left, negated } satisfies IsNullExpr;
                continue;
            }
            if (this.at('IN') || (this.at('NOT') && this.peek(1).upper === 'IN')) {
                const negated = this.at('NOT');
                if (negated) this.next();
                this.next();
                this.expect('(');
                if (this.at('SELECT') || this.at('VALUES')) {
                    const select = this.parseSelect();
                    this.expect(')');
                    left = { kind: 'in', expr: left, list: [], select, negated } satisfies InExpr;
                    continue;
                }
                const list = this.parseExprList();
                this.expect(')');
                left = { kind: 'in', expr: left, list, select: undefined, negated } satisfies InExpr;
                continue;
            }
            if (this.at('LIKE') || this.at('ILIKE') || (this.at('NOT') && ['LIKE', 'ILIKE'].includes(this.peek(1).upper))) {
                throw new ServerError('0A000', 'feature not supported', 'LIKE is not implemented');
            }
            if (this.at('OPERATOR')) {
                this.next();
                this.expect('(');
                const path: string[] = [];
                while (!this.at(')')) {
                    const token = this.next();
                    if (token.kind === 'eof') throw new ServerError('42601', 'unexpected end of input');
                    if (token.value !== '.') path.push(token.value);
                }
                this.expect(')');
                const op = path[path.length - 1] ?? '~';
                left = { kind: 'binary', op, left, right: this.parseAdditive() } satisfies BinaryExpr;
                continue;
            }
            return left;
        }
    }

    private parseAdditive(): Expr {
        let left = this.parseMultiplicative();
        while (this.peek().kind === 'op' && ['+', '-', '||'].includes(this.peek().value)) {
            const op = this.next().value;
            left = { kind: 'binary', op, left, right: this.parseMultiplicative() } satisfies BinaryExpr;
        }
        return left;
    }

    private parseMultiplicative(): Expr {
        let left = this.parseUnary();
        while (this.peek().kind === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
            const op = this.next().value;
            left = { kind: 'binary', op, left, right: this.parseUnary() } satisfies BinaryExpr;
        }
        return left;
    }

    private parseUnary(): Expr {
        if (this.peek().kind === 'op' && ['-', '+'].includes(this.peek().value)) {
            const op = this.next().value;
            return { kind: 'unary', op, expr: this.parseUnary() } satisfies UnaryExpr;
        }
        return this.parsePostfix();
    }

    private parsePostfix(): Expr {
        let expr = this.parsePrimary();
        while (true) {
            if (this.at('::')) {
                this.next();
                expr = { kind: 'cast', expr, type: this.parseTypeName() } satisfies CastExpr;
                continue;
            }
            if (this.at('COLLATE')) {
                this.next();
                const path = this.parseNamePath();
                expr = { kind: 'collate', expr, collation: path.join('.') } satisfies CollateExpr;
                continue;
            }
            if (this.at('[')) {
                this.next();
                const index = this.parseExpr();
                this.expect(']');
                expr = { kind: 'subscript', expr, index } satisfies SubscriptExpr;
                continue;
            }
            return expr;
        }
    }

    private parseTypeName(): DataType {
        const names: string[] = [];
        names.push(this.identifier());
        while (this.at('.') && this.peek(1).kind === 'ident') {
            this.next();
            names.push(this.identifier());
        }
        if (this.at('VARYING')) {
            this.next();
            names[names.length - 1] = 'character varying';
        }
        if (this.at('WITHOUT') || this.at('WITH')) {
            const withToken = this.next().upper;
            this.expect('TIME');
            this.expect('ZONE');
            names[names.length - 1] = withToken === 'WITH' ? 'timestamp with time zone' : 'timestamp without time zone';
        }
        const modifiers: number[] = [];
        if (this.at('(')) {
            this.next();
            do {
                modifiers.push(Number(this.next().value));
            } while (this.accept(','));
            this.expect(')');
        }
        let isArray = false;
        if (this.at('[')) {
            this.next();
            this.expect(']');
            isArray = true;
        }
        const base = typeFromName(names.slice(-1), modifiers);
        return isArray ? arrayOf(base) : base;
    }

    private parsePrimary(): Expr {
        const token = this.peek();
        if (token.kind === 'number') {
            this.next();
            const integral = /^[0-9]+$/.test(token.value);
            // Decimal literals keep their source spelling so `1.50` prints as
            // `1.50`, matching PostgreSQL's untyped numeric constants.
            return {
                kind: 'literal',
                value: integral ? Number(token.value) : token.value,
                text: token.value,
                numeric: true,
                start: token.start,
            } satisfies LiteralExpr;
        }
        if (token.kind === 'string') {
            this.next();
            return { kind: 'literal', value: token.value, text: token.value, start: token.start } satisfies LiteralExpr;
        }
        if (token.kind === 'param') {
            this.next();
            return { kind: 'param', index: Number(token.value), start: token.start } satisfies ParamExpr;
        }
        if (token.upper === 'NULL') {
            this.next();
            return { kind: 'literal', value: null, text: 'NULL', start: token.start } satisfies LiteralExpr;
        }
        if (token.upper === 'DEFAULT') {
            this.next();
            return { kind: 'default', start: token.start };
        }
        if (token.upper === 'TRUE' || token.upper === 'FALSE') {
            this.next();
            return { kind: 'literal', value: token.upper === 'TRUE', text: token.upper, start: token.start } satisfies LiteralExpr;
        }
        if (token.upper === 'CASE') return this.parseCase();
        if (token.upper === 'CAST') {
            this.next();
            this.expect('(');
            const expr = this.parseExpr();
            this.expect('AS');
            const type = this.parseTypeName();
            this.expect(')');
            return { kind: 'cast', expr, type } satisfies CastExpr;
        }
        if (token.upper === 'EXISTS') {
            this.next();
            this.expect('(');
            const select = this.parseSelect();
            this.expect(')');
            return { kind: 'exists', select } satisfies ExistsExpr;
        }
        if (token.upper === 'ARRAY') {
            this.next();
            if (this.at('[')) {
                this.next();
                const elements = this.at(']') ? [] : this.parseExprList();
                this.expect(']');
                return { kind: 'array', elements, select: undefined } satisfies ArrayExpr;
            }
            this.expect('(');
            const select = this.parseSelect();
            this.expect(')');
            return { kind: 'array', elements: undefined, select } satisfies ArrayExpr;
        }
        if (token.kind === 'punct' && token.value === '(') {
            this.next();
            if (this.at('SELECT') || this.at('VALUES')) {
                const select = this.parseSelect();
                this.expect(')');
                return { kind: 'subquery', select } satisfies SubqueryExpr;
            }
            if (this.at('WITH')) {
                const withClause = this.parseWith();
                if (!this.at('SELECT') && !this.at('VALUES')) {
                    throw new ServerError('0A000', 'feature not supported', 'data-modifying statements in WITH are not implemented');
                }
                const select = this.parseSelect();
                select.with = withClause;
                this.expect(')');
                return { kind: 'subquery', select } satisfies SubqueryExpr;
            }
            const expr = this.parseExpr();
            this.expect(')');
            return expr;
        }
        if (token.kind === 'ident' || token.kind === 'qident') {
            const names = [this.identifier()];
            while (this.at('.')) {
                if (this.peek(1).value === '*') {
                    this.next();
                    this.next();
                    return { kind: 'star', qualifier: names[names.length - 1] } satisfies StarExpr;
                }
                this.next();
                names.push(this.identifier());
            }
            if (this.at('(')) {
                this.next();
                let star = false;
                let distinct = false;
                let args: Expr[] = [];
                if (this.accept('DISTINCT')) distinct = true;
                if (this.at('*')) {
                    this.next();
                    star = true;
                } else if (!this.at(')')) {
                    args = this.parseExprList();
                }
                this.expect(')');
                const name = names[names.length - 1] ?? '';
                const schema = names.length > 1 ? names[names.length - 2] : undefined;
                const call: FunctionExpr = { kind: 'function', schema, name, args, star, start: token.start };
                if (distinct) call.distinct = true;
                if (this.at('OVER')) {
                    this.next();
                    call.over = this.parseWindowSpec();
                }
                return call;
            }
            return {
                kind: 'column',
                qualifier: names.length > 1 ? names[names.length - 2] : undefined,
                name: names[names.length - 1] ?? '',
                start: token.start,
            } satisfies ColumnExpr;
        }
        throw syntax('syntax error', token);
    }

    private parseWindowSpec(): WindowSpec {
        if (!this.at('(')) throw new ServerError('0A000', 'feature not supported', 'named window references are not implemented');
        this.next();
        const partitionBy = this.at('PARTITION') ? (this.next(), this.expect('BY'), this.parseExprList()) : [];
        const orderBy = this.at('ORDER') ? this.parseOrderBy() : [];
        let frame: WindowFrame | undefined;
        if (this.at('ROWS') || this.at('RANGE') || this.at('GROUPS')) frame = this.parseFrame();
        this.expect(')');
        return { partitionBy, orderBy, frame };
    }

    private parseFrame(): WindowFrame {
        const mode = this.next().upper.toLowerCase() as 'rows' | 'range';
        let start: FrameBound;
        let end: FrameBound;
        if (this.at('BETWEEN')) {
            this.next();
            start = this.parseFrameBound();
            this.expect('AND');
            end = this.parseFrameBound();
        }
        else {
            start = this.parseFrameBound();
            end = { type: 'current-row' };
        }
        return { mode, start, end };
    }

    private parseFrameBound(): FrameBound {
        if (this.accept('UNBOUNDED')) {
            return this.accept('PRECEDING') ? { type: 'unbounded-preceding' } : (this.expect('FOLLOWING'), { type: 'unbounded-following' });
        }
        if (this.at('CURRENT')) {
            this.next();
            this.expect('ROW');
            return { type: 'current-row' };
        }
        const offset = this.parseExpr();
        if (this.accept('PRECEDING')) return { type: 'preceding', offset };
        this.expect('FOLLOWING');
        return { type: 'following', offset };
    }

    private parseCase(): Expr {
        this.expect('CASE');
        const operand = this.at('WHEN') ? undefined : this.parseExpr();
        const whens: { when: Expr; then: Expr }[] = [];
        while (this.at('WHEN')) {
            this.next();
            const when = this.parseExpr();
            this.expect('THEN');
            whens.push({ when, then: this.parseExpr() });
        }
        let otherwise: Expr | undefined;
        if (this.at('ELSE')) {
            this.next();
            otherwise = this.parseExpr();
        }
        this.expect('END');
        return { kind: 'case', operand, whens, otherwise } satisfies CaseExpr;
    }

    private parseInsert(): InsertStatement {
        this.expect('INSERT');
        this.expect('INTO');
        const table = this.parseRelationRef();
        let columns: string[] | undefined;
        if (this.at('(')) {
            this.next();
            columns = [];
            do {
                columns.push(this.identifier());
            } while (this.accept(','));
            this.expect(')');
        }
        if (this.at('DEFAULT')) {
            this.next();
            this.expect('VALUES');
            const returning = this.parseReturning();
            return { kind: 'insert', table, columns, rows: [], defaultValues: true, returning };
        }
        this.expect('VALUES');
        const rows: Expr[][] = [];
        do {
            this.expect('(');
            rows.push(this.parseExprList());
            this.expect(')');
        } while (this.accept(','));
        const returning = this.parseReturning();
        return { kind: 'insert', table, columns, rows, defaultValues: false, returning };
    }

    private parseUpdate(): UpdateStatement {
        this.expect('UPDATE');
        const table = this.parseRelationRef();
        this.expect('SET');
        const assignments: { column: string; value: Expr }[] = [];
        do {
            const column = this.identifier();
            if (!this.accept('=')) throw syntax('syntax error: expected "="', this.peek());
            assignments.push({ column, value: this.parseExpr() });
        } while (this.accept(','));
        const where = this.at('WHERE') ? (this.next(), this.parseExpr()) : undefined;
        const returning = this.parseReturning();
        return { kind: 'update', table, assignments, where, returning };
    }

    private parseDelete(): DeleteStatement {
        this.expect('DELETE');
        this.expect('FROM');
        const table = this.parseRelationRef();
        const where = this.at('WHERE') ? (this.next(), this.parseExpr()) : undefined;
        const returning = this.parseReturning();
        return { kind: 'delete', table, where, returning };
    }

    private parseReturning(): Target[] | undefined {
        if (!this.at('RETURNING')) return undefined;
        this.next();
        const targets: Target[] = [];
        do {
            targets.push(this.parseTarget());
        } while (this.accept(','));
        return targets;
    }

    private parseCreate(): Statement {
        this.expect('CREATE');
        if (this.at('UNIQUE') || this.at('INDEX')) return this.parseCreateIndex();
        this.expect('TABLE');
        const ifNotExists = this.at('IF') ? (this.next(), this.expect('NOT'), this.expect('EXISTS'), true) : false;
        const table = this.parseRelationRef();
        this.expect('(');
        const columns: ColumnDef[] = [];
        const constraints: TableConstraint[] = [];
        do {
            let constraintName: string | undefined;
            if (this.at('CONSTRAINT')) {
                this.next();
                constraintName = this.identifier();
            }
            if (this.at('PRIMARY') || this.at('UNIQUE')) {
                const kind = this.next().upper === 'PRIMARY' ? 'primary' : 'unique';
                if (kind === 'primary') this.expect('KEY');
                this.expect('(');
                const names: string[] = [];
                do {
                    names.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
                constraints.push({ kind, name: constraintName, columns: names });
                continue;
            }
            if (this.at('CHECK')) {
                this.next();
                this.expect('(');
                const start = this.peek().start;
                const expr = this.parseExpr();
                const source = this.sourceSince(start);
                this.expect(')');
                constraints.push({ kind: 'check', name: constraintName, expr, source, notValid: this.parseNotValid() });
                continue;
            }
            if (this.at('FOREIGN')) {
                this.next();
                this.expect('KEY');
                this.expect('(');
                const names: string[] = [];
                do {
                    names.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
                this.expect('REFERENCES');
                constraints.push({
                    kind: 'foreign',
                    name: constraintName,
                    columns: names,
                    reference: this.parseReferenceTail(),
                });
                continue;
            }
            if (constraintName !== undefined) throw syntax('syntax error: expected a table constraint', this.peek());
            columns.push(this.parseColumnDef());
        } while (this.accept(','));
        this.expect(')');
        return { kind: 'create-table', table, ifNotExists, columns, constraints };
    }

    private parseCreateIndex(): CreateIndexStatement {
        const unique = this.accept('UNIQUE');
        this.expect('INDEX');
        const ifNotExists = this.at('IF') ? (this.next(), this.expect('NOT'), this.expect('EXISTS'), true) : false;
        const name = this.identifier();
        this.expect('ON');
        const table = this.parseRelationRef();
        let method = 'btree';
        if (this.at('USING')) {
            this.next();
            method = this.identifier();
        }
        this.expect('(');
        const columns: string[] = [];
        do {
            columns.push(this.identifier());
            this.accept('ASC');
            this.accept('DESC');
        } while (this.accept(','));
        this.expect(')');
        let where: Expr | undefined;
        let whereSource: string | undefined;
        if (this.at('WHERE')) {
            this.next();
            const start = this.peek().start;
            where = this.parseExpr();
            whereSource = this.sourceSince(start);
        }
        return { kind: 'create-index', name, table, unique, ifNotExists, method, columns, where, whereSource };
    }

    private parseColumnDef(): ColumnDef {
        const name = this.identifier();
        const serialToken = this.peek().upper;
        const serial: SerialKind | undefined =
            serialToken === 'SERIAL' ? 'normal'
                : serialToken === 'BIGSERIAL' ? 'big'
                    : serialToken === 'SMALLSERIAL' ? 'small'
                        : undefined;
        const type = this.parseTypeName();
        let notNull = false;
        let defaultExpr: Expr | undefined;
        let primaryKey = false;
        let unique = false;
        let check: ColumnCheck | undefined;
        let references: ReferenceClause | undefined;
        while (true) {
            let constraintName: string | undefined;
            if (this.at('CONSTRAINT')) {
                this.next();
                constraintName = this.identifier();
            }
            if (this.at('NOT')) {
                this.next();
                this.expect('NULL');
                notNull = true;
                continue;
            }
            if (this.at('NULL')) {
                this.next();
                continue;
            }
            if (this.at('DEFAULT')) {
                this.next();
                defaultExpr = this.parseExpr();
                continue;
            }
            if (this.at('PRIMARY')) {
                this.next();
                this.expect('KEY');
                primaryKey = true;
                notNull = true;
                continue;
            }
            if (this.at('UNIQUE')) {
                this.next();
                unique = true;
                continue;
            }
            if (this.at('CHECK')) {
                this.next();
                this.expect('(');
                const start = this.peek().start;
                const expr = this.parseExpr();
                check = { name: constraintName, expr, source: this.sourceSince(start) };
                this.expect(')');
                continue;
            }
            if (this.at('REFERENCES')) {
                this.next();
                references = this.parseReferenceTail();
                continue;
            }
            if (constraintName !== undefined) throw syntax('syntax error: expected a column constraint', this.peek());
            return { name, type, notNull, defaultExpr, primaryKey, unique, serial, check, references };
        }
    }

    /** Parses everything after `REFERENCES`: target relation, columns and actions. */
    private parseReferenceTail(): ReferenceClause {
        const table = this.parseRelationRef();
        let columns: string[] | undefined;
        if (this.at('(')) {
            this.next();
            columns = [];
            do {
                columns.push(this.identifier());
            } while (this.accept(','));
            this.expect(')');
        }
        let onDelete: ReferenceClause['onDelete'];
        let onUpdate: ReferenceClause['onUpdate'];
        while (this.at('ON')) {
            this.next();
            if (this.accept('DELETE')) onDelete = this.parseReferenceAction();
            else if (this.accept('UPDATE')) onUpdate = this.parseReferenceAction();
            else throw syntax('syntax error: expected "DELETE" or "UPDATE"', this.peek());
        }
        return { table, columns, onDelete, onUpdate };
    }

    private parseReferenceAction(): 'a' | 'r' | 'c' | 'n' | 'd' {
        if (this.accept('CASCADE')) return 'c';
        if (this.accept('RESTRICT')) return 'r';
        if (this.at('NO')) {
            this.next();
            this.expect('ACTION');
            return 'a';
        }
        this.expect('SET');
        if (this.accept('NULL')) return 'n';
        this.expect('DEFAULT');
        return 'd';
    }

    private parseNotValid(): boolean {
        if (!this.at('NOT')) return false;
        this.next();
        this.expect('VALID');
        return true;
    }

    private parseAlter(): Statement {
        this.expect('ALTER');
        this.expect('TABLE');
        const table = this.parseRelationRef();
        if (this.at('VALIDATE')) {
            this.next();
            this.expect('CONSTRAINT');
            return { kind: 'alter-table', table, action: { kind: 'validate', name: this.identifier() } };
        }
        this.expect('ADD');
        let name: string | undefined;
        if (this.at('CONSTRAINT')) {
            this.next();
            name = this.identifier();
        }
        if (this.at('CHECK')) {
            this.next();
            this.expect('(');
            const start = this.peek().start;
            const expr = this.parseExpr();
            const source = this.sourceSince(start);
            this.expect(')');
            return {
                kind: 'alter-table',
                table,
                action: { kind: 'add-check', name, expr, source, notValid: this.parseNotValid() },
            };
        }
        if (this.at('FOREIGN')) {
            this.next();
            this.expect('KEY');
            this.expect('(');
            const columns: string[] = [];
            do {
                columns.push(this.identifier());
            } while (this.accept(','));
            this.expect(')');
            this.expect('REFERENCES');
            return {
                kind: 'alter-table',
                table,
                action: { kind: 'add-foreign', name, columns, reference: this.parseReferenceTail() },
            };
        }
        throw new ServerError('0A000', 'feature not supported', 'only ADD CHECK, ADD FOREIGN KEY and VALIDATE CONSTRAINT are implemented');
    }

    private parseBegin(): TransactionStatement {
        if (this.at('START')) {
            this.next();
            this.expect('TRANSACTION');
        }
        else {
            this.next();
            this.accept('WORK');
            this.accept('TRANSACTION');
        }
        return { kind: 'transaction', command: 'begin', name: undefined };
    }

    private parseTransaction(command: 'commit'): TransactionStatement {
        this.next();
        this.accept('WORK');
        this.accept('TRANSACTION');
        return { kind: 'transaction', command, name: undefined };
    }

    private parseRollback(): TransactionStatement {
        this.next();
        if (this.at('TO')) {
            this.next();
            this.accept('SAVEPOINT');
            return { kind: 'transaction', command: 'rollback-to', name: this.identifier() };
        }
        this.accept('WORK');
        this.accept('TRANSACTION');
        return { kind: 'transaction', command: 'rollback', name: undefined };
    }

    private parseDrop(): Statement {
        this.expect('DROP');
        if (this.at('INDEX')) {
            this.next();
            const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
            const name = this.identifier();
            const cascade = this.accept('CASCADE');
            this.accept('RESTRICT');
            return { kind: 'drop-index', name, ifExists, cascade };
        }
        this.expect('TABLE');
        const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
        const table = this.parseRelationRef();
        const cascade = this.accept('CASCADE');
        this.accept('RESTRICT');
        return { kind: 'drop-table', table, ifExists, cascade };
    }

    private parseRelationRef(): RelationRef {
        const startToken = this.peek();
        const names = this.parseNamePath();
        const schema = names.length > 1 ? names[names.length - 2] : undefined;
        const name = names[names.length - 1] ?? '';
        return { kind: 'relation', schema, name, alias: undefined, start: startToken.start, args: undefined };
    }
}

/** Parses one statement that the engine can run. */
export function parseStatement(sql: string): Statement {
    const parser = new Parser(sql);
    const statement = parser.parseStatement();
    const trailing = parser.peek();
    if (trailing.kind !== 'eof') throw syntax('syntax error', trailing);
    return statement;
}

/** Parses one expression in isolation, used by the harness and DDL defaults. */
export function parseExpression(sql: string): Expr {
    const parser = new Parser(sql);
    const expr = parser.parseExpr();
    const trailing = parser.peek();
    if (trailing.kind !== 'eof') throw syntax('syntax error', trailing);
    return expr;
}
