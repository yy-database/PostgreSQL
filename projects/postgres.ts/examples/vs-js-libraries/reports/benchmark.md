# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=3`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `874c93d` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| insert | 1.00x | **0.96x** |
| select-point | 1.00x | **0.86x** |
| simple-point | 1.00x | **0.67x** |
| select-scan | 1.00x | **0.90x** |
| prepared-point | 1.00x | **0.71x** |
| tx-prepared | 1.00x | **0.88x** |
| point-uk | 1.00x | **1.00x** |
| order-limit | 1.00x | **0.87x** |
| group-by | 1.00x | **0.91x** |
| join | 1.00x | **0.93x** |
| batch-insert | 1.00x | **0.78x** |
| batch-insert-params | **1.00x** | 1.03x |
| distinct | 1.00x | **0.99x** |
| aggregate | 1.00x | **0.67x** |
| subquery | **1.00x** | 1.06x |
| index-range | 1.00x | **0.88x** |
| upsert | **1.00x** | 1.01x |
| update | **1.00x** | 1.10x |
| update-returning | 1.00x | **0.98x** |
| delete | **1.00x** | 1.01x |
| wide-row | 1.00x | **0.92x** |
| error-constraint | **1.00x** | 1.08x |
| rollback | 1.00x | **0.98x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| insert | pg | 900.09 | 916.36 | 4.500 | 222/s |
| insert | @yydb/postgres | 868.43 | 970.85 | 4.342 | 230/s |
| select-point | pg | 162.39 | 198.02 | 0.325 | 3,079/s |
| select-point | @yydb/postgres | 140.40 | 156.06 | 0.281 | 3,561/s |
| simple-point | pg | 154.47 | 171.18 | 0.309 | 3,237/s |
| simple-point | @yydb/postgres | 104.05 | 110.79 | 0.208 | 4,805/s |
| select-scan | pg | 10.83 | 11.14 | 0.011 | 92,334/s |
| select-scan | @yydb/postgres | 9.79 | 16.08 | 0.010 | 102,186/s |
| prepared-point | pg | 130.28 | 180.19 | 0.261 | 3,838/s |
| prepared-point | @yydb/postgres | 92.55 | 112.18 | 0.185 | 5,402/s |
| tx-prepared | pg | 59.02 | 60.48 | 0.295 | 3,389/s |
| tx-prepared | @yydb/postgres | 52.01 | 58.05 | 0.260 | 3,846/s |
| point-uk | pg | 212.84 | 239.07 | 0.426 | 2,349/s |
| point-uk | @yydb/postgres | 212.49 | 243.02 | 0.425 | 2,353/s |
| order-limit | pg | 40.73 | 42.34 | 0.815 | 1,228/s |
| order-limit | @yydb/postgres | 35.62 | 42.28 | 0.712 | 1,404/s |
| group-by | pg | 49.19 | 52.23 | 0.984 | 1,017/s |
| group-by | @yydb/postgres | 44.67 | 47.82 | 0.893 | 1,119/s |
| join | pg | 88.98 | 89.99 | 1.780 | 562/s |
| join | @yydb/postgres | 82.91 | 95.71 | 1.658 | 603/s |
| batch-insert | pg | 65.16 | 65.37 | 0.326 | 3,070/s |
| batch-insert | @yydb/postgres | 50.86 | 58.53 | 0.254 | 3,933/s |
| batch-insert-params | pg | 48.88 | 53.63 | 0.244 | 4,091/s |
| batch-insert-params | @yydb/postgres | 50.58 | 51.00 | 0.253 | 3,954/s |
| distinct | pg | 25.31 | 27.61 | 0.506 | 1,975/s |
| distinct | @yydb/postgres | 25.02 | 25.24 | 0.500 | 1,998/s |
| aggregate | pg | 35.51 | 36.42 | 0.710 | 1,408/s |
| aggregate | @yydb/postgres | 23.66 | 26.51 | 0.473 | 2,113/s |
| subquery | pg | 1377.13 | 1392.81 | 27.543 | 36/s |
| subquery | @yydb/postgres | 1453.52 | 1626.11 | 29.070 | 34/s |
| index-range | pg | 99.18 | 113.21 | 0.992 | 1,008/s |
| index-range | @yydb/postgres | 87.18 | 112.22 | 0.872 | 1,147/s |
| upsert | pg | 881.10 | 963.18 | 4.405 | 227/s |
| upsert | @yydb/postgres | 892.00 | 967.74 | 4.460 | 224/s |
| update | pg | 879.88 | 891.11 | 4.399 | 227/s |
| update | @yydb/postgres | 966.73 | 1243.42 | 4.834 | 207/s |
| update-returning | pg | 466.00 | 595.58 | 4.660 | 215/s |
| update-returning | @yydb/postgres | 457.45 | 487.40 | 4.574 | 219/s |
| delete | pg | 860.51 | 885.73 | 4.303 | 232/s |
| delete | @yydb/postgres | 868.21 | 1026.35 | 4.341 | 230/s |
| wide-row | pg | 32.65 | 35.54 | 0.326 | 3,063/s |
| wide-row | @yydb/postgres | 30.13 | 31.42 | 0.301 | 3,319/s |
| error-constraint | pg | 60.51 | 68.69 | 0.605 | 1,653/s |
| error-constraint | @yydb/postgres | 65.21 | 91.12 | 0.652 | 1,533/s |
| rollback | pg | 83.38 | 113.11 | 0.417 | 2,399/s |
| rollback | @yydb/postgres | 81.59 | 84.94 | 0.408 | 2,451/s |

An op is one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with `RETURNING`, one delete, one row with a `NULL` or 4 KiB cell, one rejected duplicate-key insert, or one rolled-back insert.
One warmup round runs before the measured rounds. The table reports median and p95 of 3 measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- `pg` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The `pg` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh `mkdtemp` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is `prepare` plus `executePrepared`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.
- `point-uk`, `order-limit`, `group-by`, `join` and `batch-insert` run against the shared `bench`/`bench_join` shape of `benchmark-vs-postgres16.mjs`: `uk` carries the unique index, `(val DESC, id)` carries the ordered index, `grp` has no index.
- `simple-point` runs an unparameterised statement through the simple-query protocol, while `select-point` binds `$1` through Parse/Bind/Describe/Execute. `batch-insert-params` is the parameterised twin of `batch-insert`, so the pair isolates literal parsing from bind encoding. `tx-prepared` runs the same prepared statement inside one `BEGIN`/`COMMIT`.
- The SQL-feature rows (`distinct`, `aggregate`, `subquery`, `index-range`, `upsert`, `update`, `update-returning`, `delete`, `wide-row`, `error-constraint`, `rollback`) also run on the shared `bench` shape. Both clients send the same literal SQL; their `query` wrapper only exposes the returned row count, so aggregate and subquery values are asserted in the SQLite side's benchmark, while this side pins the row-count shape and the client/server ratio.
- `upsert` uses the server's `ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val`, arbitrated through the primary-key index instead of a full table scan. `wide-row` reads rows whose `pad` is `NULL` on half the ids and 4 KiB on id 1. `error-constraint` sends a duplicate-key insert every iteration and times the `ErrorResponse` plus `ReadyForQuery` round trip.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
