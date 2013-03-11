/**
 * Differential SQL corpus against a real PostgreSQL engine (PGlite 0.5.15).
 *
 *     node projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed 20261106
 *
 * The generator is a pure function of `--seed`, so the same seed always
 * produces the same statements in the same order and rewrites the same report.
 *
 * Expectations never come from this repository: they are read from PGlite with
 * `execProtocolRaw` and decoded by an independent protocol reader in
 * `sql-diff-runtime.mjs`. The repository side is the installed public client
 * (native binding through `@yydb/postgres`) talking to a second PGlite instance
 * over the real socket server, exactly like the acceptance harness does.
 *
 * Every statement runs on the staging schema `sqldiff`, never on `public`, so
 * no frozen acceptance table is touched. The only command-line switches are
 * `--seed` and `--only` (repeat one case for a minimal repro).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(harnessDir, '..', '..', '..', '..');
const packageDir = path.join(repositoryRoot, 'projects', 'postgres.ts', 'packages', 'postgres');
const runtimeFile = path.join(harnessDir, 'scripts', 'sql-diff-runtime.mjs');
const reportJson = path.join(repositoryRoot, 'docs', 'sql-diff-report.json');
const reportMarkdown = path.join(repositoryRoot, 'docs', 'sql-compatibility-gaps.md');
const knownCases = path.join(harnessDir, 'cases', 'sql-diff.json');

const DEFAULT_SEED = 20261106;

// -------------------------------------------------------------------------------
// Deterministic generator.
// -------------------------------------------------------------------------------
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function factory(seed) {
    const rng = mulberry32(seed);
    const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
    const pick = (values) => values[int(0, values.length - 1)];
    const pickN = (values, count) => {
        const pool = [...values];
        const out = [];
        while (out.length < count && pool.length > 0) out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
        return out;
    };
    return { rng, int, pick, pickN };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const DATES = ['2023-03-04', '2023-07-19', '2024-01-31', '2024-02-29', '2024-11-06'];
const STAGE_ROWS = [
    ['1', "'alpha'", '10.50', 'true', "'2024-01-01'"],
    ['2', "'bravo'", '20.00', 'false', "'2024-02-02'"],
    ['3', "'charlie'", '30.25', 'true', "'2024-03-03'"],
    ['4', "'delta'", '-4.75', 'false', "'2024-04-04'"],
    ['5', "'echo'", '0.00', 'true', "'2024-05-05'"],
];

function seededRows(gen, count, offset = 0) {
    return Array.from({ length: count }, (_, index) => ({
        id: offset + index + 1,
        label: gen.pick(WORDS),
        amount: `${gen.int(-20, 40)}.00`,
        flag: gen.rng() > 0.5,
        day: gen.pick(DATES),
    }));
}

function ddlCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.ddl_${index}`;
    const columns = ['int', 'bigint', 'text', 'varchar(32)', 'numeric(10,2)', 'boolean', 'date', 'jsonb'];

    {
        const picked = gen.pickN(columns, gen.int(2, 4));
        cases.push({
            name: 'create-table-simple',
            sql: `CREATE TABLE ${table(1)} (id int, ${picked.map((type, index) => `c${index} ${type}`).join(', ')})`,
            teardown: [`DROP TABLE IF EXISTS ${table(1)} CASCADE`],
        });
    }
    cases.push({
        name: 'create-table-primary-key',
        sql: `CREATE TABLE ${table(2)} (id int PRIMARY KEY, label text NOT NULL)`,
        teardown: [`DROP TABLE IF EXISTS ${table(2)} CASCADE`],
    });
    {
        const amount = gen.int(1, 9);
        const day = gen.pick(DATES);
        cases.push({
            name: 'create-table-defaults',
            sql: `CREATE TABLE ${table(3)} (id int DEFAULT ${amount}, label text DEFAULT '${gen.pick(WORDS)}', created date DEFAULT '${day}')`,
            teardown: [`DROP TABLE IF EXISTS ${table(3)} CASCADE`],
        });
    }
    cases.push({
        name: 'create-table-check',
        sql: `CREATE TABLE ${table(4)} (id int CHECK (id > 0), amount numeric CHECK (amount >= 0))`,
        teardown: [`DROP TABLE IF EXISTS ${table(4)} CASCADE`],
    });
    cases.push({
        name: 'create-table-identity',
        sql: `CREATE TABLE ${table(5)} (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text)`,
        teardown: [`DROP TABLE IF EXISTS ${table(5)} CASCADE`],
    });
    cases.push({
        name: 'create-table-array-column',
        sql: `CREATE TABLE ${table(6)} (id int, tags text[])`,
        teardown: [`DROP TABLE IF EXISTS ${table(6)} CASCADE`],
    });
    cases.push({
        name: 'alter-add-column',
        setup: [`CREATE TABLE ${table(7)} (id int)`],
        sql: `ALTER TABLE ${table(7)} ADD COLUMN label text DEFAULT '${gen.pick(WORDS)}'`,
        teardown: [`DROP TABLE IF EXISTS ${table(7)} CASCADE`],
    });
    cases.push({
        name: 'alter-set-default',
        setup: [`CREATE TABLE ${table(8)} (id int, amount numeric)`],
        sql: `ALTER TABLE ${table(8)} ALTER COLUMN amount SET DEFAULT ${gen.int(1, 20)}`,
        teardown: [`DROP TABLE IF EXISTS ${table(8)} CASCADE`],
    });
    cases.push({
        name: 'alter-drop-column',
        setup: [`CREATE TABLE ${table(9)} (id int, label text, amount numeric)`],
        sql: `ALTER TABLE ${table(9)} DROP COLUMN label`,
        teardown: [`DROP TABLE IF EXISTS ${table(9)} CASCADE`],
    });
    cases.push({
        name: 'alter-rename-column',
        setup: [`CREATE TABLE ${table(10)} (id int, label text)`],
        sql: `ALTER TABLE ${table(10)} RENAME COLUMN label TO title`,
        teardown: [`DROP TABLE IF EXISTS ${table(10)} CASCADE`],
    });
    cases.push({
        name: 'create-index',
        setup: [`CREATE TABLE ${table(11)} (id int, label text)`],
        sql: `CREATE INDEX ddl_11_label_idx ON ${table(11)} (label)`,
        teardown: [`DROP TABLE IF EXISTS ${table(11)} CASCADE`],
    });
    cases.push({
        name: 'create-unique-index',
        setup: [`CREATE TABLE ${table(12)} (id int, label text)`],
        sql: `CREATE UNIQUE INDEX ddl_12_label_key ON ${table(12)} (label)`,
        teardown: [`DROP TABLE IF EXISTS ${table(12)} CASCADE`],
    });
    cases.push({
        name: 'create-view',
        setup: [`CREATE TABLE ${table(13)} (id int, label text)`, `INSERT INTO ${table(13)} VALUES (1, 'a'), (2, 'b')`],
        sql: `CREATE VIEW sqldiff.ddl_view_13 AS SELECT id, upper(label) AS shout FROM ${table(13)}`,
        teardown: ['DROP VIEW IF EXISTS sqldiff.ddl_view_13', `DROP TABLE IF EXISTS ${table(13)} CASCADE`],
    });
    cases.push({
        name: 'create-or-replace-view',
        setup: [
            `CREATE TABLE ${table(14)} (id int)`,
            `CREATE VIEW sqldiff.ddl_view_14 AS SELECT id FROM ${table(14)}`,
        ],
        sql: `CREATE OR REPLACE VIEW sqldiff.ddl_view_14 AS SELECT id, id + 1 AS next FROM ${table(14)}`,
        teardown: ['DROP VIEW IF EXISTS sqldiff.ddl_view_14', `DROP TABLE IF EXISTS ${table(14)} CASCADE`],
    });
    {
        const multiplier = gen.int(2, 6);
        cases.push({
            name: 'create-table-as',
            sql: `CREATE TABLE ${table(15)} AS SELECT n AS id, n * ${multiplier} AS scaled FROM generate_series(1, 3) AS n`,
            teardown: [`DROP TABLE IF EXISTS ${table(15)} CASCADE`],
        });
    }
    cases.push({
        name: 'drop-table',
        setup: [`CREATE TABLE ${table(16)} (id int)`],
        sql: `DROP TABLE ${table(16)}`,
    });
    cases.push({
        name: 'drop-view',
        setup: [
            `CREATE TABLE ${table(17)} (id int)`,
            `CREATE VIEW sqldiff.ddl_view_17 AS SELECT id FROM ${table(17)}`,
        ],
        sql: 'DROP VIEW sqldiff.ddl_view_17',
        teardown: [`DROP TABLE IF EXISTS ${table(17)} CASCADE`],
    });
    cases.push({
        name: 'comment-on-table',
        setup: [`CREATE TABLE ${table(18)} (id int)`],
        sql: `COMMENT ON TABLE ${table(18)} IS '${gen.pick(WORDS)}'`,
        teardown: [`DROP TABLE IF EXISTS ${table(18)} CASCADE`],
    });
    cases.push({
        name: 'create-table-temporary',
        sql: `CREATE TEMPORARY TABLE ddl_tmp_19 (id int)`,
        teardown: ['DROP TABLE IF EXISTS ddl_tmp_19'],
    });
    {
        const start = gen.int(1, 5);
        cases.push({
            name: 'alter-table-add-constraint',
            setup: [`CREATE TABLE ${table(20)} (id int, amount numeric)`],
            sql: `ALTER TABLE ${table(20)} ADD CONSTRAINT ddl_20_amount_check CHECK (amount >= ${start})`,
            teardown: [`DROP TABLE IF EXISTS ${table(20)} CASCADE`],
        });
    }
    return cases.map((item) => ({ cluster: 'ddl', setup: [], ...item }));
}

function dmlCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.dml_${index}`;
    const create = (index) => [
        `CREATE TABLE ${table(index)} (id int PRIMARY KEY, label text, amount numeric(10,2), flag boolean)`,
    ];
    const seedRows = (index, count = gen.int(2, 3)) => {
        const rows = seededRows(gen, count);
        return `INSERT INTO ${table(index)} VALUES ${rows.map((row) => `(${row.id}, '${row.label}', ${row.amount}, ${row.flag})`).join(', ')}`;
    };
    const teardown = (index) => [`DROP TABLE IF EXISTS ${table(index)} CASCADE`];

    cases.push({
        name: 'insert-one',
        setup: create(1),
        sql: `INSERT INTO ${table(1)} VALUES (${gen.int(1, 9)}, '${gen.pick(WORDS)}', ${gen.int(1, 30)}, true)`,
        teardown: teardown(1),
    });
    {
        const rows = seededRows(gen, gen.int(2, 4));
        cases.push({
            name: 'insert-many',
            setup: create(2),
            sql: `INSERT INTO ${table(2)} VALUES ${rows.map((row) => `(${row.id}, '${row.label}', ${row.amount}, ${row.flag})`).join(', ')}`,
            teardown: teardown(2),
        });
    }
    cases.push({
        name: 'insert-returning',
        setup: create(3),
        sql: `INSERT INTO ${table(3)} VALUES (${gen.int(10, 20)}, '${gen.pick(WORDS)}', ${gen.int(1, 30)}, false) RETURNING id, label`,
        teardown: teardown(3),
    });
    {
        const count = gen.int(2, 5);
        cases.push({
            name: 'insert-from-series',
            setup: create(4),
            sql: `INSERT INTO ${table(4)} SELECT n, 'v' || n, n * 2, n % 2 = 0 FROM generate_series(1, ${count}) AS n`,
            teardown: teardown(4),
        });
    }
    cases.push({
        name: 'insert-default-values',
        setup: [`CREATE TABLE ${table(5)} (id int DEFAULT 7, label text DEFAULT '${gen.pick(WORDS)}')`],
        sql: `INSERT INTO ${table(5)} DEFAULT VALUES`,
        teardown: teardown(5),
    });
    cases.push({
        name: 'insert-on-conflict-nothing',
        setup: [...create(6), seedRows(6, 2)],
        sql: `INSERT INTO ${table(6)} VALUES (1, 'duplicate', 5, true) ON CONFLICT (id) DO NOTHING`,
        teardown: teardown(6),
    });
    cases.push({
        name: 'insert-on-conflict-update',
        setup: [...create(7), seedRows(7, 2)],
        sql: `INSERT INTO ${table(7)} VALUES (1, 'updated', 9.99, false) ON CONFLICT (id) DO UPDATE SET label = excluded.label, amount = excluded.amount`,
        teardown: teardown(7),
    });
    cases.push({
        name: 'update-one',
        setup: [...create(8), seedRows(8, 3)],
        sql: `UPDATE ${table(8)} SET label = '${gen.pick(WORDS)}' WHERE id = ${gen.int(1, 3)}`,
        teardown: teardown(8),
    });
    cases.push({
        name: 'update-all',
        setup: [...create(9), seedRows(9, 3)],
        sql: `UPDATE ${table(9)} SET flag = NOT flag, amount = amount + ${gen.int(1, 5)}`,
        teardown: teardown(9),
    });
    cases.push({
        name: 'update-returning',
        setup: [...create(10), seedRows(10, 3)],
        sql: `UPDATE ${table(10)} SET label = upper(label) WHERE id > 1 RETURNING id, label`,
        teardown: teardown(10),
    });
    cases.push({
        name: 'update-from',
        setup: [
            ...create(11),
            seedRows(11, 3),
            `CREATE TABLE sqldiff.dml_11_patch (id int, label text)`,
            `INSERT INTO sqldiff.dml_11_patch VALUES (1, '${gen.pick(WORDS)}'), (2, '${gen.pick(WORDS)}')`,
        ],
        sql: `UPDATE ${table(11)} AS target SET label = patch.label FROM sqldiff.dml_11_patch AS patch WHERE target.id = patch.id RETURNING target.id, target.label`,
        teardown: [`DROP TABLE IF EXISTS sqldiff.dml_11_patch CASCADE`, ...teardown(11)],
    });
    cases.push({
        name: 'delete-one',
        setup: [...create(12), seedRows(12, 3)],
        sql: `DELETE FROM ${table(12)} WHERE id = ${gen.int(1, 3)}`,
        teardown: teardown(12),
    });
    cases.push({
        name: 'delete-returning',
        setup: [...create(13), seedRows(13, 3)],
        sql: `DELETE FROM ${table(13)} WHERE amount > ${gen.int(0, 20)} RETURNING id, amount`,
        teardown: teardown(13),
    });
    cases.push({
        name: 'delete-all',
        setup: [...create(14), seedRows(14, 4)],
        sql: `DELETE FROM ${table(14)}`,
        teardown: teardown(14),
    });
    cases.push({
        name: 'truncate-table',
        setup: [...create(15), seedRows(15, 3)],
        sql: `TRUNCATE ${table(15)}`,
        teardown: teardown(15),
    });
    cases.push({
        name: 'select-after-writes',
        setup: [...create(16), seedRows(16, 4)],
        sql: `SELECT id, label FROM ${table(16)} WHERE flag ORDER BY id`,
        teardown: teardown(16),
    });
    cases.push({
        name: 'insert-explicit-null',
        setup: create(17),
        sql: `INSERT INTO ${table(17)} VALUES (${gen.int(1, 9)}, NULL, NULL, NULL) RETURNING id`,
        teardown: teardown(17),
    });
    {
        const value = gen.int(1, 20);
        cases.push({
            name: 'insert-cast-values',
            setup: create(18),
            sql: `INSERT INTO ${table(18)} VALUES ('${value}'::int, '${gen.pick(WORDS)}'::varchar, '${value}.50'::numeric, '${gen.pick(['true', 'false'])}'::boolean) RETURNING amount`,
            teardown: teardown(18),
        });
    }
    cases.push({
        name: 'update-two-columns',
        setup: [...create(19), seedRows(19, 2)],
        sql: `UPDATE ${table(19)} SET label = label || '-x', amount = round(amount * 2, 2) WHERE id = 1`,
        teardown: teardown(19),
    });
    cases.push({
        name: 'delete-using-subquery',
        setup: [...create(20), seedRows(20, 4)],
        sql: `DELETE FROM ${table(20)} WHERE id IN (SELECT id FROM ${table(20)} WHERE amount > ${gen.int(0, 20)})`,
        teardown: teardown(20),
    });
    cases.push({
        name: 'insert-select-join',
        setup: [
            ...create(21),
            `CREATE TABLE sqldiff.dml_21_other (id int, label text)`,
            `INSERT INTO sqldiff.dml_21_other VALUES (1, '${gen.pick(WORDS)}'), (2, '${gen.pick(WORDS)}'), (3, '${gen.pick(WORDS)}')`,
        ],
        sql: `INSERT INTO ${table(21)} SELECT other.id, other.label, other.id * 3, false FROM sqldiff.dml_21_other AS other RETURNING id, label`,
        teardown: [`DROP TABLE IF EXISTS sqldiff.dml_21_other CASCADE`, ...teardown(21)],
    });
    cases.push({
        name: 'count-after-insert',
        setup: create(22),
        sql: `INSERT INTO ${table(22)} SELECT n, 'n' || n, n, true FROM generate_series(1, ${gen.int(2, 5)}) AS n; SELECT count(*) AS c, sum(id) AS total FROM ${table(22)}`,
        teardown: teardown(22),
    });
    return cases.map((item) => ({ cluster: 'dml', ...item }));
}

const STAGE_SETUP = [
    'CREATE TABLE sqldiff.stage (id int, label text, amount numeric(10,2), flag boolean, created date)',
    `INSERT INTO sqldiff.stage VALUES ${STAGE_ROWS.map((row) => `(${row.join(', ')})`).join(', ')}`,
];

function exprCluster(gen) {
    const cases = [];
    const a = gen.int(-9, 9) || 4;
    const b = gen.int(1, 9);
    const text = gen.pick(WORDS);
    const cases_ = [
        ['arithmetic-add', `SELECT ${a} + ${b} AS sum, ${a} - ${b} AS diff, ${a} * ${b} AS product`],
        ['integer-division', `SELECT ${a} / ${b} AS quotient, ${a} % ${b} AS remainder`],
        ['precedence', `SELECT ${a} + ${b} * 2 AS one, (${a} + ${b}) * 2 AS two`],
        ['power-sqrt', 'SELECT power(2, 10) AS p, sqrt(144) AS s'],
        ['rounding', `SELECT abs(${a}) AS a, ceil(2.3) AS c, floor(2.7) AS f, round(2.345, 2) AS r`],
        ['text-concat', `SELECT '${text}' || '-' || ${b}::text AS joined`],
        ['text-functions', `SELECT upper('${text}') AS u, lower('${text}') AS l, length('${text}') AS n`],
        ['substring', `SELECT substring('${text}' FROM 2 FOR 3) AS part, left('${text}', 1) AS head, right('${text}', 2) AS tail`],
        ['trim-replace', `SELECT replace('${text}-${text}', '-', ':') AS replaced, btrim('  ${text}  ') AS trimmed`],
        ['split-part', `SELECT split_part('${text}-${b}-x', '-', 2) AS middle`],
        ['padding', `SELECT lpad('${text}', 10, '.') AS l, rpad('${text}', 10, '.') AS r`],
        ['coalesce-nullif', `SELECT coalesce(NULL, '${text}') AS c, nullif('${text}', '${WORDS[0]}') AS n`],
        ['case-when', `SELECT CASE WHEN ${a} > 0 THEN 'positive' WHEN ${a} < 0 THEN 'negative' ELSE 'zero' END AS sign`],
        ['greatest-least', `SELECT greatest(${a}, ${b}, 0) AS g, least(${a}, ${b}, 0) AS l`],
        ['like-operator', `SELECT '${text}' LIKE '${text[0]}%' AS m, '${text}' ILIKE '${text[0].toUpperCase()}%' AS i`],
        ['in-operator', `SELECT ${a} IN (${a}, ${b}, 0) AS yes, ${b} IN (${a}, 0) AS maybe`],
        ['between-operator', `SELECT ${a} BETWEEN ${Math.min(a, b)} AND ${Math.max(a, b)} AS inside`],
        ['boolean-logic', `SELECT (${a} > 0 AND ${b} > 0) AS both, (${a} > 0 OR ${b} > 0) AS either, NOT (${a} > 0) AS inverted`],
        ['null-predicates', 'SELECT NULL IS NULL AS n1, NULL IS NOT NULL AS n2, 1 IS DISTINCT FROM NULL AS n3'],
        ['scalar-subquery', `SELECT (SELECT max(id) FROM sqldiff.stage) AS top`],
        ['exists-subquery', 'SELECT EXISTS (SELECT 1 FROM sqldiff.stage WHERE flag) AS has_flag'],
        ['row-comparison', 'SELECT (1, 2) = (1, 2) AS same, (1, 2) < (1, 3) AS less'],
        ['date-arithmetic', `SELECT '${gen.pick(DATES)}'::date + ${b} AS plus, '${gen.pick(DATES)}'::date - 1 AS minus`],
        ['interval', `SELECT '${gen.pick(DATES)}'::date + interval '${b} days' AS shifted`],
        ['date-extract', `SELECT extract(year FROM '${gen.pick(DATES)}'::date) AS y, extract(month FROM '${gen.pick(DATES)}'::date) AS m`],
        ['to-char', `SELECT to_char('${gen.pick(DATES)}'::date, 'YYYY-MM-DD') AS formatted`],
        ['union-operator', `SELECT id FROM sqldiff.stage WHERE id <= 2 UNION SELECT id FROM sqldiff.stage WHERE id >= 4 ORDER BY id`],
        ['intersect-except', 'SELECT id FROM sqldiff.stage WHERE id <= 3 INTERSECT SELECT id FROM sqldiff.stage WHERE id >= 2 ORDER BY id'],
        ['cte-select', `WITH picked AS (SELECT id, label FROM sqldiff.stage WHERE flag) SELECT id, label FROM picked ORDER BY id`],
        ['recursive-cte', `WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ${gen.int(2, 4)}) SELECT n FROM counter ORDER BY n`],
        ['window-row-number', 'SELECT id, row_number() OVER (ORDER BY amount DESC) AS rn FROM sqldiff.stage ORDER BY id'],
        ['window-lag', 'SELECT id, lag(label) OVER (ORDER BY id) AS previous FROM sqldiff.stage ORDER BY id'],
        ['join-staging', 'SELECT a.id, b.label FROM sqldiff.stage AS a LEFT JOIN sqldiff.stage AS b ON b.id = a.id + 1 ORDER BY a.id'],
        ['order-nulls', 'SELECT id FROM sqldiff.stage ORDER BY id DESC NULLS LAST'],
    ];
    for (const [name, sql] of cases_) cases.push({ cluster: 'expr', name, setup: [], sql, teardown: [] });
    return cases;
}

function aggCluster(gen) {
    const cases = [];
    const cases_ = [
        ['count-star', 'SELECT count(*) AS c FROM sqldiff.stage'],
        ['count-column', 'SELECT count(label) AS c FROM sqldiff.stage'],
        ['count-distinct', 'SELECT count(DISTINCT flag) AS c FROM sqldiff.stage'],
        ['sum-int', 'SELECT sum(id) AS s FROM sqldiff.stage'],
        ['sum-numeric', 'SELECT sum(amount) AS s FROM sqldiff.stage'],
        ['avg-numeric', 'SELECT avg(amount) AS a FROM sqldiff.stage'],
        ['min-max-text', 'SELECT min(label) AS lo, max(label) AS hi FROM sqldiff.stage'],
        ['group-by-one', 'SELECT flag, count(*) AS c FROM sqldiff.stage GROUP BY flag ORDER BY flag'],
        ['group-by-two', "SELECT flag, label, count(*) AS c FROM sqldiff.stage GROUP BY flag, label ORDER BY flag, label"],
        ['having-filter', 'SELECT flag, count(*) AS c FROM sqldiff.stage GROUP BY flag HAVING count(*) > 1 ORDER BY flag'],
        ['order-by-aggregate', 'SELECT label, count(*) AS c FROM sqldiff.stage GROUP BY label ORDER BY count(*) DESC, label'],
        ['filter-clause', "SELECT count(*) FILTER (WHERE flag) AS yes, count(*) FILTER (WHERE NOT flag) AS no FROM sqldiff.stage"],
        ['string-agg', "SELECT string_agg(label, ',' ORDER BY label) AS joined FROM sqldiff.stage"],
        ['array-agg', 'SELECT array_agg(id ORDER BY id) AS ids FROM sqldiff.stage'],
        ['bool-and-or', 'SELECT bool_and(flag) AS all_true, bool_or(flag) AS any_true FROM sqldiff.stage'],
        ['window-count', 'SELECT id, count(*) OVER () AS total FROM sqldiff.stage ORDER BY id'],
        ['window-partition', 'SELECT id, sum(id) OVER (PARTITION BY flag ORDER BY id) AS running FROM sqldiff.stage ORDER BY id'],
        ['rank', 'SELECT id, rank() OVER (ORDER BY amount) AS r, dense_rank() OVER (ORDER BY amount) AS d FROM sqldiff.stage ORDER BY id'],
        ['aggregate-distinct', 'SELECT count(DISTINCT label) AS labels, count(DISTINCT flag) AS flags FROM sqldiff.stage'],
        ['empty-aggregates', 'SELECT count(*) AS c, sum(id) AS s FROM sqldiff.stage WHERE id > 100'],
        ['multiple-aggregates', 'SELECT min(id) AS lo, max(id) AS hi, avg(amount) AS avg_amount FROM sqldiff.stage'],
        ['group-having-order', `SELECT flag, max(id) AS hi FROM sqldiff.stage GROUP BY flag HAVING max(id) >= ${gen.int(2, 5)} ORDER BY flag`],
    ];
    for (const [name, sql] of cases_) cases.push({ cluster: 'agg', name, setup: [], sql, teardown: [] });
    return cases;
}

function castCluster(gen) {
    const cases = [];
    const n = gen.int(10, 40);
    const word = gen.pick(WORDS);
    const cases_ = [
        ['text-to-int', `SELECT '${n}'::int AS v`],
        ['int-to-text', `SELECT ${n}::text AS v`],
        ['int-to-bigint', `SELECT ${n}::bigint AS v`],
        ['int-to-numeric', `SELECT ${n}::numeric(10,2) AS v`],
        ['numeric-to-int', 'SELECT 2.9::numeric::int AS v, (-2.9)::numeric::int AS w'],
        ['numeric-to-float8', 'SELECT 1.25::numeric::float8 AS v'],
        ['bool-to-text', "SELECT true::text AS t, false::text AS f"],
        ['text-to-bool', "SELECT 'true'::boolean AS t, 'f'::boolean AS f"],
        ['text-to-date', `SELECT '${gen.pick(DATES)}'::date AS d`],
        ['date-to-text', `SELECT '${gen.pick(DATES)}'::date::text AS v`],
        ['timestamp-to-date', `SELECT '${gen.pick(DATES)} 12:34:56'::timestamp::date AS d`],
        ['date-to-timestamp', `SELECT '${gen.pick(DATES)}'::date::timestamp AS ts`],
        ['interval-to-text', "SELECT (interval '2 days 03:04:05')::text AS v"],
        ['text-to-uuid', "SELECT '0f8fad5b-d9cb-469f-a165-70867728950e'::uuid AS v"],
        ['text-to-jsonb', `SELECT '{"a": ${n}, "b": "${word}"}'::jsonb AS v`],
        ['jsonb-to-text', `SELECT '{"a": ${n}}'::jsonb::text AS v`],
        ['int-to-bytea-format', `SELECT ('${word}'::text)::bytea AS v`],
        ['array-text-output', 'SELECT ARRAY[1, 2, 3] AS a, ARRAY[1,2]::text[] AS t'],
        ['varchar-cast', `SELECT '${word}'::varchar(3) AS v`],
        ['text-to-numeric', `SELECT '${n}.5'::numeric AS v, '${n}'::numeric(5,2) AS w`],
    ];
    for (const [name, sql] of cases_) cases.push({ cluster: 'cast', name, setup: [], sql, teardown: [] });
    return cases;
}

function generateCorpus(seed) {
    const gen = factory(seed);
    const cases = [
        ...ddlCluster(gen),
        ...dmlCluster(gen),
        ...exprCluster(gen),
        ...aggCluster(gen),
        ...castCluster(gen),
    ];
    return cases.map((item, index) => ({ index, setup: [], teardown: [], ...item }));
}

// -------------------------------------------------------------------------------
// Command line.
// -------------------------------------------------------------------------------
function argumentsFrom(argv) {
    const options = { seed: DEFAULT_SEED, only: null };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--seed') options.seed = Number(argv[index + 1]);
        else if (flag === '--only') options.only = argv[index + 1];
        else if (flag === '--help' || flag === '-h') options.help = true;
    }
    if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error(`invalid --seed value`);
    return options;
}

const options = argumentsFrom(process.argv.slice(2));
if (options.help) {
    console.log('usage: node sql-diff.mjs [--seed <uint32>] [--only <case-name>]');
    process.exit(0);
}

// -------------------------------------------------------------------------------
// Repository client. Build the two artifacts on demand so one command is enough.
// -------------------------------------------------------------------------------
const platformKey = `${process.platform}-${process.arch}`;
const bindings = {
    'win32-x64': 'postgres-win32-x64-msvc.node',
    'linux-x64': 'postgres-linux-x64-gnu.node',
    'darwin-x64': 'postgres-darwin-x64.node',
    'darwin-arm64': 'postgres-darwin-arm64.node',
};
const bindingFile = path.join(repositoryRoot, 'projects', 'postgres.ts', 'platforms', `postgres-${platformKey}`, 'lib', bindings[platformKey] ?? '');

function ensureBuilt() {
    if (!fs.existsSync(path.join(packageDir, 'dist', 'native.js'))) {
        execFileSync('pnpm', ['run', 'build:ts'], { cwd: repositoryRoot, stdio: 'inherit', shell: true });
    }
    if (!fs.existsSync(bindingFile)) {
        execFileSync('node', [path.join(repositoryRoot, 'scripts', 'build-napi.mjs')], { cwd: repositoryRoot, stdio: 'inherit' });
    }
}

ensureBuilt();
const { loadNative } = await import(pathToFileURL(path.join(packageDir, 'dist', 'native.js')).href);
const nativeModule = loadNative();

// -------------------------------------------------------------------------------
// Oracle process.
// -------------------------------------------------------------------------------
const runtime = fork(runtimeFile, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
const pending = new Map();
let nextRequest = 0;
let earlyPort = null;

runtime.on('message', (message) => {
    if (message.type === 'listening') {
        earlyPort = message.port;
        pending.get('port')?.(message.port);
        return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
        pending.delete(message.id);
        waiter(message.result);
    }
});

runtime.on('error', (error) => {
    for (const waiter of pending.values()) waiter(Promise.reject(error));
    pending.clear();
});

function call(op, payload = {}) {
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        runtime.send({ id, op, ...payload });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`oracle timeout after 30s on '${op}'`));
            }
        }, 30_000).unref();
    });
}

const oraclePort = earlyPort ?? (await new Promise((resolve) => {
    pending.set('port', resolve);
}));

const config = { host: '127.0.0.1', port: oraclePort, user: 'postgres', database: 'postgres' };
const connection = nativeModule.connect(config);

// -------------------------------------------------------------------------------
// Comparison.
// -------------------------------------------------------------------------------
const SESSION_SETTINGS = ['SET TimeZone = \'UTC\'', 'SET DateStyle = \'ISO, MDY\''];
for (const setting of SESSION_SETTINGS) connection.execute(setting);

function repoErrorOf(error) {
    const message = `${error.message}`;
    const match = message.match(/^([0-9A-Z]{5}): ([\s\S]*)$/);
    return match ? { code: match[1], message: match[2] } : { code: 'client', message };
}

function normalizeRepo(results) {
    return results.map((result) => ({
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => row.values),
        tag: result.tag,
    }));
}

function runRepo(sql) {
    try {
        return { results: normalizeRepo(connection.execute(sql)), error: null };
    } catch (error) {
        return { results: [], error: repoErrorOf(error) };
    }
}

async function both(sql) {
    const oracle = await call('query', { sql });
    const repo = runRepo(sql);
    return { oracle, repo };
}

function statementDiff(item, oracle, repo) {
    const statement = item.sql;
    if (oracle.error || repo.error) {
        const left = oracle.error ? `${oracle.error.code}: ${oracle.error.message}` : 'ok';
        const right = repo.error ? `${repo.error.code}: ${repo.error.message}` : 'ok';
        if (left === right && oracle.error && repo.error) {
            return { matched: true, noticeCount: oracle.notices.length };
        }
        return {
            matched: false,
            reason: oracle.error ? 'error-shape' : 'error-missing',
            statement,
            repo: repo.error ? { error: right } : { results: repo.results },
            pglite: { error: left, results: oracle.results },
        };
    }
    const matched = JSON.stringify(repo.results) === JSON.stringify(oracle.results);
    if (matched) return { matched: true, noticeCount: oracle.notices.length };
    return {
        matched: false,
        reason: 'result-shape',
        statement,
        repo: { results: repo.results },
        pglite: { results: oracle.results },
    };
}

// -------------------------------------------------------------------------------
// Run.
// -------------------------------------------------------------------------------
const corpus = generateCorpus(options.seed);
const digest = crypto.createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const selected = options.only ? corpus.filter((item) => item.name === options.only) : corpus;
if (options.only && selected.length === 0) throw new Error(`no case named '${options.only}'`);

for (const sql of ['DROP SCHEMA IF EXISTS sqldiff CASCADE', 'CREATE SCHEMA sqldiff', ...STAGE_SETUP]) {
    await both(sql);
}

const diffs = [];
const notices = [];
let executed = 0;

for (const item of selected) {
    for (const sql of item.setup) await both(sql);
    const measured = await both(item.sql);
    executed += 1;
    const outcome = statementDiff(item, measured.oracle, measured.repo);
    if (outcome.noticeCount > 0) {
        notices.push({ cluster: item.cluster, name: item.name, count: outcome.noticeCount });
    }
    if (!outcome.matched) {
        diffs.push({
            cluster: item.cluster,
            name: item.name,
            statement: item.sql,
            reason: outcome.reason,
            repo: outcome.repo,
            pglite: outcome.pglite,
            repro: `node projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed ${options.seed} --only ${item.name}`,
        });
    }
    for (const sql of item.teardown) await both(sql);
}

// -------------------------------------------------------------------------------
// Gaps: replies the repository client cannot surface. The oracle side still
// comes from PGlite, so the missing part is shown next to what PGlite sent.
// -------------------------------------------------------------------------------
const gaps = [];

{
    const oracleNotice = await call('query', { sql: 'DROP TABLE IF EXISTS sqldiff.gap_probe_missing' });
    const repoNotice = runRepo('DROP TABLE IF EXISTS sqldiff.gap_probe_missing');
    gaps.push({
        name: 'notice-discarded',
        surface: 'NoticeResponse',
        reason: 'Only DataRow, RowDescription, CommandComplete and ErrorResponse reach the caller. NoticeResponse is read off the socket and dropped, so NOTICE and WARNING text can never be shown, although PostgreSQL emits it for routine DDL.',
        statement: 'DROP TABLE IF EXISTS sqldiff.gap_probe_missing',
        repo: repoNotice.results,
        pglite: { results: oracleNotice.results, notices: oracleNotice.notices.map((notice) => notice.M) },
    });
}

{
    const oracleDetail = await call('query', { sql: "SELECT 'oops'::int" });
    const repoDetail = runRepo("SELECT 'oops'::int");
    gaps.push({
        name: 'error-fields-dropped',
        surface: 'ErrorResponse fields',
        reason: 'ErrorResponse is reduced to C and M. Position P, detail D, hint H and the object name fields never reach the caller, so psql cannot draw an error caret and structured diagnostics are unavailable.',
        statement: "SELECT 'oops'::int",
        repo: repoDetail.error,
        pglite: { error: `${oracleDetail.error.code}: ${oracleDetail.error.message}`, fields: Object.keys(oracleDetail.error.fields).sort() },
    });
}

{
    const oraclePartial = await call('query', { sql: 'SELECT 1 AS a; SELECT 1 / 0' });
    const repoPartial = runRepo('SELECT 1 AS a; SELECT 1 / 0');
    gaps.push({
        name: 'partial-results-dropped',
        surface: 'multi-statement error',
        reason: 'execute throws on the first error and discards the StatementResult entries already decoded for earlier statements of the same simple-query batch.',
        statement: 'SELECT 1 AS a; SELECT 1 / 0',
        repo: repoPartial.error,
        pglite: { results: oraclePartial.results, error: `${oraclePartial.error.code}: ${oraclePartial.error.message}` },
    });
}

// -------------------------------------------------------------------------------
// Boundary probes: wire features this repository never claims. Every probe gets
// a fresh connection so an earlier failure cannot shift the next reply. The
// protocol-abort probes run last because they tear the server-side session down.
// -------------------------------------------------------------------------------
const boundary = [];

for (const [name, feature, work] of [
    ['binary-result-format', 'binary result format', () => nativeModule.encodeBindMessage('', '', [], 1)],
    ['portal-row-limit', 'portal row limit', () => nativeModule.encodeExecuteMessage('', 5)],
    ['oversized-query', 'query larger than 16MiB', () => nativeModule.encodeQueryPacket('x'.repeat(17 * 1024 * 1024))],
]) {
    let error = null;
    try {
        work();
    } catch (raised) {
        error = `${raised.message}`;
    }
    boundary.push({ name, feature, statement: null, repoError: error, repoResults: null });
}

function withFreshConnection(name, feature, statement, run) {
    let repoError = null;
    let repoResults = null;
    let probe = null;
    try {
        probe = nativeModule.connect(config);
        repoResults = normalizeRepo(run(probe));
    } catch (raised) {
        repoError = `${raised.message}`;
    } finally {
        try {
            probe?.close();
        } catch {
            // the session is already gone after an intentional protocol abort
        }
    }
    boundary.push({ name, feature, statement, repoError, repoResults });
}

withFreshConnection('copy-out', 'COPY TO STDOUT', 'COPY (SELECT 1) TO STDOUT', (probe) => probe.execute('COPY (SELECT 1) TO STDOUT'));

withFreshConnection('listen-notify', 'NotificationResponse', 'SELECT 1 AS n; NOTIFY sqldiff_chan', (probe) => {
    probe.execute('LISTEN sqldiff_chan');
    return probe.execute('SELECT 1 AS n; NOTIFY sqldiff_chan');
});

withFreshConnection('copy-in', 'COPY FROM STDIN', 'COPY sqldiff.stage FROM STDIN', (probe) => probe.execute('COPY sqldiff.stage FROM STDIN'));


try {
    connection.close();
} catch {
    // the main session is only closed after the corpus and gap probes
}
// The COPY probes leave the socket server mid-copy, so a graceful stop can
// block. The report is already in memory; killing the runtime is enough.
runtime.kill();

// -------------------------------------------------------------------------------
// Report.
// -------------------------------------------------------------------------------
const clusters = {};
for (const item of corpus) clusters[item.cluster] = (clusters[item.cluster] ?? 0) + 1;
const gated = fs.existsSync(knownCases) ? (JSON.parse(fs.readFileSync(knownCases, 'utf8')).length ?? 0) : 0;

const report = {
    seed: options.seed,
    engine: 'PGlite 0.5.15 through execProtocolRaw and an independent protocol decoder',
    corpus: { total: corpus.length, clusters, digest },
    executed,
    diffs,
    boundary,
    gaps,
    notices,
    gated,
};

fs.mkdirSync(path.dirname(reportJson), { recursive: true });
fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 4)}\n`);

function renderResults(results) {
    if (!results || results.length === 0) return '[]';
    return results.map((result) => `[${result.tag}] ${JSON.stringify(result.rows)}`).join('; ');
}

const lines = [
    '# SQL compatibility gaps against PGlite',
    '',
    `Generated by \`projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed ${report.seed}\`.`,
    'Expectations are read from PGlite 0.5.15 through `execProtocolRaw` with an independent',
    'protocol decoder; the repository side is the installed client from `projects/postgres.ts`,',
    'so this repository is never its own reference.',
    '',
    '## Corpus',
    '',
    `- ${corpus.length} statements: ${Object.entries(clusters).map(([name, count]) => `${name} ${count}`).join(', ')}`,
    `- corpus digest \`${digest}\``,
    '- every statement runs serially on the staging schema `sqldiff`, never on `public`',
    '',
    '## Differences found',
    '',
    ...(diffs.length === 0 ? ['No statement in the declared surface differs from PGlite.', ''] : []),
    ...diffs.map((diff) => [
        `### ${diff.cluster}/${diff.name}`,
        '',
        `- statement: \`${diff.statement}\``,
        `- this repository: \`${JSON.stringify(diff.repo)}\``,
        `- PGlite: \`${JSON.stringify(diff.pglite)}\``,
        `- smallest repro: \`${diff.repro}\``,
        '',
    ].join('\n')),
    '## Gaps in the client surface',
    '',
    ...gaps.map((gap) => [
        `### ${gap.name}`,
        '',
        `- surface: ${gap.surface}`,
        `- statement: \`${gap.statement}\``,
        `- this repository: \`${JSON.stringify(gap.repo)}\``,
        `- PGlite: \`${JSON.stringify(gap.pglite)}\``,
        `- reason: ${gap.reason}`,
        '',
    ].join('\n')),
    '## Outside the declared surface',
    '',
    'These wire features are rejected on purpose and are not counted as defects.',
    '',
    ...boundary.map((item) => `- **${item.name}** (${item.feature}): ${item.repoError ?? renderResults(item.repoResults)}`),
    '',
    '## Gate',
    '',
    `- stable differences frozen as assertions in \`cases/sql-diff.json\`: ${gated}`,
    '',
];

fs.writeFileSync(reportMarkdown, `${lines.join('\n')}\n`);

console.log(JSON.stringify({
    seed: report.seed,
    corpus: report.corpus,
    executed,
    diffs: diffs.length,
    gaps: gaps.length,
    boundary: boundary.length,
    gated,
    report: path.relative(repositoryRoot, reportJson),
}, null, 4));

process.exit(0);
