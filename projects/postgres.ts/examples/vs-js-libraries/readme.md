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
`BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`. Override any of them in
the environment.

Workloads (scenario set aligned with the SQLite repository's `vs-js-libraries`):

- `insert` — sequential parameterized inserts of `BENCH_ROWS` rows
- `select-point` — `BENCH_POINT` parameterized point selects over `BENCH_ROWS` seeded rows
- `select-scan` — one ordered scan over `BENCH_SCAN` seeded rows
- `prepared-point` — one prepared point statement executed `BENCH_PREPARED` times
- `point-uk` — `BENCH_POINT` parameterized point selects on the `UNIQUE` column
- `order-limit` — `BENCH_ORDER` ordered-index `ORDER BY val DESC, id LIMIT 20` statements
- `group-by` — `BENCH_GROUP` `GROUP BY grp` aggregation statements over the unindexed `grp`
- `join` — `BENCH_JOIN` `INNER JOIN bench_join ON id` statements filtered by `grp`
- `batch-insert` — `BENCH_ROWS` rows through multi-row `INSERT ... VALUES (...), (...)` statements of `BENCH_BATCH` rows

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
