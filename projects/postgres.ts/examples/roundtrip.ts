import { cell, query } from '@yydb/postgres';

const port = Number(process.env.POSTGRES_TEST_PORT ?? 5432);
const [result] = query({
    host: process.env.POSTGRES_TEST_HOST ?? '127.0.0.1',
    port,
    user: process.env.POSTGRES_TEST_USER ?? 'postgres',
    database: process.env.POSTGRES_TEST_DATABASE ?? 'postgres',
    sql: 'SELECT 1 AS one',
});
if (result === undefined) throw new Error('the server returned no statement');
console.log(result.tag);
console.log(result.columns[0]?.name, cell(result, 0, 0));
