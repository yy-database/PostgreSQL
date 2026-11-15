# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=1`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`, `BENCH_RANGE=100`, `BENCH_MUTATE=200`, `BENCH_UPSERT=200`, `BENCH_SIMPLE=500`, `BENCH_TX_PREPARED=200`, `BENCH_RETURNING=100`, `BENCH_WIDE=100`, `BENCH_ERROR=100`, `BENCH_PORTAL=10`, `BENCH_PAGE=20`, `BENCH_TEMP=50`, `BENCH_MULTI=100`, `BENCH_MULTI_STATEMENTS=5`, `BENCH_CVR=100`, `BENCH_RR=30`, `BENCH_RR_ROWS=10`, `BENCH_BULK=20`, `BENCH_BULK_ROWS=10`, `BENCH_COPY=2000`, `BENCH_SAVEPOINT=20`, `BENCH_NOTIFY=100`, `BENCH_CURSOR=10`, `BENCH_CURSOR_PAGE=50`, `BENCH_CONNECT=50`, `BENCH_MISSING=100`, `BENCH_ABORT=50`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `b9d31e6` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.71x** |
| insert | 1.00x | **0.96x** |
| select-point | **1.00x** | 1.05x |
| simple-point | 1.00x | **0.85x** |
| select-scan | 1.00x | **0.87x** |
| prepared-point | 1.00x | **0.61x** |
| tx-prepared | 1.00x | **0.64x** |
| point-uk | 1.00x | **0.80x** |
| order-limit | 1.00x | **0.95x** |
| group-by | 1.00x | **0.89x** |
| join | 1.00x | **1.00x** |
| batch-insert | **1.00x** | 1.01x |
| batch-insert-params | **1.00x** | 1.08x |
| distinct | **1.00x** | 1.07x |
| aggregate | 1.00x | **0.85x** |
| subquery | **1.00x** | 1.02x |
| index-range | 1.00x | **0.99x** |
| upsert | **1.00x** | 1.00x |
| update | **1.00x** | 1.00x |
| update-returning | **1.00x** | 1.02x |
| delete | 1.00x | **1.00x** |
| wide-row | 1.00x | **0.74x** |
| error-constraint | 1.00x | **0.96x** |
| error-undefined-table | 1.00x | **0.84x** |
| aborted-transaction | 1.00x | **0.87x** |
| rollback | 1.00x | **0.83x** |
| portal-batch-fetch | 1.00x | **0.72x** |
| temp-table | **1.00x** | 1.05x |
| multi-statement | 1.00x | **0.87x** |
| constraint-violation-rollback | 1.00x | **0.85x** |
| repeatable-read-tx | 1.00x | **0.69x** |
| update-delete-bulk | 1.00x | **1.00x** |
| copy-from | **1.00x** | 1.05x |
| savepoint-rollback | 1.00x | **0.99x** |
| listen-notify | 1.00x | **0.91x** |
| large-result-cursor | **1.00x** | 1.07x |
| cte | 1.00x | **0.83x** |
| window | 1.00x | **0.90x** |
| union-all | **1.00x** | 1.09x |
| on-conflict-do-nothing | 1.00x | **0.87x** |
| insert-returning | 1.00x | **0.99x** |
| explain | 1.00x | **0.83x** |
| view-select | 1.00x | **0.96x** |
| vacuum-analyze | 1.00x | **0.86x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 34.45 | 34.45 | 0.689 | 1,451/s |
| connect | @yydb/postgres | 24.45 | 24.45 | 0.489 | 2,045/s |
| insert | pg | 840.24 | 840.24 | 4.201 | 238/s |
| insert | @yydb/postgres | 808.51 | 808.51 | 4.043 | 247/s |
| select-point | pg | 126.31 | 126.31 | 0.253 | 3,959/s |
| select-point | @yydb/postgres | 132.79 | 132.79 | 0.266 | 3,765/s |
| simple-point | pg | 117.61 | 117.61 | 0.235 | 4,251/s |
| simple-point | @yydb/postgres | 99.40 | 99.40 | 0.199 | 5,030/s |
| select-scan | pg | 10.80 | 10.80 | 0.011 | 92,594/s |
| select-scan | @yydb/postgres | 9.41 | 9.41 | 0.009 | 106,287/s |
| prepared-point | pg | 140.36 | 140.36 | 0.281 | 3,562/s |
| prepared-point | @yydb/postgres | 85.64 | 85.64 | 0.171 | 5,838/s |
| tx-prepared | pg | 58.88 | 58.88 | 0.294 | 3,397/s |
| tx-prepared | @yydb/postgres | 37.88 | 37.88 | 0.189 | 5,280/s |
| point-uk | pg | 155.66 | 155.66 | 0.311 | 3,212/s |
| point-uk | @yydb/postgres | 124.65 | 124.65 | 0.249 | 4,011/s |
| order-limit | pg | 23.25 | 23.25 | 0.465 | 2,150/s |
| order-limit | @yydb/postgres | 22.19 | 22.19 | 0.444 | 2,254/s |
| group-by | pg | 32.16 | 32.16 | 0.643 | 1,555/s |
| group-by | @yydb/postgres | 28.59 | 28.59 | 0.572 | 1,749/s |
| join | pg | 48.09 | 48.09 | 0.962 | 1,040/s |
| join | @yydb/postgres | 47.99 | 47.99 | 0.960 | 1,042/s |
| batch-insert | pg | 49.00 | 49.00 | 0.245 | 4,082/s |
| batch-insert | @yydb/postgres | 49.44 | 49.44 | 0.247 | 4,045/s |
| batch-insert-params | pg | 48.87 | 48.87 | 0.244 | 4,093/s |
| batch-insert-params | @yydb/postgres | 52.99 | 52.99 | 0.265 | 3,774/s |
| distinct | pg | 19.09 | 19.09 | 0.382 | 2,619/s |
| distinct | @yydb/postgres | 20.45 | 20.45 | 0.409 | 2,445/s |
| aggregate | pg | 20.99 | 20.99 | 0.420 | 2,382/s |
| aggregate | @yydb/postgres | 17.90 | 17.90 | 0.358 | 2,793/s |
| subquery | pg | 1148.31 | 1148.31 | 22.966 | 44/s |
| subquery | @yydb/postgres | 1166.36 | 1166.36 | 23.327 | 43/s |
| index-range | pg | 68.37 | 68.37 | 0.684 | 1,463/s |
| index-range | @yydb/postgres | 67.54 | 67.54 | 0.675 | 1,481/s |
| upsert | pg | 805.37 | 805.37 | 4.027 | 248/s |
| upsert | @yydb/postgres | 805.96 | 805.96 | 4.030 | 248/s |
| update | pg | 827.41 | 827.41 | 4.137 | 242/s |
| update | @yydb/postgres | 830.33 | 830.33 | 4.152 | 241/s |
| update-returning | pg | 413.62 | 413.62 | 4.136 | 242/s |
| update-returning | @yydb/postgres | 420.95 | 420.95 | 4.210 | 238/s |
| delete | pg | 797.09 | 797.09 | 3.985 | 251/s |
| delete | @yydb/postgres | 793.52 | 793.52 | 3.968 | 252/s |
| wide-row | pg | 29.46 | 29.46 | 0.295 | 3,395/s |
| wide-row | @yydb/postgres | 21.90 | 21.90 | 0.219 | 4,565/s |
| error-constraint | pg | 48.97 | 48.97 | 0.490 | 2,042/s |
| error-constraint | @yydb/postgres | 46.89 | 46.89 | 0.469 | 2,133/s |
| error-undefined-table | pg | 39.23 | 39.23 | 0.392 | 2,549/s |
| error-undefined-table | @yydb/postgres | 32.89 | 32.89 | 0.329 | 3,040/s |
| aborted-transaction | pg | 51.14 | 51.14 | 1.023 | 978/s |
| aborted-transaction | @yydb/postgres | 44.72 | 44.72 | 0.894 | 1,118/s |
| rollback | pg | 57.04 | 57.04 | 0.285 | 3,506/s |
| rollback | @yydb/postgres | 47.62 | 47.62 | 0.238 | 4,200/s |
| portal-batch-fetch | pg | 45.45 | 45.45 | 0.023 | 44,001/s |
| portal-batch-fetch | @yydb/postgres | 32.74 | 32.74 | 0.016 | 61,091/s |
| temp-table | pg | 713.58 | 713.58 | 14.272 | 70/s |
| temp-table | @yydb/postgres | 751.62 | 751.62 | 15.032 | 67/s |
| multi-statement | pg | 32.62 | 32.62 | 0.065 | 15,327/s |
| multi-statement | @yydb/postgres | 28.45 | 28.45 | 0.057 | 17,574/s |
| constraint-violation-rollback | pg | 72.02 | 72.02 | 0.720 | 1,388/s |
| constraint-violation-rollback | @yydb/postgres | 61.46 | 61.46 | 0.615 | 1,627/s |
| repeatable-read-tx | pg | 89.63 | 89.63 | 0.299 | 3,347/s |
| repeatable-read-tx | @yydb/postgres | 62.26 | 62.26 | 0.208 | 4,819/s |
| update-delete-bulk | pg | 34.42 | 34.42 | 0.086 | 11,622/s |
| update-delete-bulk | @yydb/postgres | 34.35 | 34.35 | 0.086 | 11,646/s |
| copy-from | pg | 209.04 | 209.04 | 0.105 | 9,568/s |
| copy-from | @yydb/postgres | 218.51 | 218.51 | 0.109 | 9,153/s |
| savepoint-rollback | pg | 130.32 | 130.32 | 0.815 | 1,228/s |
| savepoint-rollback | @yydb/postgres | 128.76 | 128.76 | 0.805 | 1,243/s |
| listen-notify | pg | 16.06 | 16.06 | 0.161 | 6,225/s |
| listen-notify | @yydb/postgres | 14.64 | 14.64 | 0.146 | 6,830/s |
| large-result-cursor | pg | 29.34 | 29.34 | 0.015 | 68,158/s |
| large-result-cursor | @yydb/postgres | 31.45 | 31.45 | 0.016 | 63,590/s |
| cte | pg | 25.86 | 25.86 | 0.517 | 1,934/s |
| cte | @yydb/postgres | 21.51 | 21.51 | 0.430 | 2,324/s |
| window | pg | 33.70 | 33.70 | 0.674 | 1,484/s |
| window | @yydb/postgres | 30.47 | 30.47 | 0.609 | 1,641/s |
| union-all | pg | 67.19 | 67.19 | 1.344 | 744/s |
| union-all | @yydb/postgres | 73.38 | 73.38 | 1.468 | 681/s |
| on-conflict-do-nothing | pg | 41.53 | 41.53 | 0.208 | 4,816/s |
| on-conflict-do-nothing | @yydb/postgres | 36.12 | 36.12 | 0.181 | 5,537/s |
| insert-returning | pg | 411.64 | 411.64 | 4.116 | 243/s |
| insert-returning | @yydb/postgres | 408.08 | 408.08 | 4.081 | 245/s |
| explain | pg | 12.79 | 12.79 | 0.256 | 3,910/s |
| explain | @yydb/postgres | 10.61 | 10.61 | 0.212 | 4,712/s |
| view-select | pg | 27.74 | 27.74 | 0.555 | 1,802/s |
| view-select | @yydb/postgres | 26.69 | 26.69 | 0.534 | 1,873/s |
| vacuum-analyze | pg | 12.10 | 12.10 | 0.121 | 8,267/s |
| vacuum-analyze | @yydb/postgres | 10.42 | 10.42 | 0.104 | 9,600/s |

An op is one completed connection handshake, one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with `RETURNING`, one delete, one row with a `NULL` or 4 KiB cell, one rejected duplicate-key insert, one rejected undefined-table statement, one aborted-transaction round trip, one rolled-back insert, one row fetched through a suspended portal, one temporary-table cycle, one statement inside a multi-statement message, one rejected insert followed by `ROLLBACK`, one repeatable-read point query, one row touched by a bulk `UPDATE`/`DELETE`, one row imported, one savepoint round-trip statement, one notification delivered, or one row fetched from a `DECLARE`/`FETCH` cursor.
One warmup round runs before the measured rounds. The table reports median and p95 of 1 measured rounds.

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
