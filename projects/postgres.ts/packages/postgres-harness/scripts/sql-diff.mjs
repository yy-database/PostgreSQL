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
 * no frozen acceptance table is touched. The run is a pure function of
 * `--seed` and `--count`: no wall clock, no locale and no unseeded randomness
 * takes part. Every process forks its own pair of in-memory PGlite instances,
 * so parallel runs share no state and produce the same report.
 *
 * `--check` is the regression gate used in CI. It verifies the fixed seed,
 * count and corpus digest in `corpus/sql-differential-baseline.json` before any
 * engine starts, then requires every observed difference to match one baseline
 * entry exactly. An unlisted difference, a changed signal or a stale entry all
 * fail the gate. `--update-baseline` rewrites the baseline from the current run
 * and drops entries that no longer differ. `--only <case>` is a repro switch and
 * cannot be combined with either gate mode.
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
const DEFAULT_COUNT = 295;
const PGLITE_VERSION = '0.5.15';

const BASELINE_VERSION = 1;
const baselineFile = path.join(harnessDir, 'corpus', 'sql-differential-baseline.json');

// `oracle-limitation` marks a case the oracle client cannot express, so the
// difference says nothing about the real engine contract.
const BASELINE_REASONS = ['structured-rejection', 'not-implemented', 'out-of-scope', 'oracle-disagreement', 'oracle-limitation'];

// The probes never reach PGlite, so the reason records why this repository
// refuses the frame instead of why a decoded value differs.
const BOUNDARY_REASONS = {
    'binary-result-format': 'not-implemented',
    'portal-row-limit': 'not-implemented',
    'oversized-query': 'structured-rejection',
    'copy-out': 'out-of-scope',
    'copy-in': 'out-of-scope',
    'listen-notify': 'out-of-scope',
};

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

function transactionCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.tx_${index}`;
    const create = (index, body = 'id int PRIMARY KEY, note text') => [`CREATE TABLE ${table(index)} (${body})`];
    const seed = (index, rows) => [`INSERT INTO ${table(index)} VALUES ${rows.join(', ')}`];
    const drop = (index) => [`DROP TABLE IF EXISTS ${table(index)} CASCADE`];

    cases.push({
        name: 'begin-commit-insert',
        setup: create(1),
        sql: `BEGIN; INSERT INTO ${table(1)} VALUES (1, '${gen.pick(WORDS)}'); COMMIT; SELECT count(*) AS n FROM ${table(1)}`,
        teardown: drop(1),
    });
    cases.push({
        name: 'begin-rollback-insert',
        setup: create(2),
        sql: `BEGIN; INSERT INTO ${table(2)} VALUES (1, '${gen.pick(WORDS)}'); ROLLBACK; SELECT count(*) AS n FROM ${table(2)}`,
        teardown: drop(2),
    });
    {
        const rows = seededRows(gen, 3);
        cases.push({
            name: 'begin-rollback-multiple',
            setup: create(3),
            sql: `BEGIN; INSERT INTO ${table(3)} VALUES ${rows.map((row) => `(${row.id}, '${row.label}')`).join(', ')}; ROLLBACK; SELECT count(*) AS n FROM ${table(3)}`,
            teardown: drop(3),
        });
    }
    cases.push({
        name: 'savepoint-rollback-to',
        setup: create(4),
        sql: `BEGIN; INSERT INTO ${table(4)} VALUES (1, 'keep'); SAVEPOINT s1; INSERT INTO ${table(4)} VALUES (2, 'drop'); ROLLBACK TO SAVEPOINT s1; COMMIT; SELECT count(*) AS n FROM ${table(4)}`,
        teardown: drop(4),
    });
    cases.push({
        name: 'savepoint-release',
        setup: create(5),
        sql: `BEGIN; INSERT INTO ${table(5)} VALUES (1, 'a'); SAVEPOINT s1; INSERT INTO ${table(5)} VALUES (2, 'b'); RELEASE SAVEPOINT s1; COMMIT; SELECT count(*) AS n FROM ${table(5)}`,
        teardown: drop(5),
    });
    cases.push({
        name: 'savepoint-nested-rollback',
        setup: create(6),
        sql: `BEGIN; SAVEPOINT outer_s; INSERT INTO ${table(6)} VALUES (1, 'a'); SAVEPOINT inner_s; INSERT INTO ${table(6)} VALUES (2, 'b'); ROLLBACK TO SAVEPOINT inner_s; INSERT INTO ${table(6)} VALUES (3, 'c'); RELEASE SAVEPOINT outer_s; COMMIT; SELECT count(*) AS n FROM ${table(6)}`,
        teardown: drop(6),
    });
    cases.push({
        name: 'savepoint-same-name',
        setup: create(7),
        sql: `BEGIN; SAVEPOINT s; INSERT INTO ${table(7)} VALUES (1, 'a'); SAVEPOINT s; INSERT INTO ${table(7)} VALUES (2, 'b'); ROLLBACK TO SAVEPOINT s; COMMIT; SELECT count(*) AS n FROM ${table(7)}`,
        teardown: drop(7),
    });
    cases.push({
        name: 'implicit-autocommit',
        setup: create(8),
        sql: `INSERT INTO ${table(8)} VALUES (1, 'a'); INSERT INTO ${table(8)} VALUES (2, 'b'); SELECT count(*) AS n FROM ${table(8)}`,
        teardown: drop(8),
    });
    cases.push({
        name: 'commit-without-begin',
        setup: create(9),
        sql: `COMMIT; SELECT count(*) AS n FROM ${table(9)}`,
        teardown: drop(9),
    });
    cases.push({
        name: 'rollback-without-begin',
        setup: create(10),
        sql: `ROLLBACK; SELECT count(*) AS n FROM ${table(10)}`,
        teardown: drop(10),
    });
    cases.push({
        name: 'begin-twice',
        setup: create(11),
        sql: `BEGIN; BEGIN; INSERT INTO ${table(11)} VALUES (1, 'a'); ROLLBACK; SELECT count(*) AS n FROM ${table(11)}`,
        teardown: drop(11),
    });
    cases.push({
        name: 'set-transaction-isolation',
        setup: create(12),
        sql: `BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT count(*) AS n FROM ${table(12)}; COMMIT`,
        teardown: drop(12),
    });
    cases.push({
        name: 'read-only-select',
        setup: create(13),
        sql: `BEGIN READ ONLY; SELECT count(*) AS n FROM ${table(13)}; COMMIT`,
        teardown: drop(13),
    });
    cases.push({
        name: 'read-only-write-error',
        setup: create(14),
        sql: `BEGIN READ ONLY; INSERT INTO ${table(14)} VALUES (1, 'nope')`,
        teardown: drop(14),
    });
    cases.push({
        name: 'rollback-ddl',
        setup: [],
        sql: `BEGIN; CREATE TABLE sqldiff.tx_15_tmp (id int); ROLLBACK; SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'sqldiff' AND c.relname = 'tx_15_tmp'`,
        teardown: ['DROP TABLE IF EXISTS sqldiff.tx_15_tmp CASCADE'],
    });
    cases.push({
        name: 'commit-ddl',
        setup: [],
        sql: `BEGIN; CREATE TABLE sqldiff.tx_16_tmp (id int); COMMIT; SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'sqldiff' AND c.relname = 'tx_16_tmp'`,
        teardown: ['DROP TABLE IF EXISTS sqldiff.tx_16_tmp CASCADE'],
    });
    cases.push({
        name: 'truncate-rollback',
        setup: [...create(17), ...seed(17, ['(1, \'a\')', '(2, \'b\')', '(3, \'c\')'])],
        sql: `BEGIN; TRUNCATE ${table(17)}; ROLLBACK; SELECT count(*) AS n FROM ${table(17)}`,
        teardown: drop(17),
    });
    cases.push({
        name: 'update-rollback',
        setup: [...create(18), ...seed(18, ['(1, \'one\')', '(2, \'two\')'])],
        sql: `BEGIN; UPDATE ${table(18)} SET note = 'changed'; ROLLBACK; SELECT note FROM ${table(18)} ORDER BY id`,
        teardown: drop(18),
    });
    cases.push({
        name: 'delete-commit',
        setup: [...create(19), ...seed(19, ['(1, \'a\')', '(2, \'b\')'])],
        sql: `BEGIN; DELETE FROM ${table(19)} WHERE id = 2; COMMIT; SELECT count(*) AS n FROM ${table(19)}`,
        teardown: drop(19),
    });
    cases.push({
        name: 'upsert-rollback',
        setup: [...create(20), ...seed(20, ['(1, \'before\')'])],
        sql: `BEGIN; INSERT INTO ${table(20)} VALUES (1, 'after') ON CONFLICT (id) DO UPDATE SET note = excluded.note; ROLLBACK; SELECT note FROM ${table(20)}`,
        teardown: drop(20),
    });
    return cases.map((item) => ({ cluster: 'transaction', setup: [], teardown: [], ...item }));
}

function cursorCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.cur_${index}`;
    const setup = (index) => [
        `CREATE TABLE ${table(index)} (id int PRIMARY KEY, label text)`,
        `INSERT INTO ${table(index)} VALUES (1, 'alpha'), (2, 'bravo'), (3, 'charlie'), (4, 'delta'), (5, 'echo')`,
    ];
    const drop = (index) => [`DROP TABLE IF EXISTS ${table(index)} CASCADE`];
    const forward = (index) => `DECLARE c CURSOR FOR SELECT id, label FROM ${table(index)} ORDER BY id`;

    cases.push({
        name: 'declare-fetch-all',
        setup: setup(1),
        sql: `BEGIN; ${forward(1)}; FETCH ALL FROM c; COMMIT`,
        teardown: drop(1),
    });
    cases.push({
        name: 'fetch-forward-two',
        setup: setup(2),
        sql: `BEGIN; ${forward(2)}; FETCH 2 FROM c; FETCH 2 FROM c; FETCH 2 FROM c; COMMIT`,
        teardown: drop(2),
    });
    cases.push({
        name: 'fetch-next',
        setup: setup(3),
        sql: `BEGIN; ${forward(3)}; FETCH NEXT FROM c; FETCH NEXT FROM c; COMMIT`,
        teardown: drop(3),
    });
    cases.push({
        name: 'scroll-fetch-prior',
        setup: setup(4),
        sql: `BEGIN; DECLARE c SCROLL CURSOR FOR SELECT id, label FROM ${table(4)} ORDER BY id; FETCH 3 FROM c; FETCH PRIOR FROM c; FETCH LAST FROM c; COMMIT`,
        teardown: drop(4),
    });
    cases.push({
        name: 'scroll-move-backward',
        setup: setup(5),
        sql: `BEGIN; DECLARE c SCROLL CURSOR FOR SELECT id FROM ${table(5)} ORDER BY id; MOVE FORWARD 4 FROM c; MOVE BACKWARD 2 FROM c; FETCH NEXT FROM c; COMMIT`,
        teardown: drop(5),
    });
    cases.push({
        name: 'move-forward',
        setup: setup(6),
        sql: `BEGIN; ${forward(6)}; MOVE FORWARD 2 FROM c; FETCH 2 FROM c; COMMIT`,
        teardown: drop(6),
    });
    cases.push({
        name: 'move-all',
        setup: setup(7),
        sql: `BEGIN; ${forward(7)}; MOVE ALL FROM c; FETCH NEXT FROM c; COMMIT`,
        teardown: drop(7),
    });
    cases.push({
        name: 'close-cursor',
        setup: setup(8),
        sql: `BEGIN; ${forward(8)}; FETCH 1 FROM c; CLOSE c; COMMIT`,
        teardown: drop(8),
    });
    cases.push({
        name: 'fetch-after-close',
        setup: setup(9),
        sql: `BEGIN; ${forward(9)}; CLOSE c; FETCH 1 FROM c`,
        teardown: drop(9),
    });
    cases.push({
        name: 'declare-with-hold',
        setup: setup(10),
        sql: `BEGIN; DECLARE c CURSOR WITH HOLD FOR SELECT id FROM ${table(10)} ORDER BY id; COMMIT; FETCH 2 FROM c`,
        teardown: ['CLOSE c', ...drop(10)],
    });
    cases.push({
        name: 'declare-no-hold-after-commit',
        setup: setup(11),
        sql: `BEGIN; ${forward(11)}; COMMIT; FETCH 1 FROM c`,
        teardown: drop(11),
    });
    cases.push({
        name: 'declare-outside-transaction',
        setup: setup(12),
        sql: `DECLARE c CURSOR FOR SELECT id FROM ${table(12)}`,
        teardown: drop(12),
    });
    cases.push({
        name: 'fetch-unknown-cursor',
        setup: setup(13),
        sql: `BEGIN; FETCH 1 FROM missing_cursor`,
        teardown: drop(13),
    });
    cases.push({
        name: 'fetch-backward-without-scroll',
        setup: setup(14),
        sql: `BEGIN; ${forward(14)}; FETCH 3 FROM c; FETCH PRIOR FROM c`,
        teardown: drop(14),
    });
    return cases.map((item) => ({ cluster: 'cursor', setup: [], teardown: [], ...item }));
}

function castMatrixCluster(gen) {
    const cases = [];
    const n = gen.int(2, 9);
    const cases_ = [
        ['int-overflow', 'SELECT 2147483648::int AS v'],
        ['int-underflow', 'SELECT (-2147483649)::int AS v'],
        ['bigint-text-overflow', "SELECT '9223372036854775808'::bigint AS v"],
        ['numeric-to-int-overflow', "SELECT '99999999999.9'::numeric::int AS v"],
        ['numeric-scale-overflow', "SELECT 1234.56::numeric(3,2) AS v"],
        ['text-to-int-invalid', "SELECT 'abc'::int AS v"],
        ['text-to-int-whitespace', "SELECT ' 42 '::int AS v"],
        ['text-to-numeric-invalid', "SELECT '1.2.3'::numeric AS v"],
        ['numeric-rounding', 'SELECT 2.5::numeric(10,0) AS v'],
        ['float-to-int-overflow', 'SELECT 1e20::float8::int AS v'],
        ['text-to-date-invalid', "SELECT '2024-02-30'::date AS v"],
        ['text-to-date-format', "SELECT '01/02/2024'::date AS v"],
        ['text-to-timestamp-invalid', "SELECT 'not a time'::timestamp AS v"],
        ['timestamp-to-date', "SELECT '2024-03-04 12:34:56'::timestamp::date AS v"],
        ['date-to-timestamp', "SELECT '2024-03-04'::date::timestamp AS v"],
        ['text-to-timestamptz', "SELECT '2024-03-04 12:34:56+02'::timestamptz AS v"],
        ['text-to-jsonb-invalid', "SELECT 'not json'::jsonb AS v"],
        ['jsonb-to-int', `SELECT ('{"a": ${n}}'::jsonb ->> 'a')::int AS v`],
        ['jsonb-array-index', "SELECT '[1,2,3]'::jsonb -> 2 AS v"],
        ['implicit-int-text-comparison', "SELECT 1 = '1' AS v"],
        ['implicit-int-text-invalid', "SELECT 1 = 'abc' AS v"],
        ['explicit-cast-chain', "SELECT '42'::text::int::numeric AS v"],
        ['boolean-text-cast', "SELECT 'yes'::boolean AS v"],
        ['boolean-invalid', "SELECT 'maybe'::boolean AS v"],
    ];
    for (const [name, sql] of cases_) cases.push({ cluster: 'cast-matrix', name, setup: [], sql, teardown: [] });
    return cases;
}

function constraintCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.con_${index}`;
    const drop = (index) => [`DROP TABLE IF EXISTS ${table(index)} CASCADE`];

    cases.push({
        name: 'unique-violation',
        setup: [`CREATE TABLE ${table(1)} (id int, label text UNIQUE)`, `INSERT INTO ${table(1)} VALUES (1, 'taken')`],
        sql: `INSERT INTO ${table(1)} VALUES (2, 'taken')`,
        teardown: drop(1),
    });
    cases.push({
        name: 'primary-key-violation',
        setup: [`CREATE TABLE ${table(2)} (id int PRIMARY KEY, label text)`, `INSERT INTO ${table(2)} VALUES (1, 'a')`],
        sql: `INSERT INTO ${table(2)} VALUES (1, 'b')`,
        teardown: drop(2),
    });
    cases.push({
        name: 'check-violation',
        setup: [`CREATE TABLE ${table(3)} (id int CHECK (id > 0))`],
        sql: `INSERT INTO ${table(3)} VALUES (-1)`,
        teardown: drop(3),
    });
    cases.push({
        name: 'not-null-violation',
        setup: [`CREATE TABLE ${table(4)} (id int, label text NOT NULL)`],
        sql: `INSERT INTO ${table(4)} VALUES (1, NULL)`,
        teardown: drop(4),
    });
    cases.push({
        name: 'foreign-key-insert-violation',
        setup: [
            `CREATE TABLE ${table(5)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(5)}_child (id int, parent_id int REFERENCES ${table(5)}_parent (id))`,
        ],
        sql: `INSERT INTO ${table(5)}_child VALUES (1, 99)`,
        teardown: [`DROP TABLE IF EXISTS ${table(5)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(5)}_parent CASCADE`],
    });
    cases.push({
        name: 'foreign-key-delete-restrict',
        setup: [
            `CREATE TABLE ${table(6)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(6)}_child (id int, parent_id int REFERENCES ${table(6)}_parent (id))`,
            `INSERT INTO ${table(6)}_parent VALUES (1)`,
            `INSERT INTO ${table(6)}_child VALUES (1, 1)`,
        ],
        sql: `DELETE FROM ${table(6)}_parent WHERE id = 1`,
        teardown: [`DROP TABLE IF EXISTS ${table(6)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(6)}_parent CASCADE`],
    });
    cases.push({
        name: 'foreign-key-cascade-delete',
        setup: [
            `CREATE TABLE ${table(7)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(7)}_child (id int, parent_id int REFERENCES ${table(7)}_parent (id) ON DELETE CASCADE)`,
            `INSERT INTO ${table(7)}_parent VALUES (1), (2)`,
            `INSERT INTO ${table(7)}_child VALUES (1, 1), (2, 1), (3, 2)`,
        ],
        sql: `DELETE FROM ${table(7)}_parent WHERE id = 1; SELECT count(*) AS n FROM ${table(7)}_child`,
        teardown: [`DROP TABLE IF EXISTS ${table(7)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(7)}_parent CASCADE`],
    });
    cases.push({
        name: 'foreign-key-set-null',
        setup: [
            `CREATE TABLE ${table(8)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(8)}_child (id int, parent_id int REFERENCES ${table(8)}_parent (id) ON DELETE SET NULL)`,
            `INSERT INTO ${table(8)}_parent VALUES (1)`,
            `INSERT INTO ${table(8)}_child VALUES (1, 1)`,
        ],
        sql: `DELETE FROM ${table(8)}_parent WHERE id = 1; SELECT parent_id FROM ${table(8)}_child`,
        teardown: [`DROP TABLE IF EXISTS ${table(8)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(8)}_parent CASCADE`],
    });
    cases.push({
        name: 'foreign-key-deferred-commit',
        setup: [
            `CREATE TABLE ${table(9)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(9)}_child (id int, parent_id int REFERENCES ${table(9)}_parent (id) DEFERRABLE INITIALLY IMMEDIATE)`,
        ],
        sql: `BEGIN; SET CONSTRAINTS ALL DEFERRED; INSERT INTO ${table(9)}_child VALUES (1, 99); COMMIT`,
        teardown: [`DROP TABLE IF EXISTS ${table(9)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(9)}_parent CASCADE`],
    });
    cases.push({
        name: 'foreign-key-deferred-ok',
        setup: [
            `CREATE TABLE ${table(10)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(10)}_child (id int, parent_id int REFERENCES ${table(10)}_parent (id) DEFERRABLE INITIALLY IMMEDIATE)`,
        ],
        sql: `BEGIN; SET CONSTRAINTS ALL DEFERRED; INSERT INTO ${table(10)}_child VALUES (1, 7); INSERT INTO ${table(10)}_parent VALUES (7); COMMIT; SELECT count(*) AS n FROM ${table(10)}_child`,
        teardown: [`DROP TABLE IF EXISTS ${table(10)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(10)}_parent CASCADE`],
    });
    cases.push({
        name: 'unique-null-allowed',
        setup: [`CREATE TABLE ${table(11)} (id int, label text UNIQUE)`],
        sql: `INSERT INTO ${table(11)} VALUES (1, NULL), (2, NULL); SELECT count(*) AS n FROM ${table(11)}`,
        teardown: drop(11),
    });
    cases.push({
        name: 'unique-multicolumn-violation',
        setup: [`CREATE TABLE ${table(12)} (a int, b int, UNIQUE (a, b))`, `INSERT INTO ${table(12)} VALUES (1, 1)`],
        sql: `INSERT INTO ${table(12)} VALUES (1, 1)`,
        teardown: drop(12),
    });
    cases.push({
        name: 'on-conflict-do-nothing',
        setup: [`CREATE TABLE ${table(13)} (id int PRIMARY KEY, label text)`, `INSERT INTO ${table(13)} VALUES (1, 'a')`],
        sql: `INSERT INTO ${table(13)} VALUES (1, 'b') ON CONFLICT DO NOTHING; SELECT label FROM ${table(13)}`,
        teardown: drop(13),
    });
    cases.push({
        name: 'on-conflict-do-update',
        setup: [`CREATE TABLE ${table(14)} (id int PRIMARY KEY, label text)`, `INSERT INTO ${table(14)} VALUES (1, 'a')`],
        sql: `INSERT INTO ${table(14)} VALUES (1, 'b') ON CONFLICT (id) DO UPDATE SET label = excluded.label; SELECT label FROM ${table(14)}`,
        teardown: drop(14),
    });
    cases.push({
        name: 'check-not-valid-then-validate',
        setup: [
            `CREATE TABLE ${table(15)} (id int)`,
            `INSERT INTO ${table(15)} VALUES (-1)`,
            `ALTER TABLE ${table(15)} ADD CONSTRAINT con_15_check CHECK (id > 0) NOT VALID`,
        ],
        sql: `ALTER TABLE ${table(15)} VALIDATE CONSTRAINT con_15_check`,
        teardown: drop(15),
    });
    cases.push({
        name: 'drop-constraint-then-insert',
        setup: [`CREATE TABLE ${table(16)} (id int, label text UNIQUE)`, `INSERT INTO ${table(16)} VALUES (1, 'taken')`, `ALTER TABLE ${table(16)} DROP CONSTRAINT ${table(16)}_label_key`],
        sql: `INSERT INTO ${table(16)} VALUES (2, 'taken'); SELECT count(*) AS n FROM ${table(16)}`,
        teardown: drop(16),
    });
    cases.push({
        name: 'create-unique-index-violation',
        setup: [`CREATE TABLE ${table(17)} (id int, label text)`, `INSERT INTO ${table(17)} VALUES (1, 'dup'), (2, 'dup')`],
        sql: `CREATE UNIQUE INDEX con_17_label ON ${table(17)} (label)`,
        teardown: drop(17),
    });
    cases.push({
        name: 'partial-unique-index-allows',
        setup: [
            `CREATE TABLE ${table(18)} (id int, label text, flag boolean)`,
            `CREATE UNIQUE INDEX con_18_label ON ${table(18)} (label) WHERE flag`,
            `INSERT INTO ${table(18)} VALUES (1, 'dup', true)`,
        ],
        sql: `INSERT INTO ${table(18)} VALUES (2, 'dup', false); SELECT count(*) AS n FROM ${table(18)}`,
        teardown: drop(18),
    });
    cases.push({
        name: 'foreign-key-on-update-cascade',
        setup: [
            `CREATE TABLE ${table(19)}_parent (id int PRIMARY KEY)`,
            `CREATE TABLE ${table(19)}_child (id int, parent_id int REFERENCES ${table(19)}_parent (id) ON UPDATE CASCADE)`,
            `INSERT INTO ${table(19)}_parent VALUES (1)`,
            `INSERT INTO ${table(19)}_child VALUES (1, 1)`,
        ],
        sql: `UPDATE ${table(19)}_parent SET id = 11 WHERE id = 1; SELECT parent_id FROM ${table(19)}_child`,
        teardown: [`DROP TABLE IF EXISTS ${table(19)}_child CASCADE`, `DROP TABLE IF EXISTS ${table(19)}_parent CASCADE`],
    });
    cases.push({
        name: 'check-violation-on-update',
        setup: [
            `CREATE TABLE ${table(20)} (id int CHECK (id > 0), label text)`,
            `INSERT INTO ${table(20)} VALUES (1, 'a')`,
        ],
        sql: `UPDATE ${table(20)} SET id = -1 WHERE id = 1`,
        teardown: drop(20),
    });
    return cases.map((item) => ({ cluster: 'constraint', setup: [], teardown: [], ...item }));
}

function extendedCluster(gen) {
    const cases = [];
    const table = (index) => `sqldiff.ext_${index}`;
    const drop = (index) => [`DROP TABLE IF EXISTS ${table(index)} CASCADE`];

    cases.push({
        name: 'params-int-add',
        mode: 'params',
        sql: 'SELECT $1::int + $2::int AS total',
        params: ['41', '1'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-text-concat',
        mode: 'params',
        sql: "SELECT $1::text || '-' || $2::text AS label",
        params: ['alpha', 'bravo'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-null',
        mode: 'params',
        sql: 'SELECT $1::text IS NULL AS empty',
        params: [null],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-boolean',
        mode: 'params',
        sql: 'SELECT $1::boolean AND $2::boolean AS both',
        params: ['true', 'false'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-numeric',
        mode: 'params',
        sql: 'SELECT $1::numeric(10,2) + $2::numeric AS total',
        params: ['1.25', '2.5'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-timestamp',
        mode: 'params',
        sql: "SELECT $1::timestamp AT TIME ZONE 'UTC' AS ts",
        params: ['2024-03-04 12:34:56'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-jsonb',
        mode: 'params',
        sql: "SELECT $1::jsonb ->> 'a' AS a",
        params: ['{"a": "x"}'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-invalid-int',
        mode: 'params',
        sql: 'SELECT $1::int AS n',
        params: ['abc'],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'params-missing',
        mode: 'params',
        sql: 'SELECT $1::int AS n',
        params: [],
        setup: [],
        teardown: [],
        // `pg` routes an empty `values` array to a simple query
        // (`requiresPreparation()` returns `values.length > 0`), so PGlite never
        // receives a `Bind` here and reports the simple-query `42P02`. Real
        // PostgreSQL rejects `Bind` with fewer parameters than the statement
        // requires under `08P01`, which is what this repository reports. The
        // difference is an oracle limitation, not an engine disagreement.
        oracleLimitation:
            '`pg` sends an empty `values` array as a simple query, so the oracle never reaches `Bind` for this case. PostgreSQL rejects a `Bind` that supplies fewer parameters than the prepared statement requires with `08P01` (`ERRCODE_PROTOCOL_VIOLATION`), which is the reply this repository returns.',
    });
    {
        const rows = seededRows(gen, 3);
        cases.push({
            name: 'params-where-table',
            mode: 'params',
            setup: [
                `CREATE TABLE ${table(10)} (id int PRIMARY KEY, label text)`,
                `INSERT INTO ${table(10)} VALUES ${rows.map((row) => `(${row.id}, '${row.label}')`).join(', ')}`,
            ],
            sql: `SELECT label FROM ${table(10)} WHERE id = $1`,
            params: ['2'],
            teardown: drop(10),
        });
    }
    cases.push({
        name: 'prepare-reuse-add',
        mode: 'prepare',
        sql: 'SELECT $1::int * 2 AS doubled',
        params: ['21'],
        reuse: [['7'], ['0']],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'prepare-reuse-text',
        mode: 'prepare',
        sql: "SELECT $1::text || '!' AS shout",
        params: ['hi'],
        reuse: [['yo']],
        setup: [],
        teardown: [],
    });
    cases.push({
        name: 'prepare-reuse-null',
        mode: 'prepare',
        sql: "SELECT coalesce($1::text, 'fallback') AS v",
        params: [null],
        reuse: [['x']],
        setup: [],
        teardown: [],
    });
    {
        const rows = seededRows(gen, 2);
        cases.push({
            name: 'prepare-insert-returning',
            mode: 'prepare',
            setup: [`CREATE TABLE ${table(15)} (id int PRIMARY KEY, label text)`],
            sql: `INSERT INTO ${table(15)} VALUES ($1::int, $2::text) RETURNING id, label`,
            params: ['1', rows[0].label],
            reuse: [['2', rows[1].label]],
            teardown: drop(15),
        });
    }
    cases.push({
        name: 'prepare-update-returning',
        mode: 'prepare',
        setup: [
            `CREATE TABLE ${table(16)} (id int PRIMARY KEY, label text)`,
            `INSERT INTO ${table(16)} VALUES (1, 'one'), (2, 'two')`,
        ],
        sql: `UPDATE ${table(16)} SET label = $2::text WHERE id = $1::int RETURNING id, label`,
        params: ['1', 'uno'],
        reuse: [['2', 'dos']],
        teardown: drop(16),
    });
    cases.push({
        name: 'portal-rebind',
        mode: 'params',
        sql: 'SELECT $1::int AS n',
        params: ['1'],
        reuse: [['2'], ['3']],
        setup: [],
        teardown: [],
    });
    return cases.map((item) => ({ cluster: 'extended', setup: [], teardown: [], ...item }));
}

function joinCluster(gen) {
    const cases = [];
    const left = 'sqldiff.join_left';
    const right = 'sqldiff.join_right';
    const leftRows = seededRows(gen, 4);
    const rightRows = seededRows(gen, 4, 2);
    const setup = [
        `CREATE TABLE ${left} (id int PRIMARY KEY, label text, grp int)`,
        `CREATE TABLE ${right} (rid int PRIMARY KEY, rlabel text, grp int)`,
        `INSERT INTO ${left} VALUES ${leftRows.map((row, index) => `(${row.id}, '${row.label}', ${index % 2})`).join(', ')}`,
        `INSERT INTO ${right} VALUES ${rightRows.map((row, index) => `(${row.id}, '${row.label}', ${index % 2})`).join(', ')}`,
    ];
    const teardown = [`DROP TABLE IF EXISTS ${right} CASCADE`, `DROP TABLE IF EXISTS ${left} CASCADE`];
    const push = (name, sql) => cases.push({ name, setup, sql, teardown });

    push('inner-join-on', `SELECT l.id, r.rid FROM ${left} l JOIN ${right} r ON l.grp = r.grp ORDER BY l.id, r.rid`);
    push('inner-join-using', `SELECT l.id, r.rid FROM ${left} l JOIN ${right} r USING (grp) ORDER BY l.id, r.rid`);
    push('left-join', `SELECT l.id, r.rid FROM ${left} l LEFT JOIN ${right} r ON l.grp = r.grp ORDER BY l.id, r.rid`);
    push('right-join', `SELECT l.id, r.rid FROM ${left} l RIGHT JOIN ${right} r ON l.grp = r.grp ORDER BY r.rid, l.id`);
    push('full-join', `SELECT l.id, r.rid FROM ${left} l FULL JOIN ${right} r ON l.grp = r.grp ORDER BY l.id NULLS LAST, r.rid`);
    push('cross-join', `SELECT l.id, r.rid FROM ${left} l CROSS JOIN ${right} r ORDER BY l.id, r.rid`);
    push('natural-join', `SELECT l.id, r.rid FROM ${left} l NATURAL JOIN ${right} r ORDER BY l.id, r.rid`);
    push('natural-left-join', `SELECT l.id, r.rid FROM ${left} l NATURAL LEFT JOIN ${right} r ORDER BY l.id, r.rid`);
    push('natural-right-join', `SELECT l.id, r.rid FROM ${left} l NATURAL RIGHT JOIN ${right} r ORDER BY r.rid, l.id`);
    push('right-join-using', `SELECT l.id, r.rid FROM ${left} l RIGHT JOIN ${right} r USING (grp) ORDER BY r.rid, l.id`);
    push('full-join-filtered', `SELECT l.id, r.rid FROM ${left} l FULL JOIN ${right} r ON l.grp = r.grp WHERE l.id IS NOT NULL AND r.rid IS NOT NULL ORDER BY l.id, r.rid`);
    push('join-expression', `SELECT l.id, r.rid FROM ${left} l JOIN ${right} r ON l.id + r.rid = 7 ORDER BY l.id, r.rid`);
    push('join-with-where', `SELECT l.id, r.rid FROM ${left} l JOIN ${right} r ON l.grp = r.grp WHERE l.grp = 1 ORDER BY l.id, r.rid`);
    push('join-order-desc', `SELECT l.id, r.rid FROM ${left} l JOIN ${right} r ON l.grp = r.grp ORDER BY l.id DESC, r.rid DESC`);
    push('join-aggregate', `SELECT l.grp, count(*) AS n FROM ${left} l JOIN ${right} r ON l.grp = r.grp GROUP BY l.grp ORDER BY l.grp`);
    push('left-join-null-count', `SELECT count(*) AS missing FROM ${left} l LEFT JOIN ${right} r ON l.grp = r.grp WHERE r.rid IS NULL`);
    push('join-three-tables', `SELECT l.id, r.rid, l2.id FROM ${left} l JOIN ${right} r ON l.grp = r.grp JOIN ${left} l2 ON l2.id = r.rid - 2 ORDER BY l.id, r.rid, l2.id`);
    push('self-join', `SELECT a.id, b.id FROM ${left} a JOIN ${left} b ON a.grp = b.grp AND a.id < b.id ORDER BY a.id, b.id`);
    push('self-join-count', `SELECT count(*) AS n FROM ${left} a JOIN ${left} b ON a.grp = b.grp`);
    push('join-using-group-count', `SELECT count(*) AS n FROM ${left} l JOIN ${right} r USING (grp) WHERE l.grp = 0`);
    return cases.map((item) => ({ cluster: 'join', setup: [], teardown: [], ...item }));
}

function windowCluster(gen) {
    const cases = [];
    const table = 'sqldiff.window_rows';
    const amounts = ['10.00', '20.00', '20.00', '30.00', '40.00', '40.00'];
    const rows = amounts.map((amount, index) => `(${index + 1}, '${gen.pick(WORDS)}', ${index % 2}, ${amount})`);
    const setup = [
        `CREATE TABLE ${table} (id int PRIMARY KEY, label text, grp int, amount numeric(10,2))`,
        `INSERT INTO ${table} VALUES ${rows.join(', ')}`,
    ];
    const teardown = [`DROP TABLE IF EXISTS ${table} CASCADE`];
    const push = (name, sql) => cases.push({ name, setup, sql, teardown });

    push('row-number-order', `SELECT id, row_number() OVER (ORDER BY amount) AS rn FROM ${table} ORDER BY id`);
    push('rank-order', `SELECT id, rank() OVER (ORDER BY amount) AS r FROM ${table} ORDER BY id`);
    push('dense-rank-order', `SELECT id, dense_rank() OVER (ORDER BY amount) AS r FROM ${table} ORDER BY id`);
    push('percent-rank', `SELECT id, percent_rank() OVER (ORDER BY amount) AS p FROM ${table} ORDER BY id`);
    push('cume-dist', `SELECT id, cume_dist() OVER (ORDER BY amount) AS c FROM ${table} ORDER BY id`);
    push('ntile-two', `SELECT id, ntile(2) OVER (ORDER BY id) AS bucket FROM ${table} ORDER BY id`);
    push('ntile-four', `SELECT id, ntile(4) OVER (ORDER BY amount) AS bucket FROM ${table} ORDER BY id`);
    push('lag-one', `SELECT id, lag(amount) OVER (ORDER BY id) AS prev FROM ${table} ORDER BY id`);
    push('lag-default', `SELECT id, lag(amount, 1, 0) OVER (ORDER BY id) AS prev FROM ${table} ORDER BY id`);
    push('lead-one', `SELECT id, lead(amount) OVER (ORDER BY id) AS next FROM ${table} ORDER BY id`);
    push('lead-offset-two', `SELECT id, lead(amount, 2) OVER (ORDER BY id) AS next FROM ${table} ORDER BY id`);
    push('first-value', `SELECT id, first_value(amount) OVER (ORDER BY id) AS first FROM ${table} ORDER BY id`);
    push('last-value-default-frame', `SELECT id, last_value(amount) OVER (ORDER BY id) AS last FROM ${table} ORDER BY id`);
    push('last-value-unbounded', `SELECT id, last_value(amount) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last FROM ${table} ORDER BY id`);
    push('running-sum', `SELECT id, sum(amount) OVER (ORDER BY id) AS running FROM ${table} ORDER BY id`);
    push('running-sum-rows-frame', `SELECT id, sum(amount) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM ${table} ORDER BY id`);
    push('moving-average', `SELECT id, avg(amount) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS avg FROM ${table} ORDER BY id`);
    push('frame-following', `SELECT id, sum(amount) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS s FROM ${table} ORDER BY id`);
    push('partition-row-number', `SELECT id, grp, row_number() OVER (PARTITION BY grp ORDER BY id) AS rn FROM ${table} ORDER BY id`);
    push('partition-sum', `SELECT id, grp, sum(amount) OVER (PARTITION BY grp) AS s FROM ${table} ORDER BY id`);
    push('partition-rank', `SELECT id, grp, rank() OVER (PARTITION BY grp ORDER BY amount) AS r FROM ${table} ORDER BY id`);
    push('count-over-partition', `SELECT id, count(*) OVER (PARTITION BY grp) AS n FROM ${table} ORDER BY id`);
    push('multiple-windows', `SELECT id, row_number() OVER (ORDER BY id) AS rn, rank() OVER (ORDER BY amount) AS r FROM ${table} ORDER BY id`);
    push('window-in-subquery', `SELECT id, r FROM (SELECT id, rank() OVER (ORDER BY amount) AS r FROM ${table}) s WHERE r <= 3 ORDER BY id`);
    return cases.map((item) => ({ cluster: 'window', setup: [], teardown: [], ...item }));
}

function aggBoundaryCluster(gen) {
    const cases = [];
    const table = 'sqldiff.agg_rows';
    const empty = 'sqldiff.agg_empty';
    const rows = seededRows(gen, 6);
    const setup = [
        `CREATE TABLE ${table} (id int PRIMARY KEY, grp int, note text, amount numeric(10,2))`,
        `INSERT INTO ${table} VALUES ${rows.map((row, index) => `(${row.id}, ${index % 2}, '${row.label}', ${row.amount})`).join(', ')}`,
        `CREATE TABLE ${empty} (id int PRIMARY KEY, grp int, note text, amount numeric(10,2))`,
    ];
    const teardown = [`DROP TABLE IF EXISTS ${empty} CASCADE`, `DROP TABLE IF EXISTS ${table} CASCADE`];
    const push = (name, sql) => cases.push({ name, setup, sql, teardown });

    push('group-by-having', `SELECT grp, count(*) AS n FROM ${table} GROUP BY grp HAVING count(*) > 1 ORDER BY grp`);
    push('having-no-rows', `SELECT grp, count(*) AS n FROM ${table} GROUP BY grp HAVING count(*) > 100 ORDER BY grp`);
    push('group-by-empty-table', `SELECT grp, count(*) AS n FROM ${empty} GROUP BY grp ORDER BY grp`);
    push('empty-plain-aggregate', `SELECT count(*) AS n, sum(amount) AS s, max(amount) AS m FROM ${empty}`);
    push('grouping-sets-two', `SELECT grp, count(*) AS n FROM ${table} GROUP BY GROUPING SETS ((grp), ()) ORDER BY grp NULLS LAST`);
    push('grouping-sets-mixed', `SELECT grp, note, count(*) AS n FROM ${table} GROUP BY GROUPING SETS ((grp, note), (grp), ()) ORDER BY grp NULLS LAST, note NULLS LAST`);
    push('rollup', `SELECT grp, count(*) AS n FROM ${table} GROUP BY ROLLUP (grp) ORDER BY grp NULLS LAST`);
    push('cube', `SELECT grp, note, count(*) AS n FROM ${table} GROUP BY CUBE (grp, note) ORDER BY grp NULLS LAST, note NULLS LAST`);
    push('grouping-function', `SELECT grp, grouping(grp) AS g, count(*) AS n FROM ${table} GROUP BY ROLLUP (grp) ORDER BY grp NULLS LAST`);
    push('filter-count', `SELECT count(*) FILTER (WHERE grp = 1) AS n FROM ${table}`);
    push('filter-sum', `SELECT sum(amount) FILTER (WHERE grp = 0) AS s FROM ${table}`);
    push('filter-with-group-by', `SELECT grp, count(*) FILTER (WHERE amount > 20) AS n FROM ${table} GROUP BY grp ORDER BY grp`);
    push('filter-having', `SELECT grp, sum(amount) FILTER (WHERE note <> '') AS s FROM ${table} GROUP BY grp HAVING count(*) > 0 ORDER BY grp`);
    push('count-distinct', `SELECT count(DISTINCT grp) AS n FROM ${table}`);
    push('sum-distinct', `SELECT sum(DISTINCT amount) AS s FROM ${table}`);
    push('group-by-two-columns', `SELECT grp, note, count(*) AS n FROM ${table} GROUP BY grp, note ORDER BY grp, note`);
    push('aggregate-over-null', `SELECT count(amount) AS n, sum(amount) AS s FROM ${table} WHERE amount IS NULL`);
    return cases.map((item) => ({ cluster: 'agg-boundary', setup: [], teardown: [], ...item }));
}

function jsonCluster(gen) {
    const cases = [];
    const table = 'sqldiff.json_rows';
    const first = gen.int(10, 19);
    const setup = [
        `CREATE TABLE ${table} (id int PRIMARY KEY, doc jsonb, tags text[], nums int[])`,
        `INSERT INTO ${table} VALUES (1, '{"a": ${first}, "b": "x", "list": [10, 20, 30]}', '{alpha,bravo,charlie}', '{1,2,3}')`,
        `INSERT INTO ${table} VALUES (2, '{"a": {"b": ${first + 1}}, "b": null, "list": [40]}', '{delta}', '{4,5}')`,
        `INSERT INTO ${table} VALUES (3, '{"a": ${first + 2}, "nested": {"k": "v"}}', '{}', '{}')`,
    ];
    const teardown = [`DROP TABLE IF EXISTS ${table} CASCADE`];
    const push = (name, sql) => cases.push({ name, setup, sql, teardown });

    push('arrow-text', `SELECT doc -> 'a' AS v FROM ${table} WHERE id = 1`);
    push('arrow-array-index', `SELECT doc -> 'list' -> 0 AS v FROM ${table} WHERE id = 1`);
    push('arrow-chain', `SELECT doc -> 'list' -> 2 AS v FROM ${table} WHERE id = 1`);
    push('arrow2-text', `SELECT doc ->> 'b' AS v FROM ${table} WHERE id = 1`);
    push('arrow2-nested', `SELECT doc -> 'a' ->> 'b' AS v FROM ${table} WHERE id = 2`);
    push('hash-arrow', `SELECT doc #> '{a}' AS v FROM ${table} WHERE id = 2`);
    push('hash-arrow-text', `SELECT doc #>> '{a,b}' AS v FROM ${table} WHERE id = 2`);
    push('hash-arrow-array', `SELECT doc #> '{list,1}' AS v FROM ${table} WHERE id = 1`);
    push('path-query', `SELECT jsonb_path_query(doc, '$.a') AS v FROM ${table} WHERE id = 1`);
    push('path-query-array', `SELECT jsonb_path_query(doc, '$.list[*]') AS v FROM ${table} WHERE id = 1`);
    push('path-query-filter', `SELECT jsonb_path_query(doc, '$.list[*] ? (@ > 15)') AS v FROM ${table} WHERE id = 1`);
    push('path-exists-true', `SELECT jsonb_path_exists(doc, '$.a') AS v FROM ${table} WHERE id = 3`);
    push('path-exists-false', `SELECT jsonb_path_exists(doc, '$.missing') AS v FROM ${table} WHERE id = 3`);
    push('array-length', `SELECT jsonb_array_length(doc -> 'list') AS n FROM ${table} WHERE id = 1`);
    push('type-of', `SELECT jsonb_typeof(doc -> 'a') AS t FROM ${table} WHERE id = 1`);
    push('contains', `SELECT doc @> '{"a": ${first}}' AS v FROM ${table} WHERE id = 1`);
    push('object-keys', `SELECT k FROM (SELECT jsonb_object_keys(doc) AS k FROM ${table} WHERE id = 1) s ORDER BY k`);
    push('array-subscript', `SELECT tags[2] AS v FROM ${table} WHERE id = 1`);
    push('array-slice', `SELECT tags[1:2] AS v FROM ${table} WHERE id = 1`);
    push('array-slice-open-end', `SELECT nums[2:] AS v FROM ${table} WHERE id = 1`);
    push('array-slice-empty', `SELECT nums[3:2] AS v FROM ${table} WHERE id = 2`);
    push('array-subscript-out-of-range', `SELECT tags[9] AS v FROM ${table} WHERE id = 3`);
    return cases.map((item) => ({ cluster: 'json', setup: [], teardown: [], ...item }));
}

function generateCorpus(seed) {
    const gen = factory(seed);
    const cases = [
        ...ddlCluster(gen),
        ...dmlCluster(gen),
        ...exprCluster(gen),
        ...aggCluster(gen),
        ...castCluster(gen),
        ...transactionCluster(gen),
        ...cursorCluster(gen),
        ...castMatrixCluster(gen),
        ...constraintCluster(gen),
        ...joinCluster(gen),
        ...windowCluster(gen),
        ...aggBoundaryCluster(gen),
        ...jsonCluster(gen),
        ...extendedCluster(gen),
    ];
    return cases.map((item, index) => ({ index, setup: [], teardown: [], ...item }));
}

// -------------------------------------------------------------------------------
// Command line.
// -------------------------------------------------------------------------------
function argumentsFrom(argv) {
    const options = {
        seed: DEFAULT_SEED,
        count: DEFAULT_COUNT,
        only: null,
        check: false,
        updateBaseline: false,
        help: false,
    };
    const values = new Set(['--seed', '--count', '--only']);
    const flags = new Set(['--check', '--update-baseline', '--help', '-h']);
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (values.has(flag)) {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`${flag} needs a value`);
            if (flag === '--seed') options.seed = Number(value);
            else if (flag === '--count') options.count = Number(value);
            else options.only = value;
            index += 1;
            continue;
        }
        if (!flags.has(flag)) throw new Error(`unknown option: ${flag}`);
        if (flag === '--check') options.check = true;
        else if (flag === '--update-baseline') options.updateBaseline = true;
        else options.help = true;
    }
    if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error(`invalid --seed value`);
    if (!Number.isInteger(options.count) || options.count <= 0) throw new Error(`invalid --count value`);
    if (options.check && options.updateBaseline) throw new Error('--check and --update-baseline cannot be combined');
    if (options.only && (options.check || options.updateBaseline)) {
        throw new Error('--only cannot be combined with --check or --update-baseline');
    }
    return options;
}

const options = argumentsFrom(process.argv.slice(2));
if (options.help) {
    console.log('usage: node sql-diff.mjs [--seed <uint32>] [--count <n>] [--only <case-name>] [--check | --update-baseline]');
    process.exit(0);
}

// -------------------------------------------------------------------------------
// Corpus identity. The seed and the statement generator fully determine the
// corpus, so the digest is computed before any process starts.
// -------------------------------------------------------------------------------
const corpus = generateCorpus(options.seed);
const digest = crypto.createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const selected = options.only ? corpus.filter((item) => item.name === options.only) : corpus;
if (options.only && selected.length === 0) throw new Error(`no case named '${options.only}'`);

if (corpus.length !== options.count) {
    process.stderr.write(
        [
            `corpus gate failed: the generator produced ${corpus.length} cases but --count declared ${options.count}`,
            `  seed ${options.seed}`,
            `  digest ${digest}`,
            '',
            'The corpus is generated from the seed, so --count must equal the generated length.',
            '',
        ].join('\n'),
    );
    process.exit(1);
}

// -------------------------------------------------------------------------------
// Known differences. The baseline is the only allowed set of differences. Each
// entry names one case, why it is expected to differ and the exact signal seen
// when the baseline was generated. `--check` runs this before any engine starts.
// -------------------------------------------------------------------------------
function loadBaseline() {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read the differential baseline at ${baselineFile}: ${error.message}`);
    }
    if (parsed.version !== BASELINE_VERSION) {
        throw new Error(`baseline version ${parsed.version} is not supported, expected ${BASELINE_VERSION}`);
    }
    return parsed;
}

function identityProblems(baseline, expected) {
    const problems = [];
    if (baseline.seed !== expected.seed) problems.push(`seed: baseline ${baseline.seed}, current ${expected.seed}`);
    if (baseline.count !== expected.count) problems.push(`count: baseline ${baseline.count}, current ${expected.count}`);
    if (baseline.digest !== expected.digest) {
        problems.push(`corpus digest: baseline ${baseline.digest}, current ${expected.digest}`);
    }
    return problems;
}

const baseline = options.check ? loadBaseline() : null;
if (baseline) {
    const problems = identityProblems(baseline, { seed: options.seed, count: options.count, digest });
    if (problems.length > 0) {
        process.stderr.write(
            [
                'corpus gate failed: the generated corpus no longer matches the baseline',
                ...problems.map((problem) => `  ${problem}`),
                '',
                'The corpus changed without regenerating the baseline. Review the change and run:',
                `  pnpm corpus -- --seed ${options.seed} --count ${options.count} --update-baseline`,
                '',
            ].join('\n'),
        );
        process.exit(1);
    }
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

function repoFields(fields) {
    return fields.map((field) => [field.kind, field.value]);
}

function runRepo(sql) {
    try {
        const report = connection.executeReport(sql);
        return {
            results: normalizeRepo(report.results),
            error: report.error ? { code: report.error.code, message: report.error.message } : null,
            fields: report.error ? repoFields(report.error.fields) : [],
        };
    } catch (error) {
        return { results: [], error: repoErrorOf(error), fields: [] };
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
        const oracleFields = oracle.error?.ordered ?? [];
        const fieldsMatch = oracle.error && repo.error && JSON.stringify(repo.fields) === JSON.stringify(oracleFields);
        if (left === right && fieldsMatch) {
            return { matched: true, noticeCount: oracle.notices.length };
        }
        return {
            matched: false,
            reason: oracle.error ? 'error-shape' : 'error-missing',
            statement,
            repo: repo.error ? { error: right, fields: repo.fields } : { results: repo.results },
            pglite: { error: left, fields: oracleFields, results: oracle.results, raw: oracle.raw ?? null },
        };
    }
    const matched = JSON.stringify(repo.results) === JSON.stringify(oracle.results);
    if (matched) return { matched: true, noticeCount: oracle.notices.length };
    return {
        matched: false,
        reason: 'result-shape',
        statement,
        repo: { results: repo.results },
        pglite: { results: oracle.results, raw: oracle.raw ?? null },
    };
}

// -------------------------------------------------------------------------------
// Extended-query comparison. The oracle is `pg` against its own PGlite socket,
// so parameters, prepared-statement reuse and portal rebinding all travel over
// real Parse/Bind/Execute/Sync frames. `pg` reports the command verb and row
// count separately, so the repository tag is normalized to the same pair.
// -------------------------------------------------------------------------------
function tagRowCount(tag) {
    const parts = tag.split(' ');
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && /^\d+$/.test(last)) return Number(last);
    return null;
}

function normalizeExtendedRepo(results) {
    return results.map((result) => ({
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => row.values),
        verb: result.tag.split(' ')[0],
        rowCount: tagRowCount(result.tag),
    }));
}

async function bothExtended(sql) {
    const oracle = await call('extended-simple', { sql });
    let failure = null;
    try {
        connection.execute(sql);
    } catch (error) {
        failure = repoErrorOf(error);
    }
    if (oracle.error || failure) {
        throw new Error(
            `extended setup failed on '${sql}': oracle ${oracle.error ? `${oracle.error.code}: ${oracle.error.message}` : 'ok'} / repository ${failure ? `${failure.code}: ${failure.message}` : 'ok'}`,
        );
    }
}

async function runExtended(item) {
    const paramSets = [item.params, ...(item.reuse ?? [])];
    const name = item.mode === 'prepare' ? `sqldiff_ext_${item.index}` : null;
    const oracle = await call('extended', { text: item.sql, paramSets, name });
    let repo;
    try {
        if (name) {
            const statement = connection.prepare(item.sql, []);
            const rounds = [];
            for (const values of paramSets) rounds.push(...normalizeExtendedRepo(statement.execute(values)));
            statement.close();
            repo = { results: rounds, error: null };
        } else {
            const rounds = [];
            for (const values of paramSets) rounds.push(...normalizeExtendedRepo(connection.executeWithParams(item.sql, values, [])));
            repo = { results: rounds, error: null };
        }
    } catch (error) {
        repo = { results: [], error: repoErrorOf(error) };
    }
    return { oracle, repo };
}

function extendedDiff(item, paramSets, oracle, repo) {
    if (oracle.error || repo.error) {
        const left = oracle.error ? `${oracle.error.code}: ${oracle.error.message}` : 'ok';
        const right = repo.error ? `${repo.error.code}: ${repo.error.message}` : 'ok';
        if (left === right && oracle.error && repo.error) return { matched: true, noticeCount: 0 };
        return {
            matched: false,
            reason: oracle.error ? 'error-shape' : 'error-missing',
            statement: item.sql,
            params: paramSets,
            repo: repo.error ? { error: right } : { results: repo.results },
            pglite: { error: left, results: oracle.results, raw: oracle.raw ?? null },
        };
    }
    if (JSON.stringify(repo.results) === JSON.stringify(oracle.results)) return { matched: true, noticeCount: 0 };
    return {
        matched: false,
        reason: 'result-shape',
        statement: item.sql,
        params: paramSets,
        repo: { results: repo.results },
        pglite: { results: oracle.results, raw: oracle.raw ?? null },
    };
}

// -------------------------------------------------------------------------------
// Run.
// -------------------------------------------------------------------------------
// The staging schema is dropped and recreated so a rerun starts from the same
// state. Every statement is schema-qualified, so `public` stays untouched.
for (const sql of ['DROP SCHEMA IF EXISTS sqldiff CASCADE', 'CREATE SCHEMA sqldiff', ...STAGE_SETUP]) {
    await both(sql);
}

const diffs = [];
const notices = [];
let executed = 0;

for (const item of selected) {
    const extended = item.cluster === 'extended';
    for (const sql of item.setup) await (extended ? bothExtended(sql) : both(sql));
    executed += 1;
    let outcome;
    if (extended) {
        const paramSets = [item.params, ...(item.reuse ?? [])];
        const measured = await runExtended(item);
        outcome = extendedDiff(item, paramSets, measured.oracle, measured.repo);
    } else {
        const measured = await both(item.sql);
        outcome = statementDiff(item, measured.oracle, measured.repo);
    }
    if (outcome.noticeCount > 0) {
        notices.push({ cluster: item.cluster, name: item.name, count: outcome.noticeCount });
    }
    if (!outcome.matched) {
        diffs.push({
            id: item.index,
            cluster: item.cluster,
            name: item.name,
            statement: outcome.statement,
            ...(outcome.params ? { params: outcome.params } : {}),
            ...(item.oracleLimitation ? { oracleLimitation: item.oracleLimitation } : {}),
            reason: outcome.reason,
            repo: outcome.repo,
            pglite: outcome.pglite,
            repro: `node projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed ${options.seed} --only ${item.name}`,
        });
    }
    // A failed batch inside BEGIN leaves the session aborted on both sides.
    // End it before teardown so the next case starts from the same state.
    if (!extended) await both('ROLLBACK');
    for (const sql of item.teardown) await (extended ? bothExtended(sql) : both(sql));
}

// Isolation assertion: the corpus is only allowed to touch `sqldiff`. Both
// engines read the same catalog count, so a statement that slipped into
// `public` fails the gate instead of silently changing a frozen table.
const PUBLIC_OBJECTS = "SELECT count(*) AS c FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')";
const isolation = await both(PUBLIC_OBJECTS);

// -------------------------------------------------------------------------------
// Client-observable gaps. Each probe reads the same reply twice: from PGlite
// through `execProtocolRaw` and from this client through `executeReport`. A
// `fixed` status means the ordered fields and bytes agree.
// -------------------------------------------------------------------------------
const gaps = [];

{
    const sql = 'DROP TABLE IF EXISTS gap_probe_missing';
    const oracleNotice = await call('query', { sql });
    const report = connection.executeReport(sql);
    const repoNotices = report.notices.map((notice) => repoFields(notice.fields));
    const pgliteNotices = oracleNotice.notices.map((notice) => notice.ordered);
    gaps.push({
        name: 'notice-surfaced',
        surface: 'NoticeResponse',
        status: JSON.stringify(repoNotices) === JSON.stringify(pgliteNotices) ? 'fixed' : 'open',
        statement: sql,
        before: 'NoticeResponse was read off the socket and dropped, so NOTICE and WARNING text never reached the caller.',
        repo: { notices: repoNotices },
        pglite: { notices: pgliteNotices, raw: oracleNotice.notices.map((notice) => notice.raw) },
        reason: '`executeReport` returns every notice in wire order and `takeNotices` drains the same notices after `execute`.',
    });
}

{
    const sql = "SELECT 'oops'::int";
    const oracleDetail = await call('query', { sql });
    const report = connection.executeReport(sql);
    const repoError = { code: report.error.code, message: report.error.message, fields: repoFields(report.error.fields) };
    const pgliteError = { code: oracleDetail.error.code, message: oracleDetail.error.message, fields: oracleDetail.error.ordered };
    gaps.push({
        name: 'error-fields-kept',
        surface: 'ErrorResponse fields',
        status: JSON.stringify(repoError) === JSON.stringify(pgliteError) ? 'fixed' : 'open',
        statement: sql,
        before: 'ErrorResponse was reduced to C and M, so position P, detail D, hint H and the object name fields never reached the caller.',
        repo: { error: repoError },
        pglite: { error: pgliteError, raw: oracleDetail.error.raw },
        reason: 'Every ErrorResponse field survives decoding in wire order, so structured diagnostics and the psql caret are available.',
    });
}

{
    const sql = 'SELECT 1 AS a; SELECT 1 / 0';
    const oraclePartial = await call('query', { sql });
    const report = connection.executeReport(sql);
    const repoPartial = {
        results: normalizeRepo(report.results),
        error: { code: report.error.code, message: report.error.message, fields: repoFields(report.error.fields) },
    };
    const pglitePartial = {
        results: oraclePartial.results,
        error: { code: oraclePartial.error.code, message: oraclePartial.error.message, fields: oraclePartial.error.ordered },
    };
    gaps.push({
        name: 'partial-results-kept',
        surface: 'multi-statement error',
        status: JSON.stringify(repoPartial) === JSON.stringify(pglitePartial) ? 'fixed' : 'open',
        statement: sql,
        before: '`execute` threw on the first error and discarded the StatementResult entries decoded for earlier statements of the same batch.',
        repo: repoPartial,
        pglite: { ...pglitePartial, tags: oraclePartial.tags, raw: oraclePartial.error.raw },
        reason: '`executeReport` keeps every completed result before the error, matching the PGlite reply order T, D, C, E, Z.',
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
    boundary.push({ id: `boundary/${name}`, name, feature, statement: null, repoError: error, repoResults: null });
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
    boundary.push({ id: `boundary/${name}`, name, feature, statement, repoError, repoResults });
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
// Gate.
// -------------------------------------------------------------------------------
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function repoText(side) {
    return side.error ? `error ${side.error}` : `results ${JSON.stringify(side.results)}`;
}

function pgliteText(side) {
    return side.error ? `error ${side.error}` : `results ${JSON.stringify(side.results)}`;
}

function corpusEntry(diff) {
    const raw = diff.pglite.raw;
    const signal = [`repo ${repoText(diff.repo)}`, `pglite ${pgliteText(diff.pglite)}`, raw == null ? 'raw none' : `raw sha256:${sha256(raw)}`];
    let reason;
    let detail;
    if (diff.oracleLimitation) {
        reason = 'oracle-limitation';
        detail = diff.oracleLimitation;
    } else if (diff.repo.error && diff.pglite.error) {
        reason = diff.repo.error.includes('unsupported:') ? 'not-implemented' : 'oracle-disagreement';
        detail = `both engines reject the statement with different replies: this repository ${diff.repo.error}, PGlite ${diff.pglite.error}`;
    } else if (diff.repo.error) {
        reason = 'structured-rejection';
        detail = `this repository rejects the statement: ${diff.repo.error}`;
    } else if (diff.pglite.error) {
        reason = 'oracle-disagreement';
        detail = `PGlite rejects the statement while this repository accepts it: ${diff.pglite.error}`;
    } else {
        reason = 'oracle-disagreement';
        detail = 'both sides answer the statement but decode different values';
    }
    return {
        id: diff.id,
        cluster: diff.cluster,
        name: diff.name,
        statement: diff.statement,
        ...(diff.params ? { params: diff.params } : {}),
        kind: 'difference',
        reason,
        detail,
        signal,
    };
}

function boundaryEntry(item) {
    return {
        id: item.id,
        cluster: 'boundary',
        name: item.name,
        statement: item.statement,
        kind: 'boundary',
        reason: BOUNDARY_REASONS[item.name] ?? 'out-of-scope',
        detail: `outside the declared surface: ${item.feature}`,
        signal: [item.repoError ? `repo error ${item.repoError}` : `repo results ${JSON.stringify(item.repoResults)}`],
    };
}

function observedDifferences() {
    const observed = diffs.map((diff) => ({ entry: corpusEntry(diff), diff }));
    for (const item of boundary) {
        if (item.repoError) observed.push({ entry: boundaryEntry(item), boundary: item });
    }
    return observed;
}

function entryKey(entry) {
    return `${entry.kind}|${entry.id}|${entry.statement ?? entry.name}`;
}

function observedOutput(observed) {
    const lines = [`#${observed.entry.id} [${observed.entry.cluster}] ${observed.entry.name}`];
    if (observed.boundary) {
        lines.push(`  statement: ${observed.boundary.statement ?? '(frame encoding probe, no SQL reaches PGlite)'}`);
        lines.push(`  this repository: ${observed.entry.signal[0].replace(/^repo /, '')}`);
        lines.push('  PGlite: not reached, the client refuses to encode the frame');
        lines.push('  PGlite raw reply: none');
    } else {
        const diff = observed.diff;
        lines.push(`  statement: ${diff.statement}`);
        if (diff.params) lines.push(`  parameters: ${JSON.stringify(diff.params)}`);
        lines.push(`  this repository: ${repoText(diff.repo)}`);
        lines.push(`  PGlite: ${pgliteText(diff.pglite)}`);
        lines.push(`  PGlite raw reply: ${diff.pglite.raw ?? 'none'}`);
        lines.push(`  smallest repro: ${diff.repro}`);
    }
    return lines;
}

function describeUnexpected(observed) {
    return [
        'unexpected difference that the known-difference baseline does not explain',
        ...observedOutput(observed),
        `  classification: ${observed.entry.reason} (${observed.entry.detail})`,
    ].join('\n');
}

function describeChanged(expected, observed) {
    return [
        `known difference changed shape: #${observed.entry.id} [${observed.entry.cluster}] ${observed.entry.name}`,
        ...observedOutput(observed).slice(1),
        `  baseline signal: ${expected.signal.join(' | ')}`,
        `  current signal:  ${observed.entry.signal.join(' | ')}`,
    ].join('\n');
}

function describeStale(entry) {
    return [
        `baseline entry no longer differs: #${entry.id} [${entry.cluster}] ${entry.name}`,
        `  statement: ${entry.statement ?? '(frame encoding probe, no SQL reaches PGlite)'}`,
        `  the case now matches PGlite, drop it with: pnpm corpus -- --seed ${options.seed} --count ${options.count} --update-baseline`,
    ].join('\n');
}

function checkBaseline(entries, observed) {
    const listed = new Map(entries.map((entry) => [entryKey(entry), entry]));
    const seen = new Set();
    const problems = [];
    let matched = 0;
    for (const item of observed) {
        const key = entryKey(item.entry);
        seen.add(key);
        const expected = listed.get(key);
        if (!expected) {
            problems.push(describeUnexpected(item));
        } else if (JSON.stringify(expected.signal) !== JSON.stringify(item.entry.signal)) {
            problems.push(describeChanged(expected, item));
        } else {
            matched += 1;
        }
    }
    for (const entry of entries) {
        if (!seen.has(entryKey(entry))) problems.push(describeStale(entry));
    }
    return { problems, matched };
}

function isolationProblems() {
    const countOf = (side) => {
        const value = side?.results?.[0]?.rows?.[0]?.[0];
        return value === undefined || value === null ? null : Number(value);
    };
    const oracle = countOf(isolation.oracle);
    const repo = countOf(isolation.repo);
    if (oracle === null || repo === null || Number.isNaN(oracle) || Number.isNaN(repo)) {
        return { oracle, repo, problems: [`could not measure the public schema object count (oracle ${oracle}, repository ${repo})`] };
    }
    if (oracle > 0 || repo > 0) {
        return { oracle, repo, problems: [`the corpus wrote ${oracle} oracle and ${repo} repository object(s) into the public schema`] };
    }
    return { oracle, repo, problems: [] };
}

function reasonCounts(entries) {
    const counts = {};
    for (const reason of BASELINE_REASONS) counts[reason] = 0;
    for (const entry of entries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    return counts;
}

const observed = observedDifferences();
const isolationState = isolationProblems();

if (options.updateBaseline) {
    if (isolationState.problems.length > 0) {
        process.stderr.write(`baseline not written: ${isolationState.problems.join('\n')}\n`);
        process.exit(1);
    }
    const entries = observed
        .map((item) => item.entry)
        .sort((left, right) => left.kind.localeCompare(right.kind) || String(left.id).localeCompare(String(right.id)));
    const file = {
        version: BASELINE_VERSION,
        seed: options.seed,
        count: options.count,
        digest,
        engines: { pglite: PGLITE_VERSION },
        entries,
    };
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(file, null, 2)}\n`);
    const counts = reasonCounts(entries);
    console.log(
        [
            `baseline written: ${path.relative(repositoryRoot, baselineFile)}`,
            `seed=${options.seed} count=${options.count} digest=${digest}`,
            `entries: ${entries.length} (${Object.entries(counts).map(([reason, value]) => `${reason} ${value}`).join(', ')})`,
            `executed ${executed}, differences ${diffs.length}, boundary rejections ${observed.length - diffs.length}, public objects ${isolationState.oracle}/${isolationState.repo}`,
        ].join('\n'),
    );
    process.exit(0);
}

if (options.check) {
    const result = checkBaseline(baseline.entries, observed);
    const problems = [...isolationState.problems, ...result.problems];
    const ok = problems.length === 0;
    const summary = ok
        ? [
              `corpus gate ok: seed ${options.seed} count ${options.count} digest ${digest}`,
              `${corpus.length} cases: ${executed} executed / ${diffs.length} differences / ${boundary.length} boundary probes`,
              `known differences: ${result.matched} matched the baseline`,
              `public schema objects after the run: oracle ${isolationState.oracle}, repository ${isolationState.repo}`,
          ]
        : [
              `corpus gate failed: ${problems.length} problem(s), ${result.matched} known differences matched`,
              `seed ${options.seed} count ${options.count} digest ${digest}`,
              '',
              problems.join('\n\n'),
          ];
    const rendered = summary.join('\n');
    if (!ok) {
        process.stderr.write(`${rendered}\n`);
        process.exit(1);
    }
    console.log(rendered);
    process.exit(0);
}

// -------------------------------------------------------------------------------
// Report.
// -------------------------------------------------------------------------------
const clusters = {};
for (const item of corpus) clusters[item.cluster] = (clusters[item.cluster] ?? 0) + 1;
const gated = fs.existsSync(knownCases) ? (JSON.parse(fs.readFileSync(knownCases, 'utf8')).length ?? 0) : 0;
const baselineEntries = fs.existsSync(baselineFile) ? loadBaseline().entries : [];

const report = {
    seed: options.seed,
    engine: `PGlite ${PGLITE_VERSION} through execProtocolRaw and an independent protocol decoder`,
    corpus: { total: corpus.length, clusters, digest },
    executed,
    diffs,
    boundary,
    gaps,
    notices,
    gated,
    isolation: { publicObjects: { oracle: isolationState.oracle, repo: isolationState.repo } },
    baseline: {
        path: path.relative(repositoryRoot, baselineFile),
        entries: baselineEntries.length,
        reasons: reasonCounts(baselineEntries),
    },
};

// `--only` is a repro switch: it must not overwrite the checked-in report with
// a single-case run.
if (!options.only) {
    fs.mkdirSync(path.dirname(reportJson), { recursive: true });
    fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 4)}\n`);
}

function renderResults(results) {
    if (!results || results.length === 0) return '[]';
    return results.map((result) => `[${result.tag}] ${JSON.stringify(result.rows)}`).join('; ');
}

const differenceEntries = new Map(
    observed.filter((item) => !item.boundary).map((item) => [item.entry.id, item.entry]),
);

const lines = [
    '# SQL compatibility gaps against PGlite',
    '',
    `Generated by \`projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed ${report.seed}\`.`,
    'Expectations are read from PGlite 0.5.15 through `execProtocolRaw` with an independent',
    'protocol decoder. The `extended` cluster is answered by the `pg` driver over a real',
    'Parse/Bind/Execute/Sync session against a separate PGlite socket. The repository side',
    'is the installed client from `projects/postgres.ts`, so this repository is never its',
    'own reference.',
    '',
    '## Corpus',
    '',
    `- ${corpus.length} statements: ${Object.entries(clusters).map(([name, count]) => `${name} ${count}`).join(', ')}`,
    `- corpus digest \`${digest}\``,
    '- every statement runs serially on the staging schema `sqldiff`, never on `public`',
    `- public schema objects after the run: oracle ${isolationState.oracle}, repository ${isolationState.repo}`,
    '',
    '## Differences found',
    '',
    ...(diffs.length === 0 ? ['No statement in the declared surface differs from PGlite.', ''] : []),
    ...diffs.map((diff) => {
        const entry = differenceEntries.get(diff.id);
        return [
            `### ${diff.cluster}/${diff.name}`,
            '',
            `- statement: \`${diff.statement}\``,
            `- this repository: \`${JSON.stringify(diff.repo)}\``,
            `- PGlite: \`${JSON.stringify(diff.pglite)}\``,
            ...(entry ? [`- classification: \`${entry.reason}\` — ${entry.detail}`] : []),
            `- smallest repro: \`${diff.repro}\``,
            '',
        ].join('\n');
    }),
    '## Client-surface gaps',
    '',
    'Each row compares the observable reply of this client with the same reply read from',
    'PGlite through `execProtocolRaw`. A row is `fixed` only when the field order and the',
    'payload bytes match.',
    '',
    ...gaps.map((gap) => [
        `### ${gap.name} — ${gap.status}`,
        '',
        `- surface: ${gap.surface}`,
        `- statement: \`${gap.statement}\``,
        `- before the fix: ${gap.before}`,
        `- this repository now: \`${JSON.stringify(gap.repo)}\``,
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
    `- fixed seed \`${report.seed}\` and count \`${corpus.length}\`, corpus digest \`${digest}\``,
    `- known-difference baseline: ${baselineEntries.length} entries (${Object.entries(reasonCounts(baselineEntries)).map(([reason, count]) => `${reason} ${count}`).join(', ')})`,
    `- client-surface assertions frozen in \`cases/sql-diff.json\`: ${gated}`,
    `- run \`pnpm corpus -- --seed ${report.seed} --count ${options.count} --check\` in CI`,
    `- regenerate with \`pnpm corpus -- --seed ${report.seed} --count ${options.count} --update-baseline\``,
    '',
];

if (!options.only) fs.writeFileSync(reportMarkdown, `${lines.join('\n')}\n`);

console.log(JSON.stringify({
    seed: report.seed,
    corpus: report.corpus,
    executed,
    diffs: diffs.length,
    gaps: gaps.length,
    fixed: gaps.filter((gap) => gap.status === 'fixed').length,
    boundary: boundary.length,
    gated,
    isolation: report.isolation,
    baseline: report.baseline,
    report: path.relative(repositoryRoot, reportJson),
}, null, 4));

process.exit(0);
