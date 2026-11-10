import { loadNative, type ClientOptions, type StatementResult } from './native.ts';
import { stateFailure } from './errors.ts';
import { resolveClientOptions, type PostgreSQLClientOptions, type PostgreSQLQueryOptions, type PostgreSQLTransactionOptions } from './options.ts';
import {
    PostgreSQLOperations,
    type ClientState,
    type PostgreSQLCommandResult,
    type PostgreSQLResult,
    type PostgreSQLRow,
    type PostgreSQLSession,
    type PostgreSQLTransaction,
    type PostgreSQLValue,
} from './session.ts';

/** One statement executed on a fresh connection that is closed before returning. */
export function query(options: ClientOptions & { sql: string }): StatementResult[] {
    const native = loadNative();
    const connection = native.connect(options);
    try {
        return connection.execute(options.sql);
    } finally {
        connection.close();
    }
}

/** Column names of one result set, in order. */
export function columnNames(result: StatementResult): string[] {
    return result.columns.map((column) => column.name);
}

/** Cell text of one coordinate, or `null` when the cell is SQL `NULL`. */
export function cell(result: StatementResult, row: number, column: number): string | null | undefined {
    return result.rows[row]?.values[column];
}

/** The first cell of the first row, which is what `psql -t -c` prints. */
export function firstValue(results: StatementResult[]): string | null | undefined {
    const [first] = results;
    return first ? first.rows[0]?.values[0] : undefined;
}

/**
 * A remote PostgreSQL client. Construction validates options only; `connect`
 * dials the first connection, completes authentication and negotiates the
 * server's parameter status through the protocol primitives. The client never
 * starts, repairs or manages a server, and `close` drops only its own
 * connections.
 */
export class PostgreSQLClient {
    private readonly settings: ReturnType<typeof resolveClientOptions>;
    private readonly pool: PostgreSQLClientOptions['pool'];
    private stateValue: ClientState = 'new';
    private connecting: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private operations: PostgreSQLOperations | null = null;

    constructor(options: PostgreSQLClientOptions) {
        this.settings = resolveClientOptions(options);
        this.pool = options.pool;
    }

    get state(): ClientState {
        return this.stateValue;
    }

    /** The database the client selects. Defaults to the role name. */
    get database(): string {
        return this.settings.database;
    }

    /** Dials the pool and proves readiness with one extended-protocol round trip. */
    async connect(): Promise<void> {
        if (this.stateValue === 'ready') return;
        if (this.connecting !== null) return this.connecting;
        if (this.stateValue !== 'new') throw stateFailure(`connect is not available from state "${this.stateValue}"`);
        this.stateValue = 'connecting';
        this.connecting = this.doConnect().then(
            () => {
                this.stateValue = 'ready';
                this.connecting = null;
            },
            (error: unknown) => {
                this.stateValue = 'failed';
                this.connecting = null;
                throw error;
            },
        );
        return this.connecting;
    }

    async query<R = PostgreSQLRow>(sql: string, params?: readonly PostgreSQLValue[], options?: PostgreSQLQueryOptions): Promise<PostgreSQLResult<R>> {
        return (await this.active()).query<R>(sql, params, options);
    }

    async execute(sql: string, params?: readonly PostgreSQLValue[]): Promise<PostgreSQLCommandResult> {
        return (await this.active()).execute(sql, params);
    }

    async withSession<T>(fn: (session: PostgreSQLSession) => Promise<T>): Promise<T> {
        return (await this.active()).withSession(fn);
    }

    async transaction<T>(fn: (tx: PostgreSQLTransaction) => Promise<T>, options?: PostgreSQLTransactionOptions): Promise<T> {
        return (await this.active()).transaction(fn, options);
    }

    /** Closes the pool and every derived handle. The remote database is untouched. */
    close(): Promise<void> {
        if (this.stateValue === 'closed') return Promise.resolve();
        if (this.closing !== null) return this.closing;
        if (this.stateValue === 'new' || this.stateValue === 'failed') {
            this.stateValue = 'closed';
            return Promise.resolve();
        }
        this.closing = this.doClose();
        return this.closing;
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    private async doConnect(): Promise<void> {
        const operations = new PostgreSQLOperations(loadNative(), this.settings, this.pool);
        try {
            await operations.probe();
        } catch (error) {
            await operations.close();
            throw error;
        }
        this.operations = operations;
    }

    private async doClose(): Promise<void> {
        this.stateValue = 'closing';
        try {
            await this.operations?.close();
        } finally {
            this.operations = null;
            this.stateValue = 'closed';
        }
    }

    private async active(): Promise<PostgreSQLOperations> {
        if (this.stateValue !== 'ready' || this.operations === null) {
            throw stateFailure(`the client is not connected (state "${this.stateValue}")`);
        }
        return this.operations;
    }
}
