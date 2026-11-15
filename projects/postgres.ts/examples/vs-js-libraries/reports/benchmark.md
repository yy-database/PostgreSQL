# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=2`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_RECURSIVE=100`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`, `BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`, `BENCH_RR_ROWS=10`, `BENCH_BULK=20`, `BENCH_BULK_ROWS=10`, `BENCH_COPY=2000`, `BENCH_SAVEPOINT=20`, `BENCH_NOTIFY=100`, `BENCH_CURSOR=10`, `BENCH_CURSOR_PAGE=50`, `BENCH_CONNECT=50`, `BENCH_MISSING=100`, `BENCH_ABORT=50`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `9c13d70` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.68x** |
| insert | 1.00x | **0.96x** |
| select-point | 1.00x | **0.78x** |
| simple-point | 1.00x | **0.97x** |
| select-scan | 1.00x | **0.94x** |
| prepared-point | 1.00x | **0.62x** |
| tx-prepared | 1.00x | **0.57x** |
| point-uk | 1.00x | **0.87x** |
| order-limit | **1.00x** | 1.05x |
| group-by | 1.00x | **0.95x** |
| join | 1.00x | **1.00x** |
| batch-insert | 1.00x | **0.96x** |
| batch-insert-params | **1.00x** | 1.56x |
| distinct | 1.00x | **0.72x** |
| aggregate | **1.00x** | 1.41x |
| subquery | 1.00x | **0.99x** |
| index-range | **1.00x** | 1.35x |
| upsert | 1.00x | **0.98x** |
| update | **1.00x** | 1.00x |
| update-returning | **1.00x** | 1.00x |
| delete | **1.00x** | 1.02x |
| wide-row | 1.00x | **0.96x** |
| error-constraint | 1.00x | **0.72x** |
| error-undefined-table | 1.00x | **0.84x** |
| aborted-transaction | 1.00x | **0.65x** |
| rollback | 1.00x | **0.80x** |
| portal-batch-fetch | 1.00x | **0.76x** |
| temp-table | 1.00x | **0.90x** |
| multi-statement | **1.00x** | 1.23x |
| constraint-violation-rollback | 1.00x | **0.67x** |
| repeatable-read-tx | 1.00x | **0.83x** |
| update-delete-bulk | 1.00x | **0.98x** |
| copy-from | **1.00x** | 1.40x |
| savepoint-rollback | **1.00x** | 1.02x |
| listen-notify | 1.00x | **0.77x** |
| large-result-cursor | **1.00x** | 1.05x |
| cte | 1.00x | **0.93x** |
| recursive-cte | **1.00x** | 1.01x |
| window | **1.00x** | 1.03x |
| union-all | **1.00x** | 1.04x |
| on-conflict-do-nothing | **1.00x** | 1.21x |
| insert-returning | 1.00x | **0.96x** |
| explain | **1.00x** | 1.02x |
| view-select | 1.00x | **0.98x** |
| vacuum-analyze | 1.00x | **0.95x** |
| array-agg | 1.00x | **1.00x** |
| unnest-array | 1.00x | **0.98x** |
| like-prefix | **1.00x** | 1.21x |
| ilike-filter | 1.00x | **0.98x** |
| regex-filter | 1.00x | **0.96x** |
| group-having | 1.00x | **0.89x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 35.11 | 37.26 | 0.702 | 1,424/s |
| connect | @yydb/postgres | 23.70 | 24.10 | 0.474 | 2,110/s |
| insert | pg | 691.00 | 735.71 | 3.455 | 289/s |
| insert | @yydb/postgres | 665.64 | 671.70 | 3.328 | 300/s |
| select-point | pg | 142.23 | 158.10 | 0.284 | 3,515/s |
| select-point | @yydb/postgres | 111.58 | 113.16 | 0.223 | 4,481/s |
| simple-point | pg | 99.87 | 100.71 | 0.200 | 5,007/s |
| simple-point | @yydb/postgres | 97.29 | 100.37 | 0.195 | 5,139/s |
| select-scan | pg | 11.79 | 12.36 | 0.012 | 84,836/s |
| select-scan | @yydb/postgres | 11.11 | 11.24 | 0.011 | 90,043/s |
| prepared-point | pg | 137.48 | 138.62 | 0.275 | 3,637/s |
| prepared-point | @yydb/postgres | 84.69 | 85.31 | 0.169 | 5,904/s |
| tx-prepared | pg | 73.27 | 89.28 | 0.366 | 2,730/s |
| tx-prepared | @yydb/postgres | 41.77 | 41.81 | 0.209 | 4,788/s |
| point-uk | pg | 169.27 | 192.78 | 0.339 | 2,954/s |
| point-uk | @yydb/postgres | 147.32 | 157.34 | 0.295 | 3,394/s |
| order-limit | pg | 19.51 | 20.37 | 0.390 | 2,562/s |
| order-limit | @yydb/postgres | 20.53 | 20.85 | 0.411 | 2,436/s |
| group-by | pg | 25.57 | 25.89 | 0.511 | 1,955/s |
| group-by | @yydb/postgres | 24.38 | 24.80 | 0.488 | 2,051/s |
| join | pg | 48.02 | 51.19 | 0.960 | 1,041/s |
| join | @yydb/postgres | 47.97 | 50.00 | 0.959 | 1,042/s |
| batch-insert | pg | 49.22 | 50.22 | 0.246 | 4,063/s |
| batch-insert | @yydb/postgres | 47.46 | 48.69 | 0.237 | 4,214/s |
| batch-insert-params | pg | 51.32 | 52.28 | 0.257 | 3,897/s |
| batch-insert-params | @yydb/postgres | 80.20 | 85.85 | 0.401 | 2,494/s |
| distinct | pg | 27.52 | 30.67 | 0.550 | 1,817/s |
| distinct | @yydb/postgres | 19.86 | 21.67 | 0.397 | 2,518/s |
| aggregate | pg | 20.74 | 21.24 | 0.415 | 2,411/s |
| aggregate | @yydb/postgres | 29.16 | 30.06 | 0.583 | 1,715/s |
| subquery | pg | 57.42 | 58.22 | 1.148 | 871/s |
| subquery | @yydb/postgres | 57.10 | 58.03 | 1.142 | 876/s |
| index-range | pg | 70.27 | 74.48 | 0.703 | 1,423/s |
| index-range | @yydb/postgres | 95.18 | 111.57 | 0.952 | 1,051/s |
| upsert | pg | 811.92 | 825.94 | 4.060 | 246/s |
| upsert | @yydb/postgres | 794.11 | 796.26 | 3.971 | 252/s |
| update | pg | 796.70 | 799.73 | 3.983 | 251/s |
| update | @yydb/postgres | 796.82 | 799.80 | 3.984 | 251/s |
| update-returning | pg | 399.62 | 401.64 | 3.996 | 250/s |
| update-returning | @yydb/postgres | 399.72 | 401.35 | 3.997 | 250/s |
| delete | pg | 792.83 | 807.80 | 3.964 | 252/s |
| delete | @yydb/postgres | 807.98 | 810.17 | 4.040 | 248/s |
| wide-row | pg | 38.37 | 40.84 | 0.384 | 2,606/s |
| wide-row | @yydb/postgres | 37.03 | 38.21 | 0.370 | 2,701/s |
| error-constraint | pg | 83.66 | 88.65 | 0.837 | 1,195/s |
| error-constraint | @yydb/postgres | 60.58 | 64.66 | 0.606 | 1,651/s |
| error-undefined-table | pg | 49.72 | 50.75 | 0.497 | 2,011/s |
| error-undefined-table | @yydb/postgres | 42.00 | 43.85 | 0.420 | 2,381/s |
| aborted-transaction | pg | 63.59 | 72.72 | 1.272 | 786/s |
| aborted-transaction | @yydb/postgres | 41.41 | 43.14 | 0.828 | 1,207/s |
| rollback | pg | 63.16 | 67.75 | 0.316 | 3,167/s |
| rollback | @yydb/postgres | 50.55 | 50.58 | 0.253 | 3,957/s |
| portal-batch-fetch | pg | 45.59 | 51.59 | 0.023 | 43,869/s |
| portal-batch-fetch | @yydb/postgres | 34.61 | 40.38 | 0.017 | 57,781/s |
| temp-table | pg | 155.29 | 189.40 | 3.106 | 322/s |
| temp-table | @yydb/postgres | 139.00 | 172.19 | 2.780 | 360/s |
| multi-statement | pg | 58.93 | 60.07 | 0.118 | 8,484/s |
| multi-statement | @yydb/postgres | 72.51 | 99.21 | 0.145 | 6,896/s |
| constraint-violation-rollback | pg | 93.02 | 116.08 | 0.930 | 1,075/s |
| constraint-violation-rollback | @yydb/postgres | 62.71 | 65.00 | 0.627 | 1,595/s |
| repeatable-read-tx | pg | 74.32 | 78.84 | 0.248 | 4,037/s |
| repeatable-read-tx | @yydb/postgres | 61.91 | 64.41 | 0.206 | 4,846/s |
| update-delete-bulk | pg | 37.18 | 38.45 | 0.093 | 10,758/s |
| update-delete-bulk | @yydb/postgres | 36.56 | 36.59 | 0.091 | 10,942/s |
| copy-from | pg | 268.54 | 343.63 | 0.134 | 7,448/s |
| copy-from | @yydb/postgres | 374.96 | 522.01 | 0.187 | 5,334/s |
| savepoint-rollback | pg | 110.18 | 110.60 | 0.689 | 1,452/s |
| savepoint-rollback | @yydb/postgres | 112.01 | 112.01 | 0.700 | 1,428/s |
| listen-notify | pg | 15.97 | 17.35 | 0.160 | 6,263/s |
| listen-notify | @yydb/postgres | 12.35 | 13.13 | 0.123 | 8,098/s |
| large-result-cursor | pg | 28.20 | 31.84 | 0.014 | 70,932/s |
| large-result-cursor | @yydb/postgres | 29.49 | 30.54 | 0.015 | 67,809/s |
| cte | pg | 24.07 | 25.66 | 0.481 | 2,077/s |
| cte | @yydb/postgres | 22.34 | 22.88 | 0.447 | 2,238/s |
| recursive-cte | pg | 244.31 | 247.09 | 2.443 | 409/s |
| recursive-cte | @yydb/postgres | 247.06 | 248.49 | 2.471 | 405/s |
| window | pg | 27.63 | 28.98 | 0.553 | 1,809/s |
| window | @yydb/postgres | 28.48 | 29.59 | 0.570 | 1,756/s |
| union-all | pg | 59.91 | 62.08 | 1.198 | 835/s |
| union-all | @yydb/postgres | 62.44 | 63.96 | 1.249 | 801/s |
| on-conflict-do-nothing | pg | 40.76 | 41.10 | 0.204 | 4,907/s |
| on-conflict-do-nothing | @yydb/postgres | 49.23 | 62.16 | 0.246 | 4,063/s |
| insert-returning | pg | 381.62 | 391.68 | 3.816 | 262/s |
| insert-returning | @yydb/postgres | 366.09 | 376.19 | 3.661 | 273/s |
| explain | pg | 10.16 | 10.46 | 0.203 | 4,923/s |
| explain | @yydb/postgres | 10.39 | 11.99 | 0.208 | 4,813/s |
| view-select | pg | 24.95 | 25.43 | 0.499 | 2,004/s |
| view-select | @yydb/postgres | 24.46 | 25.90 | 0.489 | 2,044/s |
| vacuum-analyze | pg | 10.29 | 11.39 | 0.103 | 9,720/s |
| vacuum-analyze | @yydb/postgres | 9.75 | 10.49 | 0.097 | 10,257/s |
| array-agg | pg | 17.05 | 17.43 | 0.341 | 2,933/s |
| array-agg | @yydb/postgres | 16.97 | 17.87 | 0.339 | 2,947/s |
| unnest-array | pg | 13.74 | 13.91 | 0.275 | 3,638/s |
| unnest-array | @yydb/postgres | 13.49 | 13.81 | 0.270 | 3,705/s |
| like-prefix | pg | 16.45 | 16.56 | 0.329 | 3,040/s |
| like-prefix | @yydb/postgres | 19.84 | 22.70 | 0.397 | 2,520/s |
| ilike-filter | pg | 18.07 | 18.93 | 0.361 | 2,768/s |
| ilike-filter | @yydb/postgres | 17.67 | 18.07 | 0.353 | 2,829/s |
| regex-filter | pg | 17.69 | 18.52 | 0.354 | 2,826/s |
| regex-filter | @yydb/postgres | 17.06 | 19.63 | 0.341 | 2,932/s |
| group-having | pg | 20.38 | 21.22 | 0.408 | 2,454/s |
| group-having | @yydb/postgres | 18.17 | 18.46 | 0.363 | 2,752/s |

An op is one completed connection handshake, one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with `RETURNING`, one delete, one row with a `NULL` or 4 KiB cell, one rejected duplicate-key insert, one rejected undefined-table statement, one aborted-transaction round trip, one rolled-back insert, one row fetched through a suspended portal, one temporary-table cycle, one statement inside a multi-statement message, one rejected insert followed by `ROLLBACK`, one repeatable-read point query, one row touched by a bulk `UPDATE`/`DELETE`, one row imported, one savepoint round-trip statement, one notification delivered, or one row fetched from a `DECLARE`/`FETCH` cursor.
One warmup round runs before the measured rounds. The table reports median and p95 of 2 measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection, except `connect`, which opens and closes `BENCH_CONNECT` short-lived connections against that same server. No pooling, TLS, or compression is used on either side.
- `pg` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The `pg` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh `mkdtemp` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is `prepare` plus `executePrepared`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.
- `point-uk`, `order-limit`, `group-by`, `join` and `batch-insert` run against the shared `bench`/`bench_join` shape of `benchmark-vs-postgres16.mjs`: `uk` carries the unique index, `(val DESC, id)` carries the ordered index, `grp` has no index.
- `simple-point` runs an unparameterised statement through the simple-query protocol, while `select-point` binds `$1` through Parse/Bind/Describe/Execute. `batch-insert-params` is the parameterised twin of `batch-insert`, so the pair isolates literal parsing from bind encoding. `tx-prepared` runs the same prepared statement inside one `BEGIN`/`COMMIT`.
- The SQL-feature rows (`distinct`, `aggregate`, `subquery`, `index-range`, `upsert`, `update`, `update-returning`, `delete`, `wide-row`, `error-constraint`, `rollback`) also run on the shared `bench` shape. Both clients send the same literal SQL; their `query` wrapper only exposes the returned row count, so aggregate and subquery values are asserted in the SQLite side's benchmark, while this side pins the row-count shape and the client/server ratio.
- `upsert` uses the server's `ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val`, arbitrated through the primary-key index instead of a full table scan. `wide-row` reads rows whose `pad` is `NULL` on half the ids and 4 KiB on id 1. `error-constraint` sends a duplicate-key insert every iteration and times the `ErrorResponse` plus `ReadyForQuery` round trip.
- `portal-batch-fetch` drains `SELECT id, val FROM bench ORDER BY id` `BENCH_PAGE` rows at a time inside one explicit transaction for the whole timed region, so the portal survives `Sync` and the per-statement cost is not hidden by per-drain commits. The native client sends `Bind` once and then `Execute` with a row limit, counting `PortalSuspended` as "more rows"; it reuses the portal description taken at `Bind` instead of asking the server to describe the portal again. `pg` has no `Execute` row limit, so its side uses `DECLARE ... CURSOR` plus `FETCH n`. Both must return exactly `BENCH2_ROWS` rows per drain.
- `temp-table` runs `CREATE TEMP TABLE` / 20-row `INSERT` / `SELECT` / `DROP TABLE` `BENCH_TEMP` times on one connection, so it measures catalog churn from a session-local relation surviving across statements. The product keeps a temp relation's rows in session memory, so only its catalog entries are durable.
- `multi-statement` sends one simple-query message carrying `BENCH_MULTI_STATEMENTS` statements `BENCH_MULTI` times. `pg` answers a result array and the native client decodes one result per statement, so both assert the statement count.
- `constraint-violation-rollback` opens a transaction, sends a duplicate-key insert, absorbs the `23505`, and rolls back, `BENCH_CVR` times. It times the error path plus transaction unwind rather than a successful write.
- `connect` opens and closes `BENCH_CONNECT` fresh connections while the measured client stays connected, so the row times the startup handshake (TCP connect, `StartupMessage`, authentication, `ReadyForQuery`, terminate) rather than query execution.
- `error-undefined-table` sends `SELECT 1 FROM bench_missing_relation` `BENCH_MISSING` times on one connection and asserts every reply is `42P01`. It covers the planning error and `ReadyForQuery` recovery that `error-constraint` does not.
- `aborted-transaction` runs `BENCH_ABORT` rounds of `BEGIN`, the same `42P01`, a follow-up statement that must be rejected with `25P02`, and `ROLLBACK`. The row measures the failed-transaction gate and its `ReadyForQuery('E')` status byte.
- `repeatable-read-tx` runs `BENCH_RR` transactions of `BENCH_RR_ROWS` point selects each, all under `BEGIN ISOLATION LEVEL REPEATABLE READ`; the snapshot levels never re-read committed state per statement.
- `update-delete-bulk` seeds `bench_bulk` and `bench_del` with `BENCH_BULK` buckets of `BENCH_BULK_ROWS` rows, then runs one transaction of bucket-wide `UPDATE ... WHERE bucket = n` and `DELETE ... WHERE bucket = n` statements. Each statement must touch exactly `BENCH_BULK_ROWS` rows; the commit happens once, so the row measures multi-row statement work rather than fsync.
- `copy-from` imports `BENCH_COPY` rows into a four-column table. The native client streams them through `COPY ... FROM STDIN`; `pg` has no `COPY FROM` in the driver, so its side sends multi-row `INSERT` batches of the same rows. The row measures the import path, not identical wire bytes.
- `savepoint-rollback` runs `BENCH_SAVEPOINT` transactions of `BEGIN` / `INSERT` / `SAVEPOINT` / `UPDATE` / `ROLLBACK TO SAVEPOINT` / `INSERT` / `RELEASE` / `COMMIT`, and asserts the rolled-back update did not survive.
- `listen-notify` runs `LISTEN bench_chan` once and then `BENCH_NOTIFY` `NOTIFY` statements. The native client reads the `NotificationResponse` frames into its own buffer and drains them after the timed region; `pg` counts `notification` events. Both must receive every notification.
- `large-result-cursor` declares `SELECT id, val FROM bench ORDER BY id` and fetches it `BENCH_CURSOR_PAGE` rows at a time, `BENCH_CURSOR` times inside one explicit transaction. Both clients run the same `DECLARE`/`FETCH`/`CLOSE` SQL, so the row isolates server-side cursor paging.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
