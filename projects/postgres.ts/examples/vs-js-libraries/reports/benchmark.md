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
| 本仓 rev | `8744446` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.78x** |
| insert | 1.00x | **0.99x** |
| select-point | 1.00x | **0.77x** |
| simple-point | 1.00x | **0.84x** |
| select-scan | **1.00x** | 1.19x |
| prepared-point | 1.00x | **0.68x** |
| tx-prepared | 1.00x | **0.70x** |
| point-uk | 1.00x | **0.90x** |
| order-limit | 1.00x | **0.97x** |
| group-by | 1.00x | **0.93x** |
| join | 1.00x | **0.82x** |
| batch-insert | **1.00x** | 1.22x |
| batch-insert-params | **1.00x** | 1.06x |
| distinct | 1.00x | **0.91x** |
| aggregate | **1.00x** | 1.02x |
| subquery | 1.00x | **0.93x** |
| index-range | 1.00x | **0.94x** |
| upsert | **1.00x** | 1.21x |
| update | **1.00x** | 1.18x |
| update-returning | 1.00x | **0.72x** |
| delete | 1.00x | **0.99x** |
| wide-row | 1.00x | **0.89x** |
| error-constraint | 1.00x | **0.91x** |
| error-undefined-table | 1.00x | **0.85x** |
| aborted-transaction | 1.00x | **0.77x** |
| rollback | 1.00x | **0.94x** |
| portal-batch-fetch | 1.00x | **0.78x** |
| temp-table | 1.00x | **0.99x** |
| multi-statement | 1.00x | **0.87x** |
| constraint-violation-rollback | 1.00x | **0.85x** |
| repeatable-read-tx | 1.00x | **0.97x** |
| update-delete-bulk | 1.00x | **0.90x** |
| copy-from | **1.00x** | 1.02x |
| savepoint-rollback | 1.00x | **0.97x** |
| listen-notify | 1.00x | **0.82x** |
| large-result-cursor | 1.00x | **0.90x** |
| cte | **1.00x** | 1.14x |
| recursive-cte | 1.00x | **0.99x** |
| window | 1.00x | **0.93x** |
| union-all | 1.00x | **0.96x** |
| on-conflict-do-nothing | 1.00x | **0.86x** |
| insert-returning | 1.00x | **0.97x** |
| explain | **1.00x** | 1.04x |
| view-select | 1.00x | **0.88x** |
| vacuum-analyze | 1.00x | **0.94x** |
| array-agg | 1.00x | **0.90x** |
| unnest-array | 1.00x | **0.92x** |
| like-prefix | 1.00x | **0.91x** |
| ilike-filter | 1.00x | **1.00x** |
| regex-filter | 1.00x | **0.93x** |
| group-having | 1.00x | **0.99x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 31.73 | 32.88 | 0.635 | 1,576/s |
| connect | @yydb/postgres | 24.61 | 26.12 | 0.492 | 2,032/s |
| insert | pg | 738.07 | 747.72 | 3.690 | 271/s |
| insert | @yydb/postgres | 731.89 | 767.86 | 3.659 | 273/s |
| select-point | pg | 146.09 | 149.78 | 0.292 | 3,423/s |
| select-point | @yydb/postgres | 112.34 | 113.56 | 0.225 | 4,451/s |
| simple-point | pg | 109.31 | 109.74 | 0.219 | 4,574/s |
| simple-point | @yydb/postgres | 92.32 | 94.13 | 0.185 | 5,416/s |
| select-scan | pg | 10.89 | 11.00 | 0.011 | 91,802/s |
| select-scan | @yydb/postgres | 12.93 | 15.10 | 0.013 | 77,323/s |
| prepared-point | pg | 132.47 | 132.79 | 0.265 | 3,775/s |
| prepared-point | @yydb/postgres | 89.89 | 91.62 | 0.180 | 5,562/s |
| tx-prepared | pg | 59.07 | 59.24 | 0.295 | 3,386/s |
| tx-prepared | @yydb/postgres | 41.57 | 42.11 | 0.208 | 4,811/s |
| point-uk | pg | 147.91 | 153.79 | 0.296 | 3,380/s |
| point-uk | @yydb/postgres | 132.75 | 135.85 | 0.265 | 3,766/s |
| order-limit | pg | 22.61 | 22.86 | 0.452 | 2,211/s |
| order-limit | @yydb/postgres | 21.94 | 24.28 | 0.439 | 2,279/s |
| group-by | pg | 28.70 | 29.93 | 0.574 | 1,742/s |
| group-by | @yydb/postgres | 26.71 | 27.74 | 0.534 | 1,872/s |
| join | pg | 65.00 | 82.81 | 1.300 | 769/s |
| join | @yydb/postgres | 53.34 | 55.87 | 1.067 | 937/s |
| batch-insert | pg | 48.66 | 48.68 | 0.243 | 4,110/s |
| batch-insert | @yydb/postgres | 59.48 | 68.93 | 0.297 | 3,362/s |
| batch-insert-params | pg | 51.36 | 52.28 | 0.257 | 3,894/s |
| batch-insert-params | @yydb/postgres | 54.49 | 58.67 | 0.272 | 3,670/s |
| distinct | pg | 27.18 | 29.28 | 0.544 | 1,839/s |
| distinct | @yydb/postgres | 24.68 | 26.22 | 0.494 | 2,026/s |
| aggregate | pg | 23.60 | 25.17 | 0.472 | 2,119/s |
| aggregate | @yydb/postgres | 24.17 | 27.61 | 0.483 | 2,069/s |
| subquery | pg | 1288.73 | 1329.39 | 25.775 | 39/s |
| subquery | @yydb/postgres | 1204.84 | 1212.30 | 24.097 | 41/s |
| index-range | pg | 68.04 | 69.54 | 0.680 | 1,470/s |
| index-range | @yydb/postgres | 64.12 | 64.18 | 0.641 | 1,560/s |
| upsert | pg | 768.18 | 768.46 | 3.841 | 260/s |
| upsert | @yydb/postgres | 927.91 | 1107.69 | 4.640 | 216/s |
| update | pg | 780.83 | 781.80 | 3.904 | 256/s |
| update | @yydb/postgres | 918.74 | 1095.71 | 4.594 | 218/s |
| update-returning | pg | 546.85 | 699.75 | 5.468 | 183/s |
| update-returning | @yydb/postgres | 391.06 | 393.74 | 3.911 | 256/s |
| delete | pg | 655.64 | 669.65 | 3.278 | 305/s |
| delete | @yydb/postgres | 652.07 | 658.06 | 3.260 | 307/s |
| wide-row | pg | 26.09 | 27.46 | 0.261 | 3,833/s |
| wide-row | @yydb/postgres | 23.09 | 23.71 | 0.231 | 4,331/s |
| error-constraint | pg | 43.11 | 43.50 | 0.431 | 2,320/s |
| error-constraint | @yydb/postgres | 39.41 | 40.27 | 0.394 | 2,538/s |
| error-undefined-table | pg | 32.95 | 32.99 | 0.329 | 3,035/s |
| error-undefined-table | @yydb/postgres | 28.08 | 28.30 | 0.281 | 3,562/s |
| aborted-transaction | pg | 46.89 | 51.97 | 0.938 | 1,066/s |
| aborted-transaction | @yydb/postgres | 36.22 | 36.88 | 0.724 | 1,381/s |
| rollback | pg | 49.32 | 50.48 | 0.247 | 4,056/s |
| rollback | @yydb/postgres | 46.49 | 48.37 | 0.232 | 4,302/s |
| portal-batch-fetch | pg | 35.50 | 37.07 | 0.018 | 56,343/s |
| portal-batch-fetch | @yydb/postgres | 27.55 | 27.83 | 0.014 | 72,598/s |
| temp-table | pg | 582.66 | 591.70 | 11.653 | 86/s |
| temp-table | @yydb/postgres | 576.46 | 577.52 | 11.529 | 87/s |
| multi-statement | pg | 29.54 | 29.87 | 0.059 | 16,927/s |
| multi-statement | @yydb/postgres | 25.69 | 26.43 | 0.051 | 19,463/s |
| constraint-violation-rollback | pg | 61.00 | 61.44 | 0.610 | 1,639/s |
| constraint-violation-rollback | @yydb/postgres | 52.02 | 53.41 | 0.520 | 1,922/s |
| repeatable-read-tx | pg | 73.48 | 74.17 | 0.245 | 4,083/s |
| repeatable-read-tx | @yydb/postgres | 71.23 | 74.02 | 0.237 | 4,212/s |
| update-delete-bulk | pg | 39.60 | 40.65 | 0.099 | 10,100/s |
| update-delete-bulk | @yydb/postgres | 35.80 | 36.11 | 0.090 | 11,172/s |
| copy-from | pg | 187.48 | 188.27 | 0.094 | 10,668/s |
| copy-from | @yydb/postgres | 190.56 | 193.16 | 0.095 | 10,496/s |
| savepoint-rollback | pg | 108.95 | 109.84 | 0.681 | 1,469/s |
| savepoint-rollback | @yydb/postgres | 105.16 | 106.82 | 0.657 | 1,522/s |
| listen-notify | pg | 13.65 | 14.37 | 0.137 | 7,325/s |
| listen-notify | @yydb/postgres | 11.16 | 12.27 | 0.112 | 8,964/s |
| large-result-cursor | pg | 27.52 | 28.58 | 0.014 | 72,676/s |
| large-result-cursor | @yydb/postgres | 24.87 | 26.22 | 0.012 | 80,433/s |
| cte | pg | 22.17 | 22.84 | 0.443 | 2,256/s |
| cte | @yydb/postgres | 25.31 | 27.98 | 0.506 | 1,975/s |
| recursive-cte | pg | 259.25 | 259.46 | 2.593 | 386/s |
| recursive-cte | @yydb/postgres | 257.14 | 259.35 | 2.571 | 389/s |
| window | pg | 30.83 | 31.26 | 0.617 | 1,622/s |
| window | @yydb/postgres | 28.70 | 29.96 | 0.574 | 1,742/s |
| union-all | pg | 62.76 | 64.27 | 1.255 | 797/s |
| union-all | @yydb/postgres | 60.01 | 63.62 | 1.200 | 833/s |
| on-conflict-do-nothing | pg | 41.92 | 44.95 | 0.210 | 4,771/s |
| on-conflict-do-nothing | @yydb/postgres | 36.23 | 37.78 | 0.181 | 5,521/s |
| insert-returning | pg | 381.66 | 385.78 | 3.817 | 262/s |
| insert-returning | @yydb/postgres | 370.00 | 376.51 | 3.700 | 270/s |
| explain | pg | 9.77 | 10.59 | 0.195 | 5,116/s |
| explain | @yydb/postgres | 10.15 | 10.55 | 0.203 | 4,925/s |
| view-select | pg | 27.11 | 27.73 | 0.542 | 1,844/s |
| view-select | @yydb/postgres | 23.82 | 24.00 | 0.476 | 2,099/s |
| vacuum-analyze | pg | 9.80 | 10.88 | 0.098 | 10,204/s |
| vacuum-analyze | @yydb/postgres | 9.24 | 9.68 | 0.092 | 10,819/s |
| array-agg | pg | 18.38 | 18.90 | 0.368 | 2,720/s |
| array-agg | @yydb/postgres | 16.54 | 16.65 | 0.331 | 3,023/s |
| unnest-array | pg | 14.72 | 15.57 | 0.294 | 3,396/s |
| unnest-array | @yydb/postgres | 13.54 | 13.70 | 0.271 | 3,694/s |
| like-prefix | pg | 19.36 | 19.97 | 0.387 | 2,582/s |
| like-prefix | @yydb/postgres | 17.65 | 18.28 | 0.353 | 2,834/s |
| ilike-filter | pg | 18.96 | 19.96 | 0.379 | 2,637/s |
| ilike-filter | @yydb/postgres | 18.90 | 19.70 | 0.378 | 2,645/s |
| regex-filter | pg | 19.22 | 19.68 | 0.384 | 2,602/s |
| regex-filter | @yydb/postgres | 17.78 | 18.19 | 0.356 | 2,812/s |
| group-having | pg | 20.64 | 21.25 | 0.413 | 2,422/s |
| group-having | @yydb/postgres | 20.43 | 20.52 | 0.409 | 2,447/s |

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
