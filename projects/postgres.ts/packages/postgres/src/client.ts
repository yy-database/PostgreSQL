import { loadNative, type ClientOptions, type StatementResult } from './native.ts';

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
