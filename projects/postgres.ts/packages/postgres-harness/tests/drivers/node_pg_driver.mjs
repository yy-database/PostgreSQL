// node-postgres driver acceptance script.
// Mirrors `psycopg_driver.py`: every value is rendered to text so both drivers
// produce the same JSON for the committed real-server fixture.

import fs from 'node:fs';

import pg from 'pg';

const host = process.env.DRIVER_HOST ?? '127.0.0.1';
const port = Number(process.env.DRIVER_PORT ?? 55432);
const user = process.env.DRIVER_USER ?? 'postgres';
const database = process.env.DRIVER_DATABASE ?? 'postgres';
const result = process.env.DRIVER_RESULT_FILE;

const TYPE_COLUMNS = [
    'c_bool',
    'c_int2',
    'c_int4',
    'c_int8',
    'c_float4',
    'c_float8',
    'c_numeric',
    'c_text',
    'c_varchar',
    'c_bpchar',
    'c_date',
    'c_timestamp',
    'c_timestamptz',
    'c_uuid',
    'c_bytea',
    'c_int4_array',
    'c_text_array',
];

const TYPES = `
CREATE TABLE driver_types (
    c_bool boolean,
    c_int2 int2,
    c_int4 int4,
    c_int8 int8,
    c_float4 float4,
    c_float8 float8,
    c_numeric numeric,
    c_text text,
    c_varchar varchar(16),
    c_bpchar char(8),
    c_date date,
    c_timestamp timestamp,
    c_timestamptz timestamp with time zone,
    c_uuid uuid,
    c_bytea bytea,
    c_int4_array int4[],
    c_text_array text[]
)
`;

const TYPE_PARAMETERS = [
    true,
    -32768,
    -2147483648,
    '9007199254740993',
    1.25,
    -2.5,
    '1234567890.123456789',
    'héllo',
    'abc',
    'abc',
    '2024-02-29',
    '2024-02-29 12:34:56.789012',
    '2024-02-29 12:34:56.789012+00',
    '123e4567-e89b-12d3-a456-426614174000',
    Buffer.from([0, 255, 16]),
    [1, -2, 3],
    ['a', 'b c', null],
];

const projection = TYPE_COLUMNS.map((column) => `${column}::text`).join(', ');

async function run() {
    const output = {};
    const client = new pg.Client({ host, port, user, database });
    await client.connect();
    try {
        await client.query("SET TimeZone TO 'UTC'");
        await client.query("SET DateStyle TO 'ISO, MDY'");

        await client.query('DROP TABLE IF EXISTS driver_types');
        await client.query(TYPES);
        const placeholders = TYPE_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
        await client.query(`INSERT INTO driver_types VALUES (${placeholders})`, TYPE_PARAMETERS);
        output['fidelity/row'] = (await client.query(`SELECT ${projection} FROM driver_types`)).rows[0];

        await client.query('DROP TABLE IF EXISTS driver_crud');
        await client.query('CREATE TABLE driver_crud (id int PRIMARY KEY, name text)');
        await client.query('INSERT INTO driver_crud VALUES ($1, $2)', [1, 'alpha']);
        await client.query('INSERT INTO driver_crud VALUES ($1, $2)', [2, 'beta']);
        output['crud/select'] = (await client.query('SELECT id, name FROM driver_crud ORDER BY id')).rows.map((row) => [row.id, row.name]);
        await client.query('UPDATE driver_crud SET name = $1 WHERE id = $2', ['gamma', 2]);
        await client.query('DELETE FROM driver_crud WHERE id = $1', [1]);
        output['crud/after'] = (await client.query('SELECT id, name FROM driver_crud ORDER BY id')).rows.map((row) => [row.id, row.name]);

        await client.query('DROP TABLE IF EXISTS driver_tx');
        await client.query('CREATE TABLE driver_tx (n int)');
        await client.query('BEGIN');
        await client.query('INSERT INTO driver_tx VALUES (1)');
        await client.query('ROLLBACK');
        output['transaction/count'] = Number((await client.query('SELECT count(*)::int AS c FROM driver_tx')).rows[0].c);

        await client.query('DROP TABLE IF EXISTS driver_err');
        await client.query('CREATE TABLE driver_err (id int PRIMARY KEY, n int CHECK (n > 0))');
        try {
            await client.query('INSERT INTO driver_err VALUES (1, -1)');
        } catch (error) {
            output.error = {
                code: error.code,
                detail: error.detail,
                constraint: error.constraint,
                schema: error.schema,
                table: error.table,
            };
        }

        return output;
    } finally {
        await client.end();
    }
}

const payload = await run();
const text = `${JSON.stringify(payload, null, 2)}\n`;
if (result) fs.writeFileSync(result, text);
else process.stdout.write(text);
