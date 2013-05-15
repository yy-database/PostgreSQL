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
- `tests/` — `conformance.mjs` (cross-client reads and prepared statements) and
  `benchmark.mjs` (relative and absolute throughput)
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
`BENCH_PREPARED=500`, `BENCH_ROUNDS=3`. Override any of them in the environment.

Workloads:

- `insert` — sequential parameterized inserts of `BENCH_ROWS` rows
- `select-point` — `BENCH_POINT` parameterized point selects over `BENCH_ROWS` seeded rows
- `select-scan` — one ordered scan over `BENCH_SCAN` seeded rows
- `prepared-point` — one prepared point statement executed `BENCH_PREPARED` times

Every round starts a fresh child server with a fresh temporary data directory. Table
creation and seeding are untimed. One warmup round runs before the measured rounds,
and the reported number is the median of the measured rounds. Both clients use one
connection, no pooling, no TLS, and no compression.

The native client is synchronous, so it cannot share an event loop with a server
written in JavaScript. `src/server-process.mjs` runs the server in a child process
and `src/pg-server.mjs` waits for `PGPORT` on stdout and closes the child on
teardown.

## Reports

- [Conformance report](./reports/conformance.md)
- [Benchmark report](./reports/benchmark.md)
