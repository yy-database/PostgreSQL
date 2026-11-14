# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=3`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`, `BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`, `BENCH_RR_ROWS=10`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `9abdc89` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| insert | 1.00x | **0.94x** |
| select-point | 1.00x | **0.84x** |
| simple-point | 1.00x | **0.72x** |
| select-scan | 1.00x | **0.99x** |
| prepared-point | 1.00x | **0.72x** |
| tx-prepared | 1.00x | **0.73x** |
| point-uk | 1.00x | **0.85x** |
| order-limit | **1.00x** | 1.04x |
| group-by | 1.00x | **0.78x** |
| join | **1.00x** | 1.02x |
| batch-insert | 1.00x | **0.94x** |
| batch-insert-params | 1.00x | **0.97x** |
| distinct | 1.00x | **0.98x** |
| aggregate | 1.00x | **0.73x** |
| subquery | 1.00x | **0.94x** |
| index-range | 1.00x | **0.94x** |
| upsert | **1.00x** | 1.01x |
| update | 1.00x | **0.96x** |
| update-returning | 1.00x | **0.97x** |
| delete | **1.00x** | 1.01x |
| wide-row | 1.00x | **0.95x** |
| error-constraint | 1.00x | **0.89x** |
| rollback | 1.00x | **0.94x** |
| portal-batch-fetch | **1.00x** | 2.63x |
| temp-table | 1.00x | **0.94x** |
| multi-statement | 1.00x | **0.88x** |
| constraint-violation-rollback | 1.00x | **0.93x** |
| repeatable-read-tx | 1.00x | **0.89x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| insert | pg | 1451.09 | 1476.18 | 7.255 | 138/s |
| insert | @yydb/postgres | 1361.18 | 1402.55 | 6.806 | 147/s |
| select-point | pg | 305.64 | 379.73 | 0.611 | 1,636/s |
| select-point | @yydb/postgres | 255.34 | 285.44 | 0.511 | 1,958/s |
| simple-point | pg | 230.50 | 241.38 | 0.461 | 2,169/s |
| simple-point | @yydb/postgres | 165.20 | 209.26 | 0.330 | 3,027/s |
| select-scan | pg | 23.18 | 24.32 | 0.023 | 43,135/s |
| select-scan | @yydb/postgres | 23.02 | 25.12 | 0.023 | 43,434/s |
| prepared-point | pg | 245.66 | 254.89 | 0.491 | 2,035/s |
| prepared-point | @yydb/postgres | 177.87 | 192.81 | 0.356 | 2,811/s |
| tx-prepared | pg | 110.99 | 112.70 | 0.555 | 1,802/s |
| tx-prepared | @yydb/postgres | 80.53 | 90.51 | 0.403 | 2,483/s |
| point-uk | pg | 281.83 | 324.94 | 0.564 | 1,774/s |
| point-uk | @yydb/postgres | 239.98 | 254.53 | 0.480 | 2,083/s |
| order-limit | pg | 40.05 | 43.27 | 0.801 | 1,249/s |
| order-limit | @yydb/postgres | 41.52 | 43.18 | 0.830 | 1,204/s |
| group-by | pg | 73.94 | 79.03 | 1.479 | 676/s |
| group-by | @yydb/postgres | 57.39 | 64.80 | 1.148 | 871/s |
| join | pg | 103.68 | 111.54 | 2.074 | 482/s |
| join | @yydb/postgres | 106.10 | 107.76 | 2.122 | 471/s |
| batch-insert | pg | 96.46 | 100.52 | 0.482 | 2,073/s |
| batch-insert | @yydb/postgres | 90.97 | 100.10 | 0.455 | 2,198/s |
| batch-insert-params | pg | 94.54 | 95.54 | 0.473 | 2,116/s |
| batch-insert-params | @yydb/postgres | 91.82 | 94.27 | 0.459 | 2,178/s |
| distinct | pg | 45.68 | 59.14 | 0.914 | 1,095/s |
| distinct | @yydb/postgres | 44.94 | 46.65 | 0.899 | 1,113/s |
| aggregate | pg | 53.72 | 67.50 | 1.074 | 931/s |
| aggregate | @yydb/postgres | 38.98 | 41.31 | 0.780 | 1,283/s |
| subquery | pg | 2449.61 | 2613.19 | 48.992 | 20/s |
| subquery | @yydb/postgres | 2305.95 | 2309.78 | 46.119 | 22/s |
| index-range | pg | 185.25 | 190.04 | 1.853 | 540/s |
| index-range | @yydb/postgres | 174.23 | 199.84 | 1.742 | 574/s |
| upsert | pg | 1498.00 | 1506.71 | 7.490 | 134/s |
| upsert | @yydb/postgres | 1515.13 | 1556.08 | 7.576 | 132/s |
| update | pg | 1589.65 | 1589.94 | 7.948 | 126/s |
| update | @yydb/postgres | 1524.15 | 1584.46 | 7.621 | 131/s |
| update-returning | pg | 807.08 | 823.09 | 8.071 | 124/s |
| update-returning | @yydb/postgres | 779.67 | 808.43 | 7.797 | 128/s |
| delete | pg | 1440.70 | 1590.24 | 7.204 | 139/s |
| delete | @yydb/postgres | 1450.35 | 1508.20 | 7.252 | 138/s |
| wide-row | pg | 52.70 | 53.06 | 0.527 | 1,897/s |
| wide-row | @yydb/postgres | 50.22 | 72.45 | 0.502 | 1,991/s |
| error-constraint | pg | 97.16 | 111.72 | 0.972 | 1,029/s |
| error-constraint | @yydb/postgres | 86.33 | 96.01 | 0.863 | 1,158/s |
| rollback | pg | 141.87 | 155.96 | 0.709 | 1,410/s |
| rollback | @yydb/postgres | 133.25 | 140.38 | 0.666 | 1,501/s |
| portal-batch-fetch | pg | 77.54 | 82.80 | 0.039 | 25,794/s |
| portal-batch-fetch | @yydb/postgres | 204.22 | 279.29 | 0.102 | 9,793/s |
| temp-table | pg | 3269.79 | 3290.20 | 65.396 | 15/s |
| temp-table | @yydb/postgres | 3080.65 | 3506.10 | 61.613 | 16/s |
| multi-statement | pg | 58.31 | 78.97 | 0.117 | 8,574/s |
| multi-statement | @yydb/postgres | 51.15 | 51.47 | 0.102 | 9,775/s |
| constraint-violation-rollback | pg | 126.81 | 135.84 | 1.268 | 789/s |
| constraint-violation-rollback | @yydb/postgres | 117.72 | 119.22 | 1.177 | 849/s |
| repeatable-read-tx | pg | 161.16 | 162.81 | 0.537 | 1,861/s |
| repeatable-read-tx | @yydb/postgres | 143.38 | 151.73 | 0.478 | 2,092/s |

An op is one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with `RETURNING`, one delete, one row with a `NULL` or 4 KiB cell, one rejected duplicate-key insert, one rolled-back insert, one row fetched through a suspended portal, one temporary-table cycle, one statement inside a multi-statement message, one rejected insert followed by `ROLLBACK`, or one repeatable-read point query.
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
- `portal-batch-fetch` drains `SELECT id, val FROM bench ORDER BY id` `BENCH_PAGE` rows at a time inside one explicit transaction per drain, so the portal survives `Sync`. The native client sends `Bind` once and then `Execute` with a row limit, counting `PortalSuspended` as "more rows"; `pg` has no `Execute` row limit, so its side uses `DECLARE ... CURSOR` plus `FETCH n`. Both must return exactly `BENCH2_ROWS` rows per drain.
- `temp-table` runs `CREATE TEMP TABLE` / 20-row `INSERT` / `SELECT` / `DROP TABLE` `BENCH_TEMP` times on one connection, so it measures catalog churn from a session-local relation surviving across statements.
- `multi-statement` sends one simple-query message carrying `BENCH_MULTI_STATEMENTS` statements `BENCH_MULTI` times. `pg` answers a result array and the native client decodes one result per statement, so both assert the statement count.
- `constraint-violation-rollback` opens a transaction, sends a duplicate-key insert, absorbs the `23505`, and rolls back, `BENCH_CVR` times. It times the error path plus transaction unwind rather than a successful write.
- `repeatable-read-tx` runs `BENCH_RR` transactions of `BENCH_RR_ROWS` point selects each, all under `BEGIN ISOLATION LEVEL REPEATABLE READ`; the snapshot levels never re-read committed state per statement.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
