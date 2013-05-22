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
    /** `string_agg(x, ',' ORDER BY x)` inside the aggregate call. */
    orderBy?: OrderItem[];
    /** `FILTER (WHERE ...)` applied to the aggregate inputs. */
    filter?: Expr;
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
    /** `NATURAL JOIN`, whose `USING` list is the columns both sides share. */
    natural?: boolean;
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
    /** `OVERRIDING SYSTEM VALUE` or `OVERRIDING USER VALUE`, identity columns only. */
    overriding: 'system' | 'user' | undefined;
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
    /** `confmatchtype`: `s` simple (default), `f` full, `p` partial. */
    match: 's' | 'f' | 'p';
    condeferrable: boolean;
    condeferred: boolean;
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
    /** `GENERATED ALWAYS` or `GENERATED BY DEFAULT` identity column. */
    identity: 'always' | 'default' | undefined;
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
    /** `CREATE TEMP` (`t`) and `CREATE UNLOGGED` (`u`) tables, otherwise `p`. */
    persistence?: 'p' | 't' | 'u';
}

export interface DropTableStatement {
    kind: 'drop-table';
    table: RelationRef;
    ifExists: boolean;
    cascade: boolean;
}

export interface IndexKey {
    /** Column name for a plain key, absent for an expression key. */
    column?: string;
    /** Expression parsed out of `( ... )`, absent for a plain key. */
    expression?: Expr;
    /** `DESC` when true, `ASC` otherwise. */
    desc: boolean;
    /** Effective null placement, defaulting to `NULLS FIRST` for `DESC`. */
    nullsFirst: boolean;
    /** Explicit `NULLS FIRST`/`NULLS LAST` spelling, absent otherwise. */
    nulls?: 'FIRST' | 'LAST';
}

export interface CreateIndexStatement {
    kind: 'create-index';
    name: string;
    table: RelationRef;
    unique: boolean;
    concurrently: boolean;
    ifNotExists: boolean;
    method: string;
    keys: IndexKey[];
    include: string[];
    where: Expr | undefined;
    /** Source spelling of the predicate, rendered by `pg_get_indexdef`. */
    whereSource: string | undefined;
}

export interface DropIndexStatement {
    kind: 'drop-index';
    /** Every name in `DROP INDEX a, b`, each optionally schema-qualified. */
    names: { schema: string | undefined; name: string }[];
    concurrently: boolean;
    ifExists: boolean;
    cascade: boolean;
}

/** `CREATE DATABASE` options this server accepts, executed outside a transaction block. */
export interface CreateDatabaseStatement {
    kind: 'create-database';
    name: string;
    template: string | undefined;
    owner: string | undefined;
    connectionLimit: number | undefined;
    allowConnections: boolean | undefined;
}

/** `DROP DATABASE [IF EXISTS] name`, executed outside a transaction block. */
export interface DropDatabaseStatement {
    kind: 'drop-database';
    name: string;
    ifExists: boolean;
    force: boolean;
}

/** Attributes accepted by `CREATE ROLE` and `ALTER ROLE`. */
export interface RoleOptions {
    rolsuper?: boolean;
    rolinherit?: boolean;
    rolcreaterole?: boolean;
    rolcreatedb?: boolean;
    rolcanlogin?: boolean;
    rolreplication?: boolean;
    rolbypassrls?: boolean;
    rolconnlimit?: number;
}

export interface CreateRoleStatement {
    kind: 'create-role';
    name: string;
    options: RoleOptions;
}

export interface AlterRoleStatement {
    kind: 'alter-role';
    name: string;
    options: RoleOptions;
    rename: string | undefined;
}

export interface DropRoleStatement {
    kind: 'drop-role';
    names: string[];
    ifExists: boolean;
}

export interface GrantStatement {
    kind: 'grant';
    objectType: 'database' | 'schema' | 'table';
    objectName: string;
    privileges: string[];
    /** An empty grantee string is `PUBLIC`. */
    grantees: string[];
    grantOption: boolean;
}

export interface RevokeStatement {
    kind: 'revoke';
    objectType: 'database' | 'schema' | 'table';
    objectName: string;
    privileges: string[];
    grantees: string[];
    grantOptionOnly: boolean;
    cascade: boolean;
}

export type AlterTableAction =
    | { kind: 'add-check'; name: string | undefined; expr: Expr; source: string; notValid: boolean }
    | { kind: 'add-foreign'; name: string | undefined; columns: string[]; reference: ReferenceClause }
    | { kind: 'validate'; name: string }
    | { kind: 'owner'; role: string };

export interface AlterTableStatement {
    kind: 'alter-table';
    table: RelationRef;
    action: AlterTableAction;
}

export interface TransactionStatement {
    kind: 'transaction';
    command: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback-to';
    name: string | undefined;
    /** Isolation level named on `BEGIN`/`START TRANSACTION`, if any. */
    isolation?: string;
    /** `READ ONLY`/`READ WRITE` named on `BEGIN`, if any. */
    readOnly?: boolean;
}

/** Options accepted by `COPY ... FROM STDIN` / `COPY ... TO STDOUT`. */
export interface CopyOptions {
    format: 'text' | 'csv';
    header: boolean;
    delimiter: string | undefined;
    nullString: string | undefined;
    quote: string | undefined;
    escape: string | undefined;
}

export interface CopyStatement {
    kind: 'copy';
    direction: 'from' | 'to';
    /** Set for `COPY table ...`; absent when the source is a query. */
    table: RelationRef | undefined;
    columns: string[] | undefined;
    select: SelectStatement | undefined;
    options: CopyOptions;
}

export type CursorDirection =
    | { kind: 'next' }
    | { kind: 'prior' }
    | { kind: 'forward'; count: number | 'all' }
    | { kind: 'backward'; count: number | 'all' }
    | { kind: 'absolute'; count: number }
    | { kind: 'relative'; count: number };

export interface CursorStatement {
    kind: 'cursor';
    action: 'declare' | 'fetch' | 'move' | 'close';
    /** Empty for `CLOSE ALL`. */
    name: string;
    all: boolean;
    scroll: 'scroll' | 'no-scroll' | undefined;
    hold: boolean;
    /** `DECLARE ... BINARY`, reported by `pg_cursors.is_binary`. */
    binary?: boolean;
    /** Original `DECLARE` text, reported by `pg_cursors.statement`. */
    source?: string;
    direction: CursorDirection | undefined;
    select: SelectStatement | undefined;
}

export interface PrepareStatement {
    kind: 'prepare';
    name: string;
    types: DataType[];
    statement: Statement;
}

export interface ExecuteStatement {
    kind: 'execute';
    name: string;
    args: Expr[];
}

export interface DeallocateStatement {
    kind: 'deallocate';
    name: string | undefined;
    all: boolean;
}

export interface ListenStatement {
    kind: 'listen' | 'unlisten';
    channel: string;
    all: boolean;
}

export interface NotifyStatement {
    kind: 'notify';
    channel: string;
    payload: string | undefined;
}

export interface ExplainStatement {
    kind: 'explain';
    analyze: boolean;
    verbose: boolean;
    statement: Statement;
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
    | CreateDatabaseStatement
    | DropDatabaseStatement
    | CreateRoleStatement
    | AlterRoleStatement
    | DropRoleStatement
    | GrantStatement
    | RevokeStatement
    | AlterTableStatement
    | TransactionStatement
    | CopyStatement
    | CursorStatement
    | PrepareStatement
    | ExecuteStatement
    | ExplainStatement
    | DeallocateStatement
    | ListenStatement
    | NotifyStatement;

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
    'NATURAL',
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
        if (token.upper === 'GRANT') return this.parseGrant();
        if (token.upper === 'REVOKE') return this.parseRevoke();
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
        if (token.upper === 'COPY') return this.parseCopy();
        if (token.upper === 'DECLARE') return this.parseDeclare();
        if (token.upper === 'FETCH' || token.upper === 'MOVE') return this.parseFetchMove(token.upper.toLowerCase() as 'fetch' | 'move');
        if (token.upper === 'CLOSE') return this.parseClose();
        if (token.upper === 'PREPARE') return this.parsePrepare();
        if (token.upper === 'EXECUTE') return this.parseExecute();
        if (token.upper === 'EXPLAIN') return this.parseExplain();
        if (token.upper === 'DEALLOCATE') return this.parseDeallocate();
        if (token.upper === 'LISTEN') return this.parseListen();
        if (token.upper === 'UNLISTEN') return this.parseUnlisten();
        if (token.upper === 'NOTIFY') return this.parseNotify();
        throw new ServerError('0A000', 'feature not supported', `statement is not implemented: ${token.upper || 'end of input'}`);
    }

    private signedInteger(): number {
        let sign = 1;
        if (this.at('-')) {
            this.next();
            sign = -1;
        }
        else if (this.at('+')) this.next();
        const token = this.peek();
        if (token.kind !== 'number' || !/^\d+$/.test(token.value)) throw syntax('syntax error: expected an integer', token);
        this.next();
        return sign * Number(token.value);
    }

    private parseExplain(): ExplainStatement {
        this.expect('EXPLAIN');
        let analyze = false;
        let verbose = false;
        const optionValue = (): boolean => {
            if (this.accept('FALSE') || this.accept('OFF')) return false;
            this.accept('TRUE');
            this.accept('ON');
            return true;
        };
        if (this.accept('(')) {
            for (;;) {
                if (this.accept('ANALYZE') || this.accept('ANALYSE')) {
                    analyze = optionValue();
                }
                else if (this.accept('VERBOSE')) {
                    verbose = optionValue();
                }
                else if (this.accept('FORMAT')) {
                    const format = this.identifier().toLowerCase();
                    if (format !== 'text') {
                        throw new ServerError('0A000', 'feature not supported', `EXPLAIN FORMAT ${format.toUpperCase()} is not implemented`);
                    }
                }
                else throw syntax('syntax error: unsupported EXPLAIN option', this.peek());
                if (!this.accept(',')) break;
            }
            this.expect(')');
        }
        else {
            if (this.accept('ANALYZE') || this.accept('ANALYSE')) analyze = true;
            if (this.accept('VERBOSE')) verbose = true;
        }
        return { kind: 'explain', analyze, verbose, statement: this.parseStatement() };
    }

    private parseCopy(): CopyStatement {
        this.expect('COPY');
        const options: CopyOptions = {
            format: 'text',
            header: false,
            delimiter: undefined,
            nullString: undefined,
            quote: undefined,
            escape: undefined,
        };
        let table: RelationRef | undefined;
        let columns: string[] | undefined;
        let select: SelectStatement | undefined;
        let direction: 'from' | 'to';
        if (this.at('(')) {
            this.next();
            select = this.parseSelect();
            this.expect(')');
            this.expect('TO');
            this.expect('STDOUT');
            direction = 'to';
        }
        else {
            table = this.parseRelationRef();
            if (this.at('(')) {
                this.next();
                columns = [];
                do {
                    columns.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
            }
            if (this.at('FROM')) {
                this.next();
                this.expect('STDIN');
                direction = 'from';
            }
            else if (this.at('TO')) {
                this.next();
                this.expect('STDOUT');
                direction = 'to';
            }
            else throw syntax('syntax error: expected "FROM" or "TO"', this.peek());
        }
        this.parseCopyOptions(options, direction);
        return { kind: 'copy', direction, table, columns, select, options };
    }

    private parseCopyOptions(options: CopyOptions, direction: 'from' | 'to'): void {
        if (this.accept('WITH')) {
            if (this.at('(')) {
                this.next();
                this.parseCopyOptionList(options);
                this.expect(')');
                return;
            }
            this.parseCopyLegacyOptions(options);
            return;
        }
        if (this.at('(')) {
            this.next();
            this.parseCopyOptionList(options);
            this.expect(')');
            return;
        }
        if (['CSV', 'HEADER', 'DELIMITER', 'NULL', 'QUOTE', 'ESCAPE', 'ENCODING', 'FORCE'].some((word) => this.at(word))) {
            this.parseCopyLegacyOptions(options);
        }
    }

    private parseCopyLegacyOptions(options: CopyOptions): void {
        while (!this.at('eof')) {
            if (this.at('BINARY')) throw new ServerError('0A000', 'feature not supported', 'binary COPY is not implemented');
            if (this.accept('CSV')) {
                options.format = 'csv';
                continue;
            }
            if (this.accept('TEXT')) {
                options.format = 'text';
                continue;
            }
            if (this.accept('HEADER')) {
                options.header = this.accept('TRUE') ? true : (this.accept('FALSE') ? false : true);
                continue;
            }
            if (this.accept('DELIMITER')) {
                options.delimiter = this.stringValue();
                continue;
            }
            if (this.accept('NULL')) {
                options.nullString = this.stringValue();
                continue;
            }
            if (this.accept('QUOTE')) {
                options.quote = this.stringValue();
                continue;
            }
            if (this.accept('ESCAPE')) {
                options.escape = this.stringValue();
                continue;
            }
            if (this.accept('ENCODING')) {
                this.stringValue();
                continue;
            }
            if (this.accept('FORCE')) {
                this.expect('QUOTE');
                if (this.at('*') || this.at('(')) this.skipParenthesisedList();
                continue;
            }
            break;
        }
    }

    private parseCopyOptionList(options: CopyOptions): void {
        do {
            const token = this.peek();
            const name = token.upper;
            this.next();
            switch (name) {
                case 'FORMAT': {
                    const format = this.peek().upper;
                    this.next();
                    if (format === 'CSV') options.format = 'csv';
                    else if (format === 'TEXT') options.format = 'text';
                    else if (format === 'BINARY') throw new ServerError('0A000', 'feature not supported', 'binary COPY is not implemented');
                    else throw syntax('syntax error: expected "text" or "csv"', this.peek());
                    break;
                }
                case 'HEADER': {
                    if (this.at(',')) options.header = true;
                    else if (this.accept('TRUE')) options.header = true;
                    else if (this.accept('FALSE')) options.header = false;
                    else if (this.accept('MATCH')) options.header = true;
                    else options.header = true;
                    break;
                }
                case 'DELIMITER':
                    options.delimiter = this.stringValue();
                    break;
                case 'NULL':
                    options.nullString = this.stringValue();
                    break;
                case 'QUOTE':
                    options.quote = this.stringValue();
                    break;
                case 'ESCAPE':
                    options.escape = this.stringValue();
                    break;
                case 'ENCODING':
                    this.stringValue();
                    break;
                case 'FORCE_QUOTE':
                case 'FORCE_NOT_NULL':
                case 'FORCE_NULL':
                    this.skipParenthesisedList();
                    break;
                default:
                    throw new ServerError('42601', `option "${name.toLowerCase()}" not recognized`, undefined, token.start);
            }
        } while (this.accept(','));
    }

    private skipParenthesisedList(): void {
        if (this.accept('*')) return;
        if (!this.at('(')) return;
        let depth = 0;
        do {
            if (this.at('(')) depth += 1;
            if (this.at(')')) depth -= 1;
            this.next();
        } while (!this.at('eof') && depth > 0);
    }

    private stringValue(): string {
        const token = this.peek();
        if (token.kind !== 'string') throw syntax('syntax error: expected a string constant', token);
        this.next();
        return token.value;
    }

    private parseDeclare(): CursorStatement {
        const start = this.peek().start;
        this.expect('DECLARE');
        const name = this.identifier();
        let scroll: 'scroll' | 'no-scroll' | undefined;
        let hold = false;
        let binary = false;
        for (;;) {
            if (this.accept('BINARY')) {
                binary = true;
                continue;
            }
            if (this.accept('INSENSITIVE')) continue;
            if (this.accept('SCROLL')) {
                scroll = 'scroll';
                continue;
            }
            if (this.at('NO') && this.peek(1).upper === 'SCROLL') {
                this.next();
                this.next();
                scroll = 'no-scroll';
                continue;
            }
            break;
        }
        this.expect('CURSOR');
        if (this.at('WITH') && this.peek(1).upper === 'HOLD') {
            this.next();
            this.next();
            hold = true;
        }
        else if (this.at('WITHOUT') && this.peek(1).upper === 'HOLD') {
            this.next();
            this.next();
        }
        this.expect('FOR');
        const select = this.parseSelect();
        return {
            kind: 'cursor',
            action: 'declare',
            name,
            all: false,
            scroll,
            hold,
            binary,
            source: this.sourceSince(start),
            direction: undefined,
            select,
        };
    }

    private parseFetchMove(action: 'fetch' | 'move'): CursorStatement {
        this.next();
        const token = this.peek();
        let direction: CursorDirection = { kind: 'forward', count: 1 };
        switch (token.upper) {
            case 'NEXT':
                this.next();
                direction = { kind: 'next' };
                break;
            case 'PRIOR':
                this.next();
                direction = { kind: 'prior' };
                break;
            case 'FIRST':
                this.next();
                direction = { kind: 'absolute', count: 1 };
                break;
            case 'LAST':
                this.next();
                direction = { kind: 'absolute', count: -1 };
                break;
            case 'ABSOLUTE':
                this.next();
                direction = { kind: 'absolute', count: this.signedInteger() };
                break;
            case 'RELATIVE':
                this.next();
                direction = { kind: 'relative', count: this.signedInteger() };
                break;
            case 'ALL':
                this.next();
                direction = { kind: 'forward', count: 'all' };
                break;
            case 'FORWARD':
            case 'BACKWARD': {
                this.next();
                const forward = token.upper === 'FORWARD';
                let count: number | 'all' = 1;
                if (this.accept('ALL')) count = 'all';
                else if (this.peek().kind === 'number' || this.at('-') || this.at('+')) count = this.signedInteger();
                direction = forward ? { kind: 'forward', count } : { kind: 'backward', count };
                break;
            }
            default:
                if (token.kind === 'number' || this.at('-') || this.at('+')) {
                    direction = { kind: 'forward', count: this.signedInteger() };
                }
        }
        this.accept('FROM');
        this.accept('IN');
        const name = this.identifier();
        return { kind: 'cursor', action, name, all: false, scroll: undefined, hold: false, direction, select: undefined };
    }

    private parseClose(): CursorStatement {
        this.expect('CLOSE');
        if (this.accept('ALL')) {
            return { kind: 'cursor', action: 'close', name: '', all: true, scroll: undefined, hold: false, direction: undefined, select: undefined };
        }
        return {
            kind: 'cursor',
            action: 'close',
            name: this.identifier(),
            all: false,
            scroll: undefined,
            hold: false,
            direction: undefined,
            select: undefined,
        };
    }

    private parsePrepare(): PrepareStatement {
        this.expect('PREPARE');
        const name = this.identifier();
        const types: DataType[] = [];
        if (this.accept('(')) {
            if (!this.at(')')) {
                do {
                    types.push(this.parseTypeName());
                } while (this.accept(','));
            }
            this.expect(')');
        }
        this.expect('AS');
        const statement = this.parseStatement();
        return { kind: 'prepare', name, types, statement };
    }

    private parseExecute(): ExecuteStatement {
        this.expect('EXECUTE');
        const name = this.identifier();
        const args: Expr[] = [];
        if (this.accept('(')) {
            if (!this.at(')')) args.push(...this.parseExprList());
            this.expect(')');
        }
        return { kind: 'execute', name, args };
    }

    private parseDeallocate(): DeallocateStatement {
        this.expect('DEALLOCATE');
        this.accept('PREPARE');
        if (this.accept('ALL')) return { kind: 'deallocate', name: undefined, all: true };
        return { kind: 'deallocate', name: this.identifier(), all: false };
    }

    private parseListen(): Statement {
        this.expect('LISTEN');
        return { kind: 'listen', channel: this.identifier(), all: false };
    }

    private parseUnlisten(): Statement {
        this.expect('UNLISTEN');
        if (this.accept('*')) return { kind: 'unlisten', channel: '', all: true };
        return { kind: 'unlisten', channel: this.identifier(), all: false };
    }

    private parseNotify(): NotifyStatement {
        this.expect('NOTIFY');
        const channel = this.identifier();
        let payload: string | undefined;
        if (this.accept(',')) payload = this.stringValue();
        return { kind: 'notify', channel, payload };
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
        // PostgreSQL 允许 `LIMIT` 与 `OFFSET` 任意先后，两种顺序都要接受。
        while (this.at('OFFSET') || this.at('LIMIT')) {
            if (this.accept('OFFSET')) {
                offset = this.parseExpr();
                this.accept('ROW');
                this.accept('ROWS');
            }
            else {
                this.next();
                limit = this.accept('ALL') ? undefined : this.parseExpr();
            }
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
            let natural = false;
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
            else if (this.at('NATURAL')) {
                this.next();
                natural = true;
                if (this.at('INNER')) {
                    this.next();
                    joinType = 'inner';
                }
                else if (this.at('LEFT') || this.at('RIGHT') || this.at('FULL')) {
                    const keyword = this.next().upper;
                    this.accept('OUTER');
                    joinType = keyword === 'LEFT' ? 'left' : keyword === 'RIGHT' ? 'right' : 'full';
                }
                else joinType = 'inner';
                this.expect('JOIN');
            }
            else if (this.at('LEFT') || this.at('RIGHT') || this.at('FULL')) {
                const keyword = this.next().upper;
                this.accept('OUTER');
                this.expect('JOIN');
                joinType = keyword === 'LEFT' ? 'left' : keyword === 'RIGHT' ? 'right' : 'full';
            }
            if (joinType === undefined) return left;
            const right = this.parseFromPrimary();
            if (natural) {
                // PostgreSQL rejects `NATURAL ... ON`/`USING`: the column list is implied.
                if (this.at('ON') || this.at('USING')) throw syntax('syntax error', this.peek());
                left = { kind: 'join', left, right, joinType, on: undefined, natural: true };
                continue;
            }
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
            if (this.at('BETWEEN') || (this.at('NOT') && this.peek(1).upper === 'BETWEEN')) {
                const negated = this.at('NOT');
                if (negated) this.next();
                this.next();
                // 边界按 PostgreSQL 的 `b_expr` 层解析，避免把尾随的 `AND` 吞进上界。
                const low = this.parseAdditive();
                this.expect('AND');
                const high = this.parseAdditive();
                // PostgreSQL 把 BETWEEN 展开成两个范围比较而不是对整体取反：
                // `a BETWEEN x AND y` 即 `a >= x AND a <= y`，
                // `a NOT BETWEEN x AND y` 即 `a < x OR a > y`，NULL 结果因此不同。
                const lower: BinaryExpr = { kind: 'binary', op: negated ? '<' : '>=', left, right: low };
                const upper: BinaryExpr = { kind: 'binary', op: negated ? '>' : '<=', left, right: high };
                left = { kind: 'binary', op: negated ? 'or' : 'and', left: lower, right: upper } satisfies BinaryExpr;
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
                let orderBy: OrderItem[] = [];
                if (this.accept('DISTINCT')) distinct = true;
                if (this.at('*')) {
                    this.next();
                    star = true;
                } else if (!this.at(')')) {
                    args = this.parseExprList();
                    if (this.at('ORDER')) orderBy = this.parseOrderBy();
                }
                this.expect(')');
                const name = names[names.length - 1] ?? '';
                const schema = names.length > 1 ? names[names.length - 2] : undefined;
                const call: FunctionExpr = { kind: 'function', schema, name, args, star, start: token.start };
                if (distinct) call.distinct = true;
                if (orderBy.length > 0) call.orderBy = orderBy;
                if (this.at('FILTER')) {
                    this.next();
                    this.expect('(');
                    this.expect('WHERE');
                    call.filter = this.parseExpr();
                    this.expect(')');
                }
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
        let overriding: InsertStatement['overriding'];
        if (this.accept('OVERRIDING')) {
            if (this.accept('SYSTEM')) overriding = 'system';
            else {
                this.expect('USER');
                overriding = 'user';
            }
            this.expect('VALUE');
        }
        if (this.at('DEFAULT')) {
            this.next();
            this.expect('VALUES');
            const returning = this.parseReturning();
            return { kind: 'insert', table, columns, rows: [], defaultValues: true, overriding, returning };
        }
        this.expect('VALUES');
        const rows: Expr[][] = [];
        do {
            this.expect('(');
            rows.push(this.parseExprList());
            this.expect(')');
        } while (this.accept(','));
        const returning = this.parseReturning();
        return { kind: 'insert', table, columns, rows, defaultValues: false, overriding, returning };
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
        if (this.at('DATABASE')) return this.parseCreateDatabase();
        if (this.at('ROLE')) return this.parseCreateRole();
        if (this.at('UNIQUE') || this.at('INDEX')) return this.parseCreateIndex();
        let persistence: 'p' | 't' | 'u' = 'p';
        if (this.at('TEMP') || this.at('TEMPORARY')) {
            this.next();
            persistence = 't';
        }
        else if (this.at('UNLOGGED')) {
            this.next();
            persistence = 'u';
        }
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
        return { kind: 'create-table', table, ifNotExists, columns, constraints, persistence };
    }

    private parseCreateDatabase(): CreateDatabaseStatement {
        this.expect('DATABASE');
        const name = this.identifier();
        this.accept('WITH');
        let template: string | undefined;
        let owner: string | undefined;
        let connectionLimit: number | undefined;
        let allowConnections: boolean | undefined;
        for (;;) {
            if (this.at('TEMPLATE')) {
                this.next();
                this.accept('=');
                template = this.identifier();
                continue;
            }
            if (this.at('OWNER')) {
                this.next();
                this.accept('=');
                owner = this.identifier();
                continue;
            }
            if (this.at('ALLOW_CONNECTIONS')) {
                this.next();
                this.accept('=');
                allowConnections = this.booleanOption('allow_connections');
                continue;
            }
            if (this.at('CONNECTION')) {
                this.next();
                this.expect('LIMIT');
                this.accept('=');
                connectionLimit = this.integerOption('connection_limit');
                continue;
            }
            break;
        }
        return { kind: 'create-database', name, template, owner, connectionLimit, allowConnections };
    }

    /** Boolean option value, rejected with PostgreSQL's `defGetBoolean` wording. */
    private booleanOption(option: string): boolean {
        const token = this.peek();
        if (token.upper === 'TRUE' || token.upper === 'ON' || token.value === '1') {
            this.next();
            return true;
        }
        if (token.upper === 'FALSE' || token.upper === 'OFF' || token.value === '0') {
            this.next();
            return false;
        }
        throw new ServerError('42601', `${option} requires a Boolean value`, undefined, token.start);
    }

    /** Signed integer option value, rejected with PostgreSQL's `defGetInt32` wording. */
    private integerOption(option: string): number {
        let sign = 1;
        if (this.accept('-')) sign = -1;
        else this.accept('+');
        const token = this.peek();
        if (token.kind !== 'number' || !/^\d+$/.test(token.value)) {
            throw new ServerError('42601', `${option} requires an integer value`, undefined, token.start);
        }
        this.next();
        return sign * Number(token.value);
    }

    private parseCreateIndex(): CreateIndexStatement {
        const unique = this.accept('UNIQUE');
        this.expect('INDEX');
        const concurrently = this.accept('CONCURRENTLY');
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
        const keys: IndexKey[] = [];
        do {
            let key: IndexKey;
            if (this.at('(')) {
                this.next();
                const expression = this.parseExpr();
                this.expect(')');
                key = expression.kind === 'column'
                    ? { column: (expression as ColumnExpr).name, desc: false, nullsFirst: false }
                    : { expression, desc: false, nullsFirst: false };
            }
            else if (this.peek(1).value === '(') {
                key = { expression: this.parseExpr(), desc: false, nullsFirst: false };
            }
            else {
                key = { column: this.identifier(), desc: false, nullsFirst: false };
            }
            if (this.accept('DESC')) key.desc = true;
            else this.accept('ASC');
            if (this.at('NULLS')) {
                this.next();
                key.nullsFirst = this.accept('FIRST');
                key.nulls = key.nullsFirst ? 'FIRST' : 'LAST';
                if (!key.nullsFirst) this.expect('LAST');
            }
            else {
                key.nullsFirst = key.desc;
            }
            keys.push(key);
        } while (this.accept(','));
        this.expect(')');
        const include: string[] = [];
        if (this.accept('INCLUDE')) {
            this.expect('(');
            do {
                include.push(this.identifier());
            } while (this.accept(','));
            this.expect(')');
        }
        let where: Expr | undefined;
        let whereSource: string | undefined;
        if (this.at('WHERE')) {
            this.next();
            const start = this.peek().start;
            where = this.parseExpr();
            whereSource = this.sourceSince(start);
        }
        return { kind: 'create-index', name, table, unique, concurrently, ifNotExists, method, keys, include, where, whereSource };
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
        let identity: ColumnDef['identity'];
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
            if (this.at('GENERATED')) {
                this.next();
                if (this.accept('ALWAYS')) identity = 'always';
                else {
                    this.expect('BY');
                    this.expect('DEFAULT');
                    identity = 'default';
                }
                this.expect('AS');
                this.expect('IDENTITY');
                notNull = true;
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
            return { name, type, notNull, defaultExpr, primaryKey, unique, serial, identity, check, references };
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
        let match: ReferenceClause['match'] = 's';
        if (this.at('MATCH')) {
            this.next();
            if (this.accept('FULL')) match = 'f';
            else if (this.accept('SIMPLE')) match = 's';
            else {
                this.expect('PARTIAL');
                throw new ServerError('0A000', 'MATCH PARTIAL not yet implemented');
            }
        }
        let onDelete: ReferenceClause['onDelete'];
        let onUpdate: ReferenceClause['onUpdate'];
        while (this.at('ON')) {
            this.next();
            if (this.accept('DELETE')) onDelete = this.parseReferenceAction();
            else if (this.accept('UPDATE')) onUpdate = this.parseReferenceAction();
            else throw syntax('syntax error: expected "DELETE" or "UPDATE"', this.peek());
        }
        let condeferrable = false;
        let condeferred = false;
        if (this.at('NOT') && this.peek(1).upper === 'DEFERRABLE') {
            this.next();
            this.expect('DEFERRABLE');
        }
        else if (this.accept('DEFERRABLE')) {
            condeferrable = true;
            if (this.accept('INITIALLY')) {
                if (this.accept('DEFERRED')) condeferred = true;
                else this.expect('IMMEDIATE');
            }
        }
        return { table, columns, onDelete, onUpdate, match, condeferrable, condeferred };
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
        if (this.at('ROLE')) return this.parseAlterRole();
        this.expect('TABLE');
        const table = this.parseRelationRef();
        if (this.at('OWNER')) {
            this.next();
            this.expect('TO');
            return { kind: 'alter-table', table, action: { kind: 'owner', role: this.identifier() } };
        }
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
        return { kind: 'transaction', command: 'begin', name: undefined, ...this.parseTransactionOptions() };
    }

    /** Parses the `ISOLATION LEVEL`/`READ ONLY` options shared by `BEGIN` and `SET TRANSACTION`. */
    private parseTransactionOptions(): { isolation?: string; readOnly?: boolean } {
        const options: { isolation?: string; readOnly?: boolean } = {};
        for (;;) {
            if (this.at('ISOLATION')) {
                this.next();
                this.expect('LEVEL');
                if (this.accept('READ')) {
                    if (this.accept('UNCOMMITTED')) options.isolation = 'read uncommitted';
                    else {
                        this.expect('COMMITTED');
                        options.isolation = 'read committed';
                    }
                }
                else if (this.accept('REPEATABLE')) {
                    this.expect('READ');
                    options.isolation = 'repeatable read';
                }
                else {
                    this.expect('SERIALIZABLE');
                    options.isolation = 'serializable';
                }
                continue;
            }
            if (this.at('READ')) {
                this.next();
                if (this.accept('ONLY')) options.readOnly = true;
                else {
                    this.expect('WRITE');
                    options.readOnly = false;
                }
                continue;
            }
            // `[NOT] DEFERRABLE` only matters to serializable transactions that
            // wait instead of failing, but PostgreSQL accepts it on every level.
            if (this.accept('DEFERRABLE') || (this.accept('NOT') && (this.expect('DEFERRABLE'), true))) continue;
            return options;
        }
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
        if (this.at('DATABASE')) return this.parseDropDatabase();
        if (this.at('ROLE')) return this.parseDropRole();
        if (this.at('INDEX')) {
            this.next();
            const concurrently = this.accept('CONCURRENTLY');
            const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
            const names: { schema: string | undefined; name: string }[] = [];
            do {
                let schema: string | undefined;
                let name = this.identifier();
                if (this.at('.')) {
                    this.next();
                    schema = name;
                    name = this.identifier();
                }
                names.push({ schema, name });
            } while (this.accept(','));
            const cascade = this.accept('CASCADE');
            this.accept('RESTRICT');
            return { kind: 'drop-index', names, concurrently, ifExists, cascade };
        }
        this.expect('TABLE');
        const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
        const table = this.parseRelationRef();
        const cascade = this.accept('CASCADE');
        this.accept('RESTRICT');
        return { kind: 'drop-table', table, ifExists, cascade };
    }

    private parseDropDatabase(): DropDatabaseStatement {
        this.expect('DATABASE');
        const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
        const name = this.identifier();
        let force = false;
        if (this.accept('WITH')) {
            this.expect('(');
            if (this.at('FORCE')) {
                this.next();
                force = true;
            }
            this.expect(')');
        }
        return { kind: 'drop-database', name, ifExists, force };
    }

    private parseCreateRole(): CreateRoleStatement {
        this.expect('ROLE');
        const name = this.identifier();
        return { kind: 'create-role', name, options: this.parseRoleOptions() };
    }

    private parseAlterRole(): AlterRoleStatement {
        this.expect('ROLE');
        const name = this.identifier();
        if (this.at('RENAME')) {
            this.next();
            this.expect('TO');
            return { kind: 'alter-role', name, options: {}, rename: this.identifier() };
        }
        return { kind: 'alter-role', name, options: this.parseRoleOptions(), rename: undefined };
    }

    private parseDropRole(): DropRoleStatement {
        this.expect('ROLE');
        const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
        const names: string[] = [];
        do {
            names.push(this.identifier());
        } while (this.accept(','));
        return { kind: 'drop-role', names, ifExists };
    }

    /** Parses the attribute list shared by `CREATE ROLE` and `ALTER ROLE`. */
    private parseRoleOptions(): RoleOptions {
        const options: RoleOptions = {};
        for (;;) {
            if (this.accept('WITH')) continue;
            if (this.at('SUPERUSER')) {
                this.next();
                options.rolsuper = true;
                continue;
            }
            if (this.at('NOSUPERUSER')) {
                this.next();
                options.rolsuper = false;
                continue;
            }
            if (this.at('LOGIN')) {
                this.next();
                options.rolcanlogin = true;
                continue;
            }
            if (this.at('NOLOGIN')) {
                this.next();
                options.rolcanlogin = false;
                continue;
            }
            if (this.at('INHERIT')) {
                this.next();
                options.rolinherit = true;
                continue;
            }
            if (this.at('NOINHERIT')) {
                this.next();
                options.rolinherit = false;
                continue;
            }
            if (this.at('CREATEDB')) {
                this.next();
                options.rolcreatedb = true;
                continue;
            }
            if (this.at('NOCREATEDB')) {
                this.next();
                options.rolcreatedb = false;
                continue;
            }
            if (this.at('CREATEROLE')) {
                this.next();
                options.rolcreaterole = true;
                continue;
            }
            if (this.at('NOCREATEROLE')) {
                this.next();
                options.rolcreaterole = false;
                continue;
            }
            if (this.at('REPLICATION')) {
                this.next();
                options.rolreplication = true;
                continue;
            }
            if (this.at('NOREPLICATION')) {
                this.next();
                options.rolreplication = false;
                continue;
            }
            if (this.at('BYPASSRLS')) {
                this.next();
                options.rolbypassrls = true;
                continue;
            }
            if (this.at('NOBYPASSRLS')) {
                this.next();
                options.rolbypassrls = false;
                continue;
            }
            if (this.at('CONNECTION')) {
                this.next();
                this.expect('LIMIT');
                options.rolconnlimit = this.signedInteger();
                continue;
            }
            // Passwords and validity dates are accepted but not stored; this
            // server authenticates with a single configured password.
            if (this.at('PASSWORD') || this.at('VALID')) {
                this.next();
                if (this.peek().upper === 'UNTIL') this.next();
                this.next();
                continue;
            }
            break;
        }
        return options;
    }

    private parseGrant(): GrantStatement {
        this.expect('GRANT');
        const privileges: string[] = [];
        do {
            privileges.push(this.identifier());
        } while (this.accept(','));
        this.expect('ON');
        let objectType: 'database' | 'schema' | 'table' = 'table';
        if (this.at('DATABASE')) {
            this.next();
            objectType = 'database';
        }
        else if (this.at('SCHEMA')) {
            this.next();
            objectType = 'schema';
        }
        else {
            this.accept('TABLE');
        }
        const objectName = this.identifier();
        this.expect('TO');
        const grantees = this.parseGrantees();
        let grantOption = false;
        if (this.accept('WITH')) {
            this.expect('GRANT');
            this.expect('OPTION');
            grantOption = true;
        }
        return { kind: 'grant', objectType, objectName, privileges, grantees, grantOption };
    }

    private parseRevoke(): RevokeStatement {
        this.expect('REVOKE');
        let grantOptionOnly = false;
        if (this.at('GRANT')) {
            this.next();
            this.expect('OPTION');
            this.expect('FOR');
            grantOptionOnly = true;
        }
        const privileges: string[] = [];
        do {
            privileges.push(this.identifier());
        } while (this.accept(','));
        this.expect('ON');
        let objectType: 'database' | 'schema' | 'table' = 'table';
        if (this.at('DATABASE')) {
            this.next();
            objectType = 'database';
        }
        else if (this.at('SCHEMA')) {
            this.next();
            objectType = 'schema';
        }
        else {
            this.accept('TABLE');
        }
        const objectName = this.identifier();
        this.expect('FROM');
        const grantees = this.parseGrantees();
        const cascade = this.accept('CASCADE');
        if (!cascade) this.accept('RESTRICT');
        return { kind: 'revoke', objectType, objectName, privileges, grantees, grantOptionOnly, cascade };
    }

    private parseGrantees(): string[] {
        const grantees: string[] = [];
        do {
            if (this.at('PUBLIC')) {
                this.next();
                grantees.push('');
                continue;
            }
            grantees.push(this.identifier());
        } while (this.accept(','));
        return grantees;
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

/** Folds a constant expression, as allowed in an `EXECUTE` argument list. */
export function constantValue(expr: Expr): SqlValue {
    switch (expr.kind) {
        case 'literal':
            return expr.value;
        case 'unary': {
            const value = constantValue(expr.expr);
            if (typeof value === 'number') {
                if (expr.op === '-') return -value;
                if (expr.op === '+') return value;
            }
            break;
        }
        case 'cast':
            return constantValue(expr.expr);
        default:
            break;
    }
    throw new ServerError('42601', 'EXECUTE parameters must be constants');
}
