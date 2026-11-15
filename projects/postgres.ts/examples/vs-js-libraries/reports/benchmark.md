# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=2`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`, `BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`, `BENCH_RR_ROWS=10`, `BENCH_BULK=20`, `BENCH_BULK_ROWS=10`, `BENCH_COPY=2000`, `BENCH_SAVEPOINT=20`, `BENCH_NOTIFY=100`, `BENCH_CURSOR=10`, `BENCH_CURSOR_PAGE=50`, `BENCH_CONNECT=50`, `BENCH_MISSING=100`, `BENCH_ABORT=50`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `2a69a21` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.76x** |
| insert | 1.00x | **0.86x** |
| select-point | 1.00x | **0.80x** |
| simple-point | 1.00x | **0.86x** |
| select-scan | 1.00x | **0.98x** |
| prepared-point | 1.00x | **0.62x** |
| tx-prepared | 1.00x | **0.66x** |
| point-uk | 1.00x | **0.83x** |
| order-limit | 1.00x | **0.96x** |
| group-by | 1.00x | **0.90x** |
| join | 1.00x | **0.98x** |
| batch-insert | **1.00x** | 1.08x |
| batch-insert-params | 1.00x | **0.96x** |
| distinct | 1.00x | **0.94x** |
| aggregate | 1.00x | **0.89x** |
| subquery | **1.00x** | 1.01x |
| index-range | **1.00x** | 1.15x |
| upsert | 1.00x | **0.85x** |
| update | **1.00x** | 1.01x |
| update-returning | **1.00x** | 1.95x |
| delete | 1.00x | **1.00x** |
| wide-row | 1.00x | **0.94x** |
| error-constraint | 1.00x | **0.81x** |
| error-undefined-table | 1.00x | **0.90x** |
| aborted-transaction | 1.00x | **0.98x** |
| rollback | 1.00x | **0.73x** |
| portal-batch-fetch | 1.00x | **0.81x** |
| temp-table | 1.00x | **0.96x** |
| multi-statement | 1.00x | **0.92x** |
| constraint-violation-rollback | 1.00x | **0.84x** |
| repeatable-read-tx | 1.00x | **0.96x** |
| update-delete-bulk | 1.00x | **0.90x** |
| copy-from | **1.00x** | 1.03x |
| savepoint-rollback | 1.00x | **0.93x** |
| listen-notify | 1.00x | **0.85x** |
| large-result-cursor | **1.00x** | 1.01x |
| cte | 1.00x | **0.97x** |
| window | 1.00x | **0.91x** |
| union-all | **1.00x** | 1.07x |
| on-conflict-do-nothing | 1.00x | **0.93x** |
| insert-returning | **1.00x** | 1.01x |
| explain | 1.00x | **0.81x** |
| view-select | 1.00x | **1.00x** |
| vacuum-analyze | 1.00x | **0.75x** |
| array-agg | 1.00x | **0.84x** |
| unnest-array | 1.00x | **0.95x** |
| like-prefix | 1.00x | **0.87x** |
| ilike-filter | 1.00x | **0.99x** |
| regex-filter | **1.00x** | 1.08x |
| group-having | 1.00x | **0.94x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 33.31 | 33.53 | 0.666 | 1,501/s |
| connect | @yydb/postgres | 25.15 | 25.24 | 0.503 | 1,988/s |
| insert | pg | 754.94 | 810.10 | 3.775 | 265/s |
| insert | @yydb/postgres | 650.67 | 653.96 | 3.253 | 307/s |
| select-point | pg | 141.47 | 144.15 | 0.283 | 3,534/s |
| select-point | @yydb/postgres | 113.13 | 117.46 | 0.226 | 4,420/s |
| simple-point | pg | 120.47 | 121.83 | 0.241 | 4,151/s |
| simple-point | @yydb/postgres | 104.07 | 105.92 | 0.208 | 4,804/s |
| select-scan | pg | 11.82 | 12.64 | 0.012 | 84,574/s |
| select-scan | @yydb/postgres | 11.61 | 11.91 | 0.012 | 86,128/s |
| prepared-point | pg | 152.22 | 154.20 | 0.304 | 3,285/s |
| prepared-point | @yydb/postgres | 94.19 | 95.55 | 0.188 | 5,308/s |
| tx-prepared | pg | 64.53 | 64.71 | 0.323 | 3,100/s |
| tx-prepared | @yydb/postgres | 42.70 | 43.64 | 0.214 | 4,684/s |
| point-uk | pg | 166.51 | 170.66 | 0.333 | 3,003/s |
| point-uk | @yydb/postgres | 137.71 | 138.40 | 0.275 | 3,631/s |
| order-limit | pg | 23.37 | 24.56 | 0.467 | 2,139/s |
| order-limit | @yydb/postgres | 22.33 | 23.02 | 0.447 | 2,239/s |
| group-by | pg | 30.13 | 30.79 | 0.603 | 1,660/s |
| group-by | @yydb/postgres | 27.25 | 27.44 | 0.545 | 1,835/s |
| join | pg | 49.02 | 49.72 | 0.980 | 1,020/s |
| join | @yydb/postgres | 47.97 | 48.63 | 0.959 | 1,042/s |
| batch-insert | pg | 46.71 | 46.86 | 0.234 | 4,281/s |
| batch-insert | @yydb/postgres | 50.56 | 50.65 | 0.253 | 3,955/s |
| batch-insert-params | pg | 51.59 | 54.82 | 0.258 | 3,877/s |
| batch-insert-params | @yydb/postgres | 49.43 | 50.22 | 0.247 | 4,046/s |
| distinct | pg | 22.58 | 24.83 | 0.452 | 2,214/s |
| distinct | @yydb/postgres | 21.17 | 22.34 | 0.423 | 2,362/s |
| aggregate | pg | 22.67 | 23.94 | 0.453 | 2,206/s |
| aggregate | @yydb/postgres | 20.22 | 21.09 | 0.404 | 2,473/s |
| subquery | pg | 1220.18 | 1238.29 | 24.404 | 41/s |
| subquery | @yydb/postgres | 1227.41 | 1247.28 | 24.548 | 41/s |
| index-range | pg | 68.73 | 70.51 | 0.687 | 1,455/s |
| index-range | @yydb/postgres | 79.34 | 79.72 | 0.793 | 1,260/s |
| upsert | pg | 922.67 | 1057.70 | 4.613 | 217/s |
| upsert | @yydb/postgres | 788.00 | 796.24 | 3.940 | 254/s |
| update | pg | 790.45 | 804.22 | 3.952 | 253/s |
| update | @yydb/postgres | 797.65 | 797.73 | 3.988 | 251/s |
| update-returning | pg | 403.27 | 404.76 | 4.033 | 248/s |
| update-returning | @yydb/postgres | 787.84 | 1151.90 | 7.878 | 127/s |
| delete | pg | 698.89 | 719.96 | 3.494 | 286/s |
| delete | @yydb/postgres | 696.52 | 719.30 | 3.483 | 287/s |
| wide-row | pg | 28.02 | 28.36 | 0.280 | 3,569/s |
| wide-row | @yydb/postgres | 26.44 | 27.95 | 0.264 | 3,782/s |
| error-constraint | pg | 49.37 | 50.03 | 0.494 | 2,026/s |
| error-constraint | @yydb/postgres | 39.97 | 42.15 | 0.400 | 2,502/s |
| error-undefined-table | pg | 36.08 | 36.76 | 0.361 | 2,771/s |
| error-undefined-table | @yydb/postgres | 32.42 | 32.73 | 0.324 | 3,084/s |
| aborted-transaction | pg | 50.39 | 50.55 | 1.008 | 992/s |
| aborted-transaction | @yydb/postgres | 49.22 | 49.90 | 0.984 | 1,016/s |
| rollback | pg | 65.48 | 67.54 | 0.327 | 3,054/s |
| rollback | @yydb/postgres | 47.64 | 48.36 | 0.238 | 4,199/s |
| portal-batch-fetch | pg | 39.33 | 40.12 | 0.020 | 50,850/s |
| portal-batch-fetch | @yydb/postgres | 31.92 | 33.77 | 0.016 | 62,653/s |
| temp-table | pg | 596.76 | 597.69 | 11.935 | 84/s |
| temp-table | @yydb/postgres | 571.58 | 579.62 | 11.432 | 87/s |
| multi-statement | pg | 34.28 | 36.14 | 0.069 | 14,586/s |
| multi-statement | @yydb/postgres | 31.38 | 32.04 | 0.063 | 15,935/s |
| constraint-violation-rollback | pg | 68.81 | 70.32 | 0.688 | 1,453/s |
| constraint-violation-rollback | @yydb/postgres | 57.56 | 58.32 | 0.576 | 1,737/s |
| repeatable-read-tx | pg | 79.83 | 80.60 | 0.266 | 3,758/s |
| repeatable-read-tx | @yydb/postgres | 76.71 | 81.54 | 0.256 | 3,911/s |
| update-delete-bulk | pg | 41.91 | 43.08 | 0.105 | 9,544/s |
| update-delete-bulk | @yydb/postgres | 37.82 | 38.91 | 0.095 | 10,576/s |
| copy-from | pg | 184.27 | 192.06 | 0.092 | 10,853/s |
| copy-from | @yydb/postgres | 189.67 | 195.86 | 0.095 | 10,545/s |
| savepoint-rollback | pg | 113.09 | 116.25 | 0.707 | 1,415/s |
| savepoint-rollback | @yydb/postgres | 105.67 | 107.71 | 0.660 | 1,514/s |
| listen-notify | pg | 15.47 | 15.51 | 0.155 | 6,464/s |
| listen-notify | @yydb/postgres | 13.11 | 14.14 | 0.131 | 7,630/s |
| large-result-cursor | pg | 30.64 | 30.91 | 0.015 | 65,274/s |
| large-result-cursor | @yydb/postgres | 30.85 | 33.01 | 0.015 | 64,838/s |
| cte | pg | 23.06 | 23.11 | 0.461 | 2,168/s |
| cte | @yydb/postgres | 22.28 | 23.60 | 0.446 | 2,244/s |
| window | pg | 32.10 | 33.93 | 0.642 | 1,557/s |
| window | @yydb/postgres | 29.15 | 29.88 | 0.583 | 1,715/s |
| union-all | pg | 58.98 | 59.62 | 1.180 | 848/s |
| union-all | @yydb/postgres | 63.06 | 64.04 | 1.261 | 793/s |
| on-conflict-do-nothing | pg | 44.01 | 44.86 | 0.220 | 4,544/s |
| on-conflict-do-nothing | @yydb/postgres | 41.02 | 41.34 | 0.205 | 4,876/s |
| insert-returning | pg | 387.83 | 391.88 | 3.878 | 258/s |
| insert-returning | @yydb/postgres | 390.62 | 395.39 | 3.906 | 256/s |
| explain | pg | 12.46 | 12.52 | 0.249 | 4,014/s |
| explain | @yydb/postgres | 10.14 | 10.73 | 0.203 | 4,931/s |
| view-select | pg | 28.37 | 29.26 | 0.567 | 1,763/s |
| view-select | @yydb/postgres | 28.34 | 29.30 | 0.567 | 1,764/s |
| vacuum-analyze | pg | 13.47 | 13.84 | 0.135 | 7,424/s |
| vacuum-analyze | @yydb/postgres | 10.09 | 10.33 | 0.101 | 9,915/s |
| array-agg | pg | 23.16 | 24.88 | 0.463 | 2,159/s |
| array-agg | @yydb/postgres | 19.55 | 20.54 | 0.391 | 2,558/s |
| unnest-array | pg | 16.13 | 18.08 | 0.323 | 3,099/s |
| unnest-array | @yydb/postgres | 15.32 | 15.41 | 0.306 | 3,264/s |
| like-prefix | pg | 22.14 | 22.97 | 0.443 | 2,258/s |
| like-prefix | @yydb/postgres | 19.17 | 19.85 | 0.383 | 2,609/s |
| ilike-filter | pg | 21.01 | 21.14 | 0.420 | 2,379/s |
| ilike-filter | @yydb/postgres | 20.70 | 22.09 | 0.414 | 2,416/s |
| regex-filter | pg | 19.79 | 19.85 | 0.396 | 2,527/s |
| regex-filter | @yydb/postgres | 21.44 | 22.43 | 0.429 | 2,332/s |
| group-having | pg | 25.59 | 26.85 | 0.512 | 1,954/s |
| group-having | @yydb/postgres | 24.14 | 25.10 | 0.483 | 2,071/s |

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
