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
| 本仓 rev | `c1deb44` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.71x** |
| insert | 1.00x | **0.93x** |
| select-point | 1.00x | **0.77x** |
| simple-point | 1.00x | **0.88x** |
| select-scan | **1.00x** | 1.12x |
| prepared-point | 1.00x | **0.73x** |
| tx-prepared | 1.00x | **0.69x** |
| point-uk | 1.00x | **0.99x** |
| order-limit | 1.00x | **0.87x** |
| group-by | **1.00x** | 1.00x |
| join | **1.00x** | 1.03x |
| batch-insert | **1.00x** | 1.06x |
| batch-insert-params | 1.00x | **1.00x** |
| distinct | 1.00x | **0.94x** |
| aggregate | 1.00x | **0.91x** |
| subquery | 1.00x | **0.93x** |
| index-range | **1.00x** | 1.05x |
| upsert | 1.00x | **1.00x** |
| update | **1.00x** | 1.02x |
| update-returning | **1.00x** | 1.04x |
| delete | **1.00x** | 1.04x |
| wide-row | 1.00x | **0.93x** |
| error-constraint | 1.00x | **0.88x** |
| error-undefined-table | 1.00x | **0.98x** |
| aborted-transaction | 1.00x | **0.84x** |
| rollback | 1.00x | **0.81x** |
| portal-batch-fetch | 1.00x | **0.81x** |
| temp-table | 1.00x | **0.96x** |
| multi-statement | 1.00x | **1.00x** |
| constraint-violation-rollback | 1.00x | **0.94x** |
| repeatable-read-tx | 1.00x | **0.83x** |
| update-delete-bulk | **1.00x** | 1.76x |
| copy-from | 1.00x | **0.86x** |
| savepoint-rollback | 1.00x | **0.94x** |
| listen-notify | **1.00x** | 1.58x |
| large-result-cursor | 1.00x | **0.83x** |
| cte | 1.00x | **0.89x** |
| recursive-cte | 1.00x | **0.94x** |
| window | 1.00x | **0.89x** |
| union-all | **1.00x** | 1.11x |
| on-conflict-do-nothing | 1.00x | **0.87x** |
| insert-returning | 1.00x | **0.98x** |
| explain | 1.00x | **0.86x** |
| view-select | **1.00x** | 1.03x |
| vacuum-analyze | 1.00x | **0.80x** |
| array-agg | **1.00x** | 1.02x |
| unnest-array | 1.00x | **0.81x** |
| like-prefix | 1.00x | **0.92x** |
| ilike-filter | 1.00x | **0.92x** |
| regex-filter | 1.00x | **0.90x** |
| group-having | **1.00x** | 1.06x |
| full-outer-join | 1.00x | **0.87x** |
| except | 1.00x | **0.99x** |
| intersect | **1.00x** | 2.08x |
| filter-aggregate | 1.00x | **0.86x** |
| any-array | 1.00x | **0.97x** |
| limit-offset | **1.00x** | 1.04x |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 32.84 | 33.39 | 0.657 | 1,523/s |
| connect | @yydb/postgres | 23.40 | 23.43 | 0.468 | 2,137/s |
| insert | pg | 703.58 | 1039.90 | 3.518 | 284/s |
| insert | @yydb/postgres | 655.18 | 714.38 | 3.276 | 305/s |
| select-point | pg | 144.01 | 148.05 | 0.288 | 3,472/s |
| select-point | @yydb/postgres | 110.61 | 118.60 | 0.221 | 4,520/s |
| simple-point | pg | 115.31 | 123.79 | 0.231 | 4,336/s |
| simple-point | @yydb/postgres | 101.13 | 103.00 | 0.202 | 4,944/s |
| select-scan | pg | 9.59 | 10.49 | 0.010 | 104,301/s |
| select-scan | @yydb/postgres | 10.73 | 11.61 | 0.011 | 93,156/s |
| prepared-point | pg | 123.39 | 127.14 | 0.247 | 4,052/s |
| prepared-point | @yydb/postgres | 90.50 | 91.27 | 0.181 | 5,525/s |
| tx-prepared | pg | 55.46 | 58.16 | 0.277 | 3,606/s |
| tx-prepared | @yydb/postgres | 38.15 | 41.62 | 0.191 | 5,242/s |
| point-uk | pg | 133.43 | 135.19 | 0.267 | 3,747/s |
| point-uk | @yydb/postgres | 131.78 | 135.90 | 0.264 | 3,794/s |
| order-limit | pg | 22.25 | 34.50 | 0.445 | 2,248/s |
| order-limit | @yydb/postgres | 19.41 | 20.82 | 0.388 | 2,575/s |
| group-by | pg | 24.93 | 26.40 | 0.499 | 2,005/s |
| group-by | @yydb/postgres | 24.97 | 27.28 | 0.499 | 2,002/s |
| join | pg | 46.00 | 46.46 | 0.920 | 1,087/s |
| join | @yydb/postgres | 47.15 | 48.68 | 0.943 | 1,060/s |
| batch-insert | pg | 47.74 | 52.64 | 0.239 | 4,190/s |
| batch-insert | @yydb/postgres | 50.69 | 52.34 | 0.253 | 3,945/s |
| batch-insert-params | pg | 46.38 | 46.78 | 0.232 | 4,312/s |
| batch-insert-params | @yydb/postgres | 46.34 | 48.78 | 0.232 | 4,316/s |
| distinct | pg | 20.10 | 20.81 | 0.402 | 2,488/s |
| distinct | @yydb/postgres | 18.98 | 18.99 | 0.380 | 2,634/s |
| aggregate | pg | 20.40 | 25.14 | 0.408 | 2,451/s |
| aggregate | @yydb/postgres | 18.53 | 18.88 | 0.371 | 2,699/s |
| subquery | pg | 56.46 | 59.65 | 1.129 | 886/s |
| subquery | @yydb/postgres | 52.26 | 55.24 | 1.045 | 957/s |
| index-range | pg | 65.44 | 69.09 | 0.654 | 1,528/s |
| index-range | @yydb/postgres | 68.65 | 70.35 | 0.687 | 1,457/s |
| upsert | pg | 777.93 | 786.29 | 3.890 | 257/s |
| upsert | @yydb/postgres | 777.72 | 867.28 | 3.889 | 257/s |
| update | pg | 767.79 | 779.89 | 3.839 | 260/s |
| update | @yydb/postgres | 779.92 | 843.70 | 3.900 | 256/s |
| update-returning | pg | 389.87 | 400.33 | 3.899 | 256/s |
| update-returning | @yydb/postgres | 404.13 | 515.58 | 4.041 | 247/s |
| delete | pg | 665.07 | 667.68 | 3.325 | 301/s |
| delete | @yydb/postgres | 689.51 | 701.09 | 3.448 | 290/s |
| wide-row | pg | 25.84 | 29.17 | 0.258 | 3,870/s |
| wide-row | @yydb/postgres | 24.03 | 25.84 | 0.240 | 4,161/s |
| error-constraint | pg | 42.45 | 45.14 | 0.424 | 2,356/s |
| error-constraint | @yydb/postgres | 37.38 | 41.24 | 0.374 | 2,675/s |
| error-undefined-table | pg | 31.82 | 38.64 | 0.318 | 3,143/s |
| error-undefined-table | @yydb/postgres | 31.26 | 32.45 | 0.313 | 3,198/s |
| aborted-transaction | pg | 47.93 | 49.55 | 0.959 | 1,043/s |
| aborted-transaction | @yydb/postgres | 40.16 | 46.72 | 0.803 | 1,245/s |
| rollback | pg | 52.14 | 56.48 | 0.261 | 3,836/s |
| rollback | @yydb/postgres | 42.10 | 44.76 | 0.211 | 4,750/s |
| portal-batch-fetch | pg | 35.10 | 38.90 | 0.018 | 56,973/s |
| portal-batch-fetch | @yydb/postgres | 28.40 | 28.63 | 0.014 | 70,417/s |
| temp-table | pg | 87.21 | 101.04 | 1.744 | 573/s |
| temp-table | @yydb/postgres | 84.10 | 84.47 | 1.682 | 594/s |
| multi-statement | pg | 27.71 | 31.11 | 0.055 | 18,042/s |
| multi-statement | @yydb/postgres | 27.66 | 29.55 | 0.055 | 18,079/s |
| constraint-violation-rollback | pg | 64.15 | 75.30 | 0.642 | 1,559/s |
| constraint-violation-rollback | @yydb/postgres | 60.22 | 64.55 | 0.602 | 1,661/s |
| repeatable-read-tx | pg | 72.82 | 72.96 | 0.243 | 4,120/s |
| repeatable-read-tx | @yydb/postgres | 60.45 | 64.41 | 0.201 | 4,963/s |
| update-delete-bulk | pg | 36.97 | 38.48 | 0.092 | 10,821/s |
| update-delete-bulk | @yydb/postgres | 65.20 | 69.72 | 0.163 | 6,135/s |
| copy-from | pg | 219.15 | 220.66 | 0.110 | 9,126/s |
| copy-from | @yydb/postgres | 188.01 | 214.04 | 0.094 | 10,637/s |
| savepoint-rollback | pg | 110.05 | 110.14 | 0.688 | 1,454/s |
| savepoint-rollback | @yydb/postgres | 103.97 | 107.81 | 0.650 | 1,539/s |
| listen-notify | pg | 13.65 | 22.17 | 0.137 | 7,326/s |
| listen-notify | @yydb/postgres | 21.58 | 22.48 | 0.216 | 4,635/s |
| large-result-cursor | pg | 32.15 | 37.32 | 0.016 | 62,217/s |
| large-result-cursor | @yydb/postgres | 26.68 | 27.19 | 0.013 | 74,963/s |
| cte | pg | 24.28 | 24.48 | 0.486 | 2,059/s |
| cte | @yydb/postgres | 21.49 | 21.99 | 0.430 | 2,327/s |
| recursive-cte | pg | 252.25 | 258.17 | 2.523 | 396/s |
| recursive-cte | @yydb/postgres | 237.26 | 245.49 | 2.373 | 421/s |
| window | pg | 31.23 | 31.49 | 0.625 | 1,601/s |
| window | @yydb/postgres | 27.81 | 28.49 | 0.556 | 1,798/s |
| union-all | pg | 55.74 | 59.41 | 1.115 | 897/s |
| union-all | @yydb/postgres | 61.96 | 66.89 | 1.239 | 807/s |
| on-conflict-do-nothing | pg | 39.39 | 40.79 | 0.197 | 5,077/s |
| on-conflict-do-nothing | @yydb/postgres | 34.13 | 34.38 | 0.171 | 5,859/s |
| insert-returning | pg | 397.75 | 422.32 | 3.977 | 251/s |
| insert-returning | @yydb/postgres | 389.59 | 393.76 | 3.896 | 257/s |
| explain | pg | 12.46 | 12.72 | 0.249 | 4,013/s |
| explain | @yydb/postgres | 10.66 | 11.29 | 0.213 | 4,692/s |
| view-select | pg | 25.37 | 32.14 | 0.507 | 1,971/s |
| view-select | @yydb/postgres | 26.25 | 26.65 | 0.525 | 1,904/s |
| vacuum-analyze | pg | 12.35 | 13.10 | 0.123 | 8,100/s |
| vacuum-analyze | @yydb/postgres | 9.90 | 10.14 | 0.099 | 10,104/s |
| array-agg | pg | 16.86 | 16.92 | 0.337 | 2,966/s |
| array-agg | @yydb/postgres | 17.15 | 20.29 | 0.343 | 2,916/s |
| unnest-array | pg | 16.12 | 16.43 | 0.322 | 3,102/s |
| unnest-array | @yydb/postgres | 13.03 | 13.30 | 0.261 | 3,836/s |
| like-prefix | pg | 20.11 | 21.70 | 0.402 | 2,486/s |
| like-prefix | @yydb/postgres | 18.51 | 18.72 | 0.370 | 2,702/s |
| ilike-filter | pg | 19.21 | 20.10 | 0.384 | 2,603/s |
| ilike-filter | @yydb/postgres | 17.73 | 18.46 | 0.355 | 2,821/s |
| regex-filter | pg | 19.11 | 20.65 | 0.382 | 2,616/s |
| regex-filter | @yydb/postgres | 17.13 | 20.70 | 0.343 | 2,919/s |
| group-having | pg | 19.58 | 20.59 | 0.392 | 2,553/s |
| group-having | @yydb/postgres | 20.70 | 40.79 | 0.414 | 2,415/s |
| full-outer-join | pg | 27.12 | 28.47 | 0.542 | 1,844/s |
| full-outer-join | @yydb/postgres | 23.69 | 25.15 | 0.474 | 2,110/s |
| except | pg | 35.07 | 38.01 | 0.701 | 1,426/s |
| except | @yydb/postgres | 34.72 | 36.18 | 0.694 | 1,440/s |
| intersect | pg | 34.81 | 36.01 | 0.696 | 1,436/s |
| intersect | @yydb/postgres | 72.40 | 74.16 | 1.448 | 691/s |
| filter-aggregate | pg | 23.37 | 25.74 | 0.467 | 2,139/s |
| filter-aggregate | @yydb/postgres | 20.07 | 20.92 | 0.401 | 2,492/s |
| any-array | pg | 56.11 | 56.38 | 1.122 | 891/s |
| any-array | @yydb/postgres | 54.22 | 56.85 | 1.084 | 922/s |
| limit-offset | pg | 19.59 | 21.01 | 0.392 | 2,552/s |
| limit-offset | @yydb/postgres | 20.29 | 20.78 | 0.406 | 2,464/s |

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
