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
| 本仓 rev | `508994a` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.70x** |
| insert | **1.00x** | 1.26x |
| select-point | 1.00x | **0.38x** |
| simple-point | 1.00x | **0.92x** |
| select-scan | 1.00x | **0.88x** |
| prepared-point | 1.00x | **0.63x** |
| tx-prepared | 1.00x | **0.57x** |
| point-uk | 1.00x | **0.84x** |
| order-limit | 1.00x | **0.93x** |
| group-by | 1.00x | **0.83x** |
| join | 1.00x | **0.97x** |
| batch-insert | **1.00x** | 1.00x |
| batch-insert-params | 1.00x | **0.93x** |
| distinct | 1.00x | **0.97x** |
| aggregate | 1.00x | **0.89x** |
| subquery | **1.00x** | 1.84x |
| index-range | 1.00x | **0.68x** |
| upsert | 1.00x | **0.96x** |
| update | **1.00x** | 1.05x |
| update-returning | 1.00x | **0.96x** |
| delete | **1.00x** | 1.07x |
| wide-row | **1.00x** | 1.20x |
| error-constraint | 1.00x | **0.54x** |
| error-undefined-table | 1.00x | **0.89x** |
| aborted-transaction | **1.00x** | 1.05x |
| rollback | **1.00x** | 1.09x |
| portal-batch-fetch | 1.00x | **0.54x** |
| temp-table | **1.00x** | 1.74x |
| multi-statement | 1.00x | **0.87x** |
| constraint-violation-rollback | **1.00x** | 1.02x |
| repeatable-read-tx | 1.00x | **0.83x** |
| update-delete-bulk | 1.00x | **0.71x** |
| copy-from | **1.00x** | 2.79x |
| savepoint-rollback | 1.00x | **0.96x** |
| listen-notify | 1.00x | **0.86x** |
| large-result-cursor | 1.00x | **0.96x** |
| cte | 1.00x | **0.98x** |
| window | 1.00x | **0.95x** |
| union-all | **1.00x** | 1.02x |
| on-conflict-do-nothing | **1.00x** | 1.11x |
| insert-returning | **1.00x** | 1.89x |
| explain | 1.00x | **0.95x** |
| view-select | 1.00x | **0.86x** |
| vacuum-analyze | 1.00x | **0.93x** |
| array-agg | **1.00x** | 1.49x |
| unnest-array | 1.00x | **0.53x** |
| like-prefix | 1.00x | **0.49x** |
| ilike-filter | 1.00x | **0.91x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 36.39 | 38.78 | 0.728 | 1,374/s |
| connect | @yydb/postgres | 25.39 | 25.56 | 0.508 | 1,969/s |
| insert | pg | 841.42 | 901.54 | 4.207 | 238/s |
| insert | @yydb/postgres | 1060.55 | 1193.39 | 5.303 | 189/s |
| select-point | pg | 305.43 | 372.90 | 0.611 | 1,637/s |
| select-point | @yydb/postgres | 115.68 | 117.97 | 0.231 | 4,322/s |
| simple-point | pg | 110.65 | 115.42 | 0.221 | 4,519/s |
| simple-point | @yydb/postgres | 102.19 | 102.51 | 0.204 | 4,893/s |
| select-scan | pg | 10.93 | 11.09 | 0.011 | 91,516/s |
| select-scan | @yydb/postgres | 9.66 | 10.18 | 0.010 | 103,542/s |
| prepared-point | pg | 132.93 | 144.63 | 0.266 | 3,761/s |
| prepared-point | @yydb/postgres | 83.30 | 85.42 | 0.167 | 6,002/s |
| tx-prepared | pg | 77.69 | 86.47 | 0.388 | 2,574/s |
| tx-prepared | @yydb/postgres | 43.92 | 47.52 | 0.220 | 4,553/s |
| point-uk | pg | 158.79 | 160.15 | 0.318 | 3,149/s |
| point-uk | @yydb/postgres | 133.99 | 136.26 | 0.268 | 3,732/s |
| order-limit | pg | 23.57 | 23.64 | 0.471 | 2,121/s |
| order-limit | @yydb/postgres | 21.85 | 23.87 | 0.437 | 2,289/s |
| group-by | pg | 35.41 | 38.75 | 0.708 | 1,412/s |
| group-by | @yydb/postgres | 29.55 | 30.56 | 0.591 | 1,692/s |
| join | pg | 54.66 | 55.00 | 1.093 | 915/s |
| join | @yydb/postgres | 52.78 | 53.59 | 1.056 | 947/s |
| batch-insert | pg | 52.47 | 56.38 | 0.262 | 3,811/s |
| batch-insert | @yydb/postgres | 52.67 | 54.83 | 0.263 | 3,797/s |
| batch-insert-params | pg | 50.45 | 50.51 | 0.252 | 3,964/s |
| batch-insert-params | @yydb/postgres | 47.00 | 48.35 | 0.235 | 4,255/s |
| distinct | pg | 19.95 | 21.04 | 0.399 | 2,507/s |
| distinct | @yydb/postgres | 19.43 | 21.89 | 0.389 | 2,574/s |
| aggregate | pg | 25.80 | 26.99 | 0.516 | 1,938/s |
| aggregate | @yydb/postgres | 22.84 | 22.96 | 0.457 | 2,189/s |
| subquery | pg | 1351.42 | 1397.13 | 27.028 | 37/s |
| subquery | @yydb/postgres | 2488.24 | 2705.33 | 49.765 | 20/s |
| index-range | pg | 105.15 | 118.01 | 1.051 | 951/s |
| index-range | @yydb/postgres | 71.14 | 74.38 | 0.711 | 1,406/s |
| upsert | pg | 890.65 | 903.84 | 4.453 | 225/s |
| upsert | @yydb/postgres | 852.63 | 858.03 | 4.263 | 235/s |
| update | pg | 928.85 | 983.49 | 4.644 | 215/s |
| update | @yydb/postgres | 970.85 | 1078.28 | 4.854 | 206/s |
| update-returning | pg | 455.01 | 459.56 | 4.550 | 220/s |
| update-returning | @yydb/postgres | 434.93 | 435.75 | 4.349 | 230/s |
| delete | pg | 847.84 | 877.87 | 4.239 | 236/s |
| delete | @yydb/postgres | 905.46 | 925.68 | 4.527 | 221/s |
| wide-row | pg | 45.92 | 50.72 | 0.459 | 2,177/s |
| wide-row | @yydb/postgres | 55.15 | 61.44 | 0.551 | 1,813/s |
| error-constraint | pg | 138.17 | 143.90 | 1.382 | 724/s |
| error-constraint | @yydb/postgres | 74.09 | 84.96 | 0.741 | 1,350/s |
| error-undefined-table | pg | 58.76 | 62.36 | 0.588 | 1,702/s |
| error-undefined-table | @yydb/postgres | 52.30 | 61.60 | 0.523 | 1,912/s |
| aborted-transaction | pg | 76.63 | 83.18 | 1.533 | 652/s |
| aborted-transaction | @yydb/postgres | 80.36 | 82.13 | 1.607 | 622/s |
| rollback | pg | 84.52 | 102.25 | 0.423 | 2,366/s |
| rollback | @yydb/postgres | 91.92 | 100.93 | 0.460 | 2,176/s |
| portal-batch-fetch | pg | 57.25 | 76.17 | 0.029 | 34,933/s |
| portal-batch-fetch | @yydb/postgres | 30.77 | 31.35 | 0.015 | 65,007/s |
| temp-table | pg | 808.70 | 819.59 | 16.174 | 62/s |
| temp-table | @yydb/postgres | 1408.62 | 2019.54 | 28.172 | 35/s |
| multi-statement | pg | 29.46 | 29.86 | 0.059 | 16,971/s |
| multi-statement | @yydb/postgres | 25.77 | 25.77 | 0.052 | 19,404/s |
| constraint-violation-rollback | pg | 63.22 | 64.81 | 0.632 | 1,582/s |
| constraint-violation-rollback | @yydb/postgres | 64.61 | 65.29 | 0.646 | 1,548/s |
| repeatable-read-tx | pg | 78.99 | 79.81 | 0.263 | 3,798/s |
| repeatable-read-tx | @yydb/postgres | 65.38 | 67.81 | 0.218 | 4,588/s |
| update-delete-bulk | pg | 54.24 | 66.43 | 0.136 | 7,375/s |
| update-delete-bulk | @yydb/postgres | 38.28 | 40.71 | 0.096 | 10,449/s |
| copy-from | pg | 197.64 | 198.93 | 0.099 | 10,119/s |
| copy-from | @yydb/postgres | 551.19 | 887.30 | 0.276 | 3,629/s |
| savepoint-rollback | pg | 127.97 | 153.87 | 0.800 | 1,250/s |
| savepoint-rollback | @yydb/postgres | 122.40 | 136.80 | 0.765 | 1,307/s |
| listen-notify | pg | 12.70 | 12.91 | 0.127 | 7,873/s |
| listen-notify | @yydb/postgres | 10.95 | 11.01 | 0.109 | 9,136/s |
| large-result-cursor | pg | 26.94 | 27.85 | 0.013 | 74,246/s |
| large-result-cursor | @yydb/postgres | 25.86 | 26.71 | 0.013 | 77,328/s |
| cte | pg | 23.92 | 24.22 | 0.478 | 2,091/s |
| cte | @yydb/postgres | 23.43 | 24.78 | 0.469 | 2,134/s |
| window | pg | 30.29 | 31.15 | 0.606 | 1,651/s |
| window | @yydb/postgres | 28.90 | 29.81 | 0.578 | 1,730/s |
| union-all | pg | 59.53 | 61.12 | 1.191 | 840/s |
| union-all | @yydb/postgres | 60.52 | 60.81 | 1.210 | 826/s |
| on-conflict-do-nothing | pg | 41.36 | 42.92 | 0.207 | 4,836/s |
| on-conflict-do-nothing | @yydb/postgres | 46.08 | 53.48 | 0.230 | 4,340/s |
| insert-returning | pg | 428.40 | 439.74 | 4.284 | 233/s |
| insert-returning | @yydb/postgres | 810.59 | 1196.30 | 8.106 | 123/s |
| explain | pg | 10.38 | 10.62 | 0.208 | 4,818/s |
| explain | @yydb/postgres | 9.89 | 9.97 | 0.198 | 5,057/s |
| view-select | pg | 28.92 | 30.42 | 0.578 | 1,729/s |
| view-select | @yydb/postgres | 24.95 | 26.83 | 0.499 | 2,004/s |
| vacuum-analyze | pg | 11.04 | 11.40 | 0.110 | 9,059/s |
| vacuum-analyze | @yydb/postgres | 10.24 | 10.75 | 0.102 | 9,770/s |
| array-agg | pg | 19.17 | 20.40 | 0.383 | 2,608/s |
| array-agg | @yydb/postgres | 28.54 | 38.10 | 0.571 | 1,752/s |
| unnest-array | pg | 31.61 | 31.97 | 0.632 | 1,582/s |
| unnest-array | @yydb/postgres | 16.82 | 17.18 | 0.336 | 2,973/s |
| like-prefix | pg | 49.79 | 51.41 | 0.996 | 1,004/s |
| like-prefix | @yydb/postgres | 24.30 | 27.95 | 0.486 | 2,058/s |
| ilike-filter | pg | 24.87 | 29.71 | 0.497 | 2,010/s |
| ilike-filter | @yydb/postgres | 22.66 | 22.79 | 0.453 | 2,206/s |

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
