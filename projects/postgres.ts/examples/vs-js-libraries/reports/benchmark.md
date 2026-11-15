# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=3`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_RECURSIVE=100`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`, `BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`, `BENCH_RR_ROWS=10`, `BENCH_BULK=20`, `BENCH_BULK_ROWS=10`, `BENCH_COPY=2000`, `BENCH_SAVEPOINT=20`, `BENCH_NOTIFY=100`, `BENCH_CURSOR=10`, `BENCH_CURSOR_PAGE=50`, `BENCH_CONNECT=50`, `BENCH_MISSING=100`, `BENCH_ABORT=50`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `044f90a` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.74x** |
| insert | 1.00x | **0.80x** |
| select-point | 1.00x | **0.82x** |
| simple-point | 1.00x | **0.81x** |
| select-scan | **1.00x** | 1.01x |
| prepared-point | 1.00x | **0.78x** |
| tx-prepared | 1.00x | **0.70x** |
| point-uk | 1.00x | **0.93x** |
| order-limit | **1.00x** | 1.02x |
| group-by | **1.00x** | 1.05x |
| join | **1.00x** | 1.02x |
| batch-insert | 1.00x | **0.99x** |
| batch-insert-params | **1.00x** | 1.05x |
| distinct | 1.00x | **1.00x** |
| aggregate | 1.00x | **0.90x** |
| subquery | 1.00x | **0.99x** |
| index-range | **1.00x** | 1.02x |
| upsert | **1.00x** | 1.44x |
| update | 1.00x | **0.97x** |
| update-returning | **1.00x** | 1.01x |
| delete | **1.00x** | 1.06x |
| wide-row | 1.00x | **0.94x** |
| error-constraint | 1.00x | **0.92x** |
| error-undefined-table | 1.00x | **0.91x** |
| aborted-transaction | 1.00x | **0.86x** |
| rollback | **1.00x** | 1.02x |
| portal-batch-fetch | 1.00x | **0.81x** |
| temp-table | 1.00x | **0.96x** |
| multi-statement | 1.00x | **0.94x** |
| constraint-violation-rollback | 1.00x | **0.93x** |
| repeatable-read-tx | 1.00x | **0.93x** |
| update-delete-bulk | 1.00x | **0.85x** |
| copy-from | **1.00x** | 1.05x |
| savepoint-rollback | **1.00x** | 1.32x |
| listen-notify | 1.00x | **0.79x** |
| large-result-cursor | 1.00x | **0.98x** |
| cte | 1.00x | **0.99x** |
| recursive-cte | 1.00x | **0.98x** |
| window | 1.00x | **0.94x** |
| union-all | **1.00x** | 1.10x |
| on-conflict-do-nothing | 1.00x | **0.86x** |
| insert-returning | **1.00x** | 1.13x |
| explain | **1.00x** | 1.07x |
| view-select | 1.00x | **0.96x** |
| vacuum-analyze | 1.00x | **0.93x** |
| array-agg | 1.00x | **0.88x** |
| unnest-array | 1.00x | **0.74x** |
| like-prefix | 1.00x | **0.92x** |
| ilike-filter | 1.00x | **0.94x** |
| regex-filter | **1.00x** | 1.03x |
| group-having | 1.00x | **0.99x** |
| full-outer-join | **1.00x** | 1.05x |
| except | 1.00x | **0.92x** |
| intersect | 1.00x | **0.98x** |
| filter-aggregate | 1.00x | **0.93x** |
| any-array | 1.00x | **0.89x** |
| limit-offset | **1.00x** | 1.03x |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 33.52 | 35.65 | 0.670 | 1,491/s |
| connect | @yydb/postgres | 24.82 | 25.18 | 0.496 | 2,014/s |
| insert | pg | 909.99 | 1133.58 | 4.550 | 220/s |
| insert | @yydb/postgres | 724.00 | 825.76 | 3.620 | 276/s |
| select-point | pg | 149.46 | 150.16 | 0.299 | 3,345/s |
| select-point | @yydb/postgres | 122.40 | 124.62 | 0.245 | 4,085/s |
| simple-point | pg | 109.80 | 134.28 | 0.220 | 4,554/s |
| simple-point | @yydb/postgres | 88.70 | 122.03 | 0.177 | 5,637/s |
| select-scan | pg | 10.41 | 10.82 | 0.010 | 96,105/s |
| select-scan | @yydb/postgres | 10.51 | 13.20 | 0.011 | 95,186/s |
| prepared-point | pg | 124.28 | 139.58 | 0.249 | 4,023/s |
| prepared-point | @yydb/postgres | 97.25 | 105.50 | 0.194 | 5,142/s |
| tx-prepared | pg | 61.02 | 61.46 | 0.305 | 3,278/s |
| tx-prepared | @yydb/postgres | 42.67 | 42.79 | 0.213 | 4,687/s |
| point-uk | pg | 142.61 | 143.97 | 0.285 | 3,506/s |
| point-uk | @yydb/postgres | 132.86 | 136.20 | 0.266 | 3,763/s |
| order-limit | pg | 20.12 | 21.07 | 0.402 | 2,485/s |
| order-limit | @yydb/postgres | 20.44 | 21.85 | 0.409 | 2,446/s |
| group-by | pg | 26.47 | 26.68 | 0.529 | 1,889/s |
| group-by | @yydb/postgres | 27.69 | 28.46 | 0.554 | 1,805/s |
| join | pg | 47.11 | 49.06 | 0.942 | 1,061/s |
| join | @yydb/postgres | 48.10 | 48.42 | 0.962 | 1,039/s |
| batch-insert | pg | 48.40 | 51.38 | 0.242 | 4,132/s |
| batch-insert | @yydb/postgres | 47.99 | 54.28 | 0.240 | 4,168/s |
| batch-insert-params | pg | 48.43 | 50.78 | 0.242 | 4,129/s |
| batch-insert-params | @yydb/postgres | 50.73 | 51.05 | 0.254 | 3,943/s |
| distinct | pg | 18.34 | 19.32 | 0.367 | 2,727/s |
| distinct | @yydb/postgres | 18.26 | 18.57 | 0.365 | 2,739/s |
| aggregate | pg | 22.43 | 23.00 | 0.449 | 2,229/s |
| aggregate | @yydb/postgres | 20.24 | 21.79 | 0.405 | 2,470/s |
| subquery | pg | 57.45 | 59.58 | 1.149 | 870/s |
| subquery | @yydb/postgres | 56.60 | 58.88 | 1.132 | 883/s |
| index-range | pg | 66.59 | 67.45 | 0.666 | 1,502/s |
| index-range | @yydb/postgres | 67.68 | 70.54 | 0.677 | 1,478/s |
| upsert | pg | 761.70 | 1187.11 | 3.808 | 263/s |
| upsert | @yydb/postgres | 1097.87 | 1947.75 | 5.489 | 182/s |
| update | pg | 777.64 | 1165.82 | 3.888 | 257/s |
| update | @yydb/postgres | 757.87 | 767.54 | 3.789 | 264/s |
| update-returning | pg | 391.06 | 401.73 | 3.911 | 256/s |
| update-returning | @yydb/postgres | 393.66 | 786.11 | 3.937 | 254/s |
| delete | pg | 667.73 | 685.70 | 3.339 | 300/s |
| delete | @yydb/postgres | 707.90 | 731.85 | 3.540 | 283/s |
| wide-row | pg | 26.59 | 30.73 | 0.266 | 3,760/s |
| wide-row | @yydb/postgres | 25.13 | 25.43 | 0.251 | 3,980/s |
| error-constraint | pg | 39.90 | 41.19 | 0.399 | 2,506/s |
| error-constraint | @yydb/postgres | 36.60 | 37.08 | 0.366 | 2,732/s |
| error-undefined-table | pg | 32.96 | 34.52 | 0.330 | 3,034/s |
| error-undefined-table | @yydb/postgres | 29.88 | 31.06 | 0.299 | 3,346/s |
| aborted-transaction | pg | 42.38 | 43.63 | 0.848 | 1,180/s |
| aborted-transaction | @yydb/postgres | 36.44 | 38.91 | 0.729 | 1,372/s |
| rollback | pg | 45.08 | 51.57 | 0.225 | 4,437/s |
| rollback | @yydb/postgres | 45.77 | 47.02 | 0.229 | 4,370/s |
| portal-batch-fetch | pg | 33.50 | 35.31 | 0.017 | 59,709/s |
| portal-batch-fetch | @yydb/postgres | 27.24 | 28.77 | 0.014 | 73,430/s |
| temp-table | pg | 82.16 | 84.34 | 1.643 | 609/s |
| temp-table | @yydb/postgres | 79.24 | 79.34 | 1.585 | 631/s |
| multi-statement | pg | 27.65 | 28.11 | 0.055 | 18,082/s |
| multi-statement | @yydb/postgres | 26.12 | 28.19 | 0.052 | 19,144/s |
| constraint-violation-rollback | pg | 59.05 | 69.68 | 0.590 | 1,694/s |
| constraint-violation-rollback | @yydb/postgres | 54.98 | 55.14 | 0.550 | 1,819/s |
| repeatable-read-tx | pg | 71.24 | 72.61 | 0.237 | 4,211/s |
| repeatable-read-tx | @yydb/postgres | 66.04 | 66.31 | 0.220 | 4,542/s |
| update-delete-bulk | pg | 43.29 | 43.61 | 0.108 | 9,239/s |
| update-delete-bulk | @yydb/postgres | 36.80 | 40.29 | 0.092 | 10,870/s |
| copy-from | pg | 190.77 | 192.44 | 0.095 | 10,484/s |
| copy-from | @yydb/postgres | 199.52 | 205.78 | 0.100 | 10,024/s |
| savepoint-rollback | pg | 106.21 | 110.46 | 0.664 | 1,506/s |
| savepoint-rollback | @yydb/postgres | 140.71 | 145.21 | 0.879 | 1,137/s |
| listen-notify | pg | 14.52 | 14.64 | 0.145 | 6,888/s |
| listen-notify | @yydb/postgres | 11.41 | 11.70 | 0.114 | 8,767/s |
| large-result-cursor | pg | 28.14 | 28.38 | 0.014 | 71,061/s |
| large-result-cursor | @yydb/postgres | 27.50 | 29.00 | 0.014 | 72,718/s |
| cte | pg | 20.74 | 26.73 | 0.415 | 2,411/s |
| cte | @yydb/postgres | 20.53 | 23.28 | 0.411 | 2,436/s |
| recursive-cte | pg | 246.74 | 255.06 | 2.467 | 405/s |
| recursive-cte | @yydb/postgres | 242.31 | 262.88 | 2.423 | 413/s |
| window | pg | 29.26 | 29.52 | 0.585 | 1,709/s |
| window | @yydb/postgres | 27.64 | 27.97 | 0.553 | 1,809/s |
| union-all | pg | 55.20 | 58.80 | 1.104 | 906/s |
| union-all | @yydb/postgres | 60.65 | 61.86 | 1.213 | 824/s |
| on-conflict-do-nothing | pg | 39.58 | 40.11 | 0.198 | 5,053/s |
| on-conflict-do-nothing | @yydb/postgres | 33.84 | 34.61 | 0.169 | 5,910/s |
| insert-returning | pg | 401.98 | 404.31 | 4.020 | 249/s |
| insert-returning | @yydb/postgres | 454.03 | 456.33 | 4.540 | 220/s |
| explain | pg | 9.82 | 9.99 | 0.196 | 5,093/s |
| explain | @yydb/postgres | 10.53 | 10.58 | 0.211 | 4,747/s |
| view-select | pg | 25.35 | 26.93 | 0.507 | 1,973/s |
| view-select | @yydb/postgres | 24.28 | 26.22 | 0.486 | 2,060/s |
| vacuum-analyze | pg | 10.48 | 11.95 | 0.105 | 9,545/s |
| vacuum-analyze | @yydb/postgres | 9.77 | 9.98 | 0.098 | 10,234/s |
| array-agg | pg | 18.86 | 21.91 | 0.377 | 2,651/s |
| array-agg | @yydb/postgres | 16.68 | 18.67 | 0.334 | 2,998/s |
| unnest-array | pg | 18.26 | 19.36 | 0.365 | 2,738/s |
| unnest-array | @yydb/postgres | 13.46 | 13.70 | 0.269 | 3,715/s |
| like-prefix | pg | 19.79 | 21.89 | 0.396 | 2,527/s |
| like-prefix | @yydb/postgres | 18.30 | 18.87 | 0.366 | 2,732/s |
| ilike-filter | pg | 18.30 | 20.46 | 0.366 | 2,733/s |
| ilike-filter | @yydb/postgres | 17.27 | 21.14 | 0.345 | 2,896/s |
| regex-filter | pg | 17.61 | 18.86 | 0.352 | 2,839/s |
| regex-filter | @yydb/postgres | 18.06 | 18.26 | 0.361 | 2,769/s |
| group-having | pg | 21.18 | 25.72 | 0.424 | 2,360/s |
| group-having | @yydb/postgres | 21.03 | 22.07 | 0.421 | 2,377/s |
| full-outer-join | pg | 21.72 | 23.82 | 0.434 | 2,302/s |
| full-outer-join | @yydb/postgres | 22.84 | 24.22 | 0.457 | 2,189/s |
| except | pg | 35.67 | 36.04 | 0.713 | 1,402/s |
| except | @yydb/postgres | 32.88 | 33.73 | 0.658 | 1,521/s |
| intersect | pg | 35.63 | 36.75 | 0.713 | 1,403/s |
| intersect | @yydb/postgres | 34.92 | 39.52 | 0.698 | 1,432/s |
| filter-aggregate | pg | 19.31 | 19.90 | 0.386 | 2,590/s |
| filter-aggregate | @yydb/postgres | 17.88 | 18.50 | 0.358 | 2,796/s |
| any-array | pg | 58.36 | 59.27 | 1.167 | 857/s |
| any-array | @yydb/postgres | 52.11 | 54.55 | 1.042 | 960/s |
| limit-offset | pg | 19.32 | 20.73 | 0.386 | 2,588/s |
| limit-offset | @yydb/postgres | 19.87 | 20.36 | 0.397 | 2,517/s |

An op is one completed connection handshake, one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with `RETURNING`, one delete, one row with a `NULL` or 4 KiB cell, one rejected duplicate-key insert, one rejected undefined-table statement, one aborted-transaction round trip, one rolled-back insert, one row fetched through a suspended portal, one temporary-table cycle, one statement inside a multi-statement message, one rejected insert followed by `ROLLBACK`, one repeatable-read point query, one row touched by a bulk `UPDATE`/`DELETE`, one row imported, one savepoint round-trip statement, one notification delivered, one row fetched from a `DECLARE`/`FETCH` cursor, one full outer join projection, one `EXCEPT` projection, one `INTERSECT` projection, one filtered aggregate, one `ANY(ARRAY[...])` point filter, or one offset-paged statement.
One warmup round runs before the measured rounds. The table reports median and p95 of 3 measured rounds.

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
- `temp-table` runs `CREATE TEMP TABLE` / 20-row `INSERT` / `SELECT` / `DROP TABLE` `BENCH_TEMP` times on one connection, so it measures session-local DDL churn. The product keeps both a temp relation's rows and its catalog entries in session memory: a temp-only commit serializes back to the committed catalog JSON and skips the write, so nothing touches the data directory.
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
- `full-outer-join`, `except`, `intersect`, `filter-aggregate`, `any-array` and `limit-offset` run the same literal SQL on both clients over the shared `bench`/`bench_join` shape. `full-outer-join` seeds one extra `bench_join` row so the unmatched side must reappear, `except`/`intersect` split `bench` at half of `BENCH2_ROWS`, `filter-aggregate` counts the `(id * 137) % 997 > 500` rows, `any-array` pins the five ids in `ARRAY[1,2,3,4,5]`, and `limit-offset` pages 20 rows past the first 10.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
