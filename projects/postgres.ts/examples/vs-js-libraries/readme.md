# vs-js-libraries

Conformance and side-by-side throughput of `@yydb/postgres` against the
[`pg`](https://node-postgres.com/) driver. Both clients talk to the same product
server over loopback, so the comparison isolates the client path.

- `pg` — baseline (`1.00x`)
- `@yydb/postgres` — native synchronous client (`loadNative().connect`)

## Prerequisites

Run `pnpm install` once at the repository root. This example imports the product
through `packages/postgres/dist` and resolves `pg` from the root `node_modules`.
Run `pnpm build` only when `packages/postgres/dist` or the platform binding is
missing.

## Layout

- `src/` — timing helpers, SQL constants, the child-server launcher, and the
  native and `pg` client wrappers
- `tests/` — `conformance.mjs` (cross-client reads and prepared statements),
  `benchmark.mjs` (relative and absolute throughput),
  `benchmark-vs-postgres16.mjs` (product server against a real PostgreSQL 16),
  and `profile-point.mjs` (per-statement fixed-cost breakdown from a server-side
  CPU profile)
- `reports/` — captured conformance and benchmark results

## Correctness

One product server is shared by both clients. The test creates the table through
`pg`, inserts through each client and reads through the other, compares a
prepared statement on both sides, and checks full scan ordering and exact cell
values.

```shell
pnpm --dir projects/postgres.ts/examples/vs-js-libraries test
```

## Benchmark

```shell
pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark
```

Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`,
`BENCH_PREPARED=500`, `BENCH_ROUNDS=3`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`,
`BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`,
`BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`,
`BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`,
`BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`,
`BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`,
`BENCH_RR_ROWS=10`, `BENCH_BULK=20`, `BENCH_BULK_ROWS=10`, `BENCH_COPY=2000`,
`BENCH_SAVEPOINT=20`, `BENCH_NOTIFY=100`, `BENCH_CURSOR=10`,
`BENCH_CURSOR_PAGE=50`. Override any of them in the environment. Set
`BENCH_ONLY=update,delete,temp-table` to run only the named workloads.

Workloads (scenario set aligned with the SQLite repository's `vs-js-libraries`):

- `insert` — sequential parameterized inserts of `BENCH_ROWS` rows
- `select-point` — `BENCH_POINT` parameterized (extended-protocol) point selects
- `simple-point` — `BENCH_SIMPLE` unparameterized point selects through the simple-query protocol
- `select-scan` — one ordered scan over `BENCH_SCAN` seeded rows
- `prepared-point` — one prepared point statement executed `BENCH_PREPARED` times
- `tx-prepared` — the same prepared statement executed `BENCH_TX_PREPARED` times inside one transaction
- `point-uk` — `BENCH_POINT` parameterized point selects on the `UNIQUE` column
- `order-limit` — `BENCH_ORDER` ordered-index `ORDER BY val DESC, id LIMIT 20` statements
- `group-by` — `BENCH_GROUP` `GROUP BY grp` aggregation statements over the unindexed `grp`
- `join` — `BENCH_JOIN` `INNER JOIN bench_join ON id` statements filtered by `grp`
- `batch-insert` — `BENCH_ROWS` rows through literal multi-row `INSERT ... VALUES (...), (...)` statements of `BENCH_BATCH` rows
- `batch-insert-params` — the same rows through `$n`-bound multi-row inserts
- `distinct`, `aggregate`, `subquery`, `index-range`, `update`, `delete`, `rollback` — shared SQL-feature rows from `benchmark-vs-postgres16.mjs`
- `upsert` — `BENCH_UPSERT` `INSERT ... ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val` statements
- `update-returning` — `BENCH_RETURNING` `UPDATE ... RETURNING id, val` statements
- `wide-row` — `BENCH_WIDE` point reads where `pad` is `NULL` on half the ids and 4 KiB on id 1
- `error-constraint` — `BENCH_ERROR` duplicate-key inserts, timing the error round trip
- `portal-batch-fetch` — `BENCH_PORTAL` drains of the ordered `bench` scan in `BENCH_PAGE`-row
  `Execute` batches inside one transaction; `pg` has no `Execute` row limit, so its side
  runs `DECLARE`/`FETCH` over the same statement
- `temp-table` — `BENCH_TEMP` cycles of `CREATE TEMP TABLE` / 20-row `INSERT` / `SELECT` /
  `DROP TABLE` on one connection
- `multi-statement` — `BENCH_MULTI` simple-query messages carrying `BENCH_MULTI_STATEMENTS`
  statements each
- `constraint-violation-rollback` — `BENCH_CVR` transactions that hit a duplicate-key
  `23505` and then roll back
- `repeatable-read-tx` — `BENCH_RR` `BEGIN ISOLATION LEVEL REPEATABLE READ` transactions
  with `BENCH_RR_ROWS` point selects each
- `update-delete-bulk` — one transaction of bucket-wide multi-row `UPDATE` and `DELETE`
  statements over `BENCH_BULK` buckets of `BENCH_BULK_ROWS` rows; every statement must
  touch exactly `BENCH_BULK_ROWS` rows
- `copy-from` — `BENCH_COPY` rows imported through `COPY ... FROM STDIN` on the native
  client; `pg` has no driver-level `COPY FROM`, so its side sends multi-row `INSERT`
  batches of the same rows
- `savepoint-rollback` — `BENCH_SAVEPOINT` transactions of `BEGIN` / `INSERT` /
  `SAVEPOINT` / `UPDATE` / `ROLLBACK TO SAVEPOINT` / `INSERT` / `RELEASE` / `COMMIT`,
  asserting the rolled-back update did not survive
- `listen-notify` — `LISTEN bench_chan` followed by `BENCH_NOTIFY` `NOTIFY` statements;
  the native client drains `NotificationResponse` frames, `pg` counts `notification`
  events, and both must receive every message
- `large-result-cursor` — `BENCH_CURSOR` `DECLARE`/`FETCH`/`CLOSE` drains of
  `BENCH_CURSOR_PAGE` rows inside one transaction, with identical SQL on both clients
- `cte` — `BENCH_GROUP` `WITH ... AS (SELECT ... GROUP BY ...) SELECT COUNT(*)` queries
- `window` — `BENCH_ORDER` `ROW_NUMBER() OVER (PARTITION BY grp ORDER BY val DESC)`
  queries limited to 20 rows
- `union-all` — `BENCH_GROUP` `UNION ALL` queries that must return every seeded row
- `on-conflict-do-nothing` — `BENCH_UPSERT` `INSERT ... ON CONFLICT (id) DO NOTHING`
  statements that must touch zero rows without raising `23505`
- `insert-returning` — `BENCH_RETURNING` `INSERT ... RETURNING id, val` statements
- `explain` — `BENCH_GROUP` `EXPLAIN` statements, timing the planner round trip
- `view-select` — `BENCH_GROUP` reads of a view created once before the timed region
- `vacuum-analyze` — `BENCH_GROUP` `VACUUM bench` plus `ANALYZE bench` maintenance cycles

Every round starts a fresh child server with a fresh temporary data directory. Table
creation and seeding are untimed. One warmup round runs before the measured rounds.
Median and p95 come from `database.harness` (`harnessBenchSummary`, nearest-rank),
reached through this repository's napi binding — the JavaScript side keeps no second
formula. Reports carry provenance: node and rustc versions, this repository's rev,
the pinned `database.rs` rev and the data sizes. Both clients use one connection, no
pooling, no TLS, and no compression.

The native client is synchronous, so it cannot share an event loop with a server
written in JavaScript. `src/server-process.mjs` runs the server in a child process
and `src/pg-server.mjs` waits for `PGPORT` on stdout and closes the child on
teardown.

### This round's A/B

Four changes were measured on one machine with the same build and fresh child
servers, alternating the old and the new path for three rounds and taking the
median:

| Workload | old | new | change |
|----------|----:|----:|-------:|
| `portal-batch-fetch` (10 drains, 20 rows each) | 203 ms | 64 ms | -69% |
| `temp-table` (50 cycles) | 2,729 ms | 1,322 ms | -52% |
| point `UPDATE` inside one transaction (100 statements) | 56 ms | 45 ms | -19% |
| point `DELETE` inside one transaction (100 statements) | 36 ms | 27 ms | -24% |

The autocommit rows (`update`, `delete`, `insert`, `upsert`) are dominated by
one durable commit per statement on this machine, so their end-to-end medians
move less than the in-transaction numbers above.

## Server against a real PostgreSQL 16

```shell
pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16
```

Both sides run the same statements through the `pg` driver; only the server differs.
The real instance is addressed with `BENCH_REAL_HOST` / `BENCH_REAL_PORT` /
`BENCH_REAL_USER` / `BENCH_REAL_PASSWORD` (or `PGPASSWORD`) / `BENCH_REAL_DATABASE`.
An unreachable real server fails the run; there is no fallback to self-comparison.

## Per-statement profile

```shell
pnpm --dir projects/postgres.ts/examples/vs-js-libraries profile:point
```

Runs `PROFILE_STATEMENTS=15000` primary-key point selects against a
`PROFILE_ROWS=1000` dataset while the server child process records a CPU profile
(`--cpu-prof-interval=100`), then merges self time into stages and writes
`reports/profile-point.md`.

## Reports

- [Conformance report](./reports/conformance.md)
- [Benchmark report](./reports/benchmark.md)
- [Benchmark against PostgreSQL 16](./reports/benchmark-vs-postgres16.md)
- [Point-query profile](./reports/profile-point.md)
