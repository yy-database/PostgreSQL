/** Lexer, AST and recursive-descent parser for the SQL subset the server runs. */

import { ServerError } from '../errors.ts';
import { arrayOf, type DataType, type SqlValue, typeFromName } from './types.ts';

export interface ExprBase {
    kind: string;
}

export interface LiteralExpr extends ExprBase {
    kind: 'literal';
    value: SqlValue;
    /** Source spelling, used for `NULL`, booleans and untyped numerics. */
    text: string;
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

export interface FunctionExpr extends ExprBase {
    kind: 'function';
    schema: string | undefined;
    name: string;
    args: Expr[];
    star: boolean;
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
}

export interface SubqueryRef {
    kind: 'subquery';
    select: SelectStatement;
    alias: string | undefined;
}

export interface JoinRef {
    kind: 'join';
    left: FromItem;
    right: FromItem;
    joinType: 'inner' | 'left' | 'cross';
    on: Expr | undefined;
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
}

export interface SelectStatement {
    kind: 'select';
    core: SelectCore;
    unions: { all: boolean; op: 'union' | 'intersect' | 'except'; core: SelectCore }[];
    orderBy: OrderItem[];
    limit: Expr | undefined;
    offset: Expr | undefined;
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

export interface ColumnDef {
    name: string;
    type: DataType;
    notNull: boolean;
    defaultExpr: Expr | undefined;
    primaryKey: boolean;
    unique: boolean;
}

export interface TableConstraint {
    kind: 'primary' | 'unique';
    columns: string[];
}

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
}

export type Statement =
    | SelectStatement
    | InsertStatement
    | UpdateStatement
    | DeleteStatement
    | CreateTableStatement
    | DropTableStatement;

type TokenKind = 'ident' | 'qident' | 'number' | 'string' | 'param' | 'op' | 'punct' | 'eof';

interface Token {
    kind: TokenKind;
    value: string;
    upper: string;
    start: number;
}

const MULTI_OPERATORS = ['!~*', '::', '<>', '<=', '>=', '!=', '!~', '||', '~*'];

const RESERVED = new Set([
    'ALL',
    'AND',
    'ANY',
    'AS',
    'ASC',
    'BETWEEN',
    'BY',
    'CASE',
    'CAST',
    'CHECK',
    'COLLATE',
    'CONSTRAINT',
    'CREATE',
    'CROSS',
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
    'FROM',
    'FULL',
    'GROUP',
    'HAVING',
    'IF',
    'ILIKE',
    'IN',
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
    'PRIMARY',
    'REFERENCES',
    'RETURNING',
    'RIGHT',
    'SELECT',
    'SET',
    'SOME',
    'TABLE',
    'THEN',
    'TRUE',
    'UNION',
    'UNIQUE',
    'UPDATE',
    'USING',
    'VALUES',
    'WHEN',
    'WHERE',
]);

function syntax(message: string, token: Token): ServerError {
    return new ServerError('42601', message, `near "${token.kind === 'eof' ? 'end of input' : token.value}"`);
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
}

class Parser {
    private readonly tokens: Token[];
    private index = 0;

    constructor(sql: string) {
        this.tokens = new Lexer(sql).tokens();
    }

    parseStatement(): Statement {
        const token = this.peek();
        if (token.upper === 'SELECT') return this.parseSelect();
        if (token.upper === 'WITH') throw new ServerError('0A000', 'feature not supported', 'common table expressions are not implemented');
        if (token.upper === 'INSERT') return this.parseInsert();
        if (token.upper === 'UPDATE') return this.parseUpdate();
        if (token.upper === 'DELETE') return this.parseDelete();
        if (token.upper === 'CREATE') return this.parseCreate();
        if (token.upper === 'DROP') return this.parseDrop();
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
        return { kind: 'select', targets, from, where, groupBy, having, distinct };
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
            if (this.at('JOIN')) {
                this.next();
                const right = this.parseFromPrimary();
                const on = this.at('ON') ? (this.next(), this.parseExpr()) : undefined;
                left = { kind: 'join', left, right, joinType: 'inner', on };
                continue;
            }
            if (this.at('INNER')) {
                this.next();
                this.expect('JOIN');
                const right = this.parseFromPrimary();
                const on = this.at('ON') ? (this.next(), this.parseExpr()) : undefined;
                left = { kind: 'join', left, right, joinType: 'inner', on };
                continue;
            }
            if (this.at('CROSS')) {
                this.next();
                this.expect('JOIN');
                left = { kind: 'join', left, right: this.parseFromPrimary(), joinType: 'cross', on: undefined };
                continue;
            }
            if (this.at('LEFT')) {
                this.next();
                this.accept('OUTER');
                this.expect('JOIN');
                const right = this.parseFromPrimary();
                const on = this.at('ON') ? (this.next(), this.parseExpr()) : undefined;
                left = { kind: 'join', left, right, joinType: 'left', on };
                continue;
            }
            if (this.at('RIGHT') || this.at('FULL')) throw new ServerError('0A000', 'feature not supported', 'right and full joins are not implemented');
            return left;
        }
    }

    private parseFromPrimary(): FromItem {
        if (this.at('(')) {
            this.next();
            if (this.at('SELECT')) {
                const select = this.parseSelect();
                this.expect(')');
                const alias = this.parseAlias();
                return { kind: 'subquery', select, alias };
            }
            const nested = this.parseFrom()[0];
            this.expect(')');
            if (!nested) throw syntax('syntax error: empty join item', this.peek());
            return nested;
        }
        const names = this.parseNamePath();
        if (this.at('(')) {
            // A set-returning function in FROM: parsed, but only executed when
            // the surrounding subquery itself runs.
            this.next();
            if (!this.at(')')) this.parseExprList();
            this.expect(')');
            const alias = this.parseAlias();
            const schema = names.length > 1 ? names[names.length - 2] : undefined;
            return { kind: 'relation', schema, name: names[names.length - 1] ?? '', alias };
        }
        const alias = this.parseAlias();
        const schema = names.length > 1 ? names[names.length - 2] : undefined;
        const name = names[names.length - 1] ?? '';
        return { kind: 'relation', schema, name, alias };
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
                const list = this.parseExprList();
                this.expect(')');
                left = { kind: 'in', expr: left, list, negated } satisfies InExpr;
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
            return { kind: 'literal', value: Number(token.value), text: token.value } satisfies LiteralExpr;
        }
        if (token.kind === 'string') {
            this.next();
            return { kind: 'literal', value: token.value, text: token.value } satisfies LiteralExpr;
        }
        if (token.kind === 'param') {
            this.next();
            return { kind: 'param', index: Number(token.value) } satisfies ParamExpr;
        }
        if (token.upper === 'NULL') {
            this.next();
            return { kind: 'literal', value: null, text: 'NULL' } satisfies LiteralExpr;
        }
        if (token.upper === 'DEFAULT') {
            this.next();
            return { kind: 'default' };
        }
        if (token.upper === 'TRUE' || token.upper === 'FALSE') {
            this.next();
            return { kind: 'literal', value: token.upper === 'TRUE', text: token.upper } satisfies LiteralExpr;
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
            if (this.at('SELECT')) {
                const select = this.parseSelect();
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
                let args: Expr[] = [];
                if (this.at('*')) {
                    this.next();
                    star = true;
                } else if (!this.at(')')) {
                    args = this.parseExprList();
                }
                this.expect(')');
                const name = names[names.length - 1] ?? '';
                const schema = names.length > 1 ? names[names.length - 2] : undefined;
                return { kind: 'function', schema, name, args, star } satisfies FunctionExpr;
            }
            return {
                kind: 'column',
                qualifier: names.length > 1 ? names[names.length - 2] : undefined,
                name: names[names.length - 1] ?? '',
            } satisfies ColumnExpr;
        }
        throw syntax('syntax error', token);
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
        this.expect('TABLE');
        const ifNotExists = this.at('IF') ? (this.next(), this.expect('NOT'), this.expect('EXISTS'), true) : false;
        const table = this.parseRelationRef();
        this.expect('(');
        const columns: ColumnDef[] = [];
        const constraints: TableConstraint[] = [];
        do {
            if (this.at('PRIMARY') || this.at('UNIQUE')) {
                const kind = this.next().upper === 'PRIMARY' ? 'primary' : 'unique';
                if (kind === 'primary') this.expect('KEY');
                this.expect('(');
                const names: string[] = [];
                do {
                    names.push(this.identifier());
                } while (this.accept(','));
                this.expect(')');
                constraints.push({ kind, columns: names });
                continue;
            }
            const column = this.parseColumnDef();
            columns.push(column);
        } while (this.accept(','));
        this.expect(')');
        return { kind: 'create-table', table, ifNotExists, columns, constraints };
    }

    private parseColumnDef(): ColumnDef {
        const name = this.identifier();
        const type = this.parseTypeName();
        let notNull = false;
        let defaultExpr: Expr | undefined;
        let primaryKey = false;
        let unique = false;
        while (true) {
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
            if (this.at('REFERENCES') || this.at('CHECK') || this.at('CONSTRAINT')) {
                throw new ServerError('0A000', 'feature not supported', 'foreign keys and check constraints are not implemented');
            }
            return { name, type, notNull, defaultExpr, primaryKey, unique };
        }
    }

    private parseDrop(): Statement {
        this.expect('DROP');
        this.expect('TABLE');
        const ifExists = this.at('IF') ? (this.next(), this.expect('EXISTS'), true) : false;
        const table = this.parseRelationRef();
        this.accept('CASCADE');
        this.accept('RESTRICT');
        return { kind: 'drop-table', table, ifExists };
    }

    private parseRelationRef(): RelationRef {
        const names = this.parseNamePath();
        const schema = names.length > 1 ? names[names.length - 2] : undefined;
        const name = names[names.length - 1] ?? '';
        return { kind: 'relation', schema, name, alias: undefined };
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
