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
| 本仓 rev | `de40506` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| connect | 1.00x | **0.83x** |
| insert | 1.00x | **0.92x** |
| select-point | 1.00x | **0.81x** |
| simple-point | 1.00x | **0.96x** |
| select-scan | **1.00x** | 1.05x |
| prepared-point | 1.00x | **0.58x** |
| tx-prepared | 1.00x | **0.70x** |
| point-uk | 1.00x | **0.89x** |
| order-limit | **1.00x** | 1.00x |
| group-by | 1.00x | **0.99x** |
| join | 1.00x | **1.00x** |
| batch-insert | **1.00x** | 1.02x |
| batch-insert-params | **1.00x** | 1.01x |
| distinct | **1.00x** | 1.01x |
| aggregate | 1.00x | **0.93x** |
| subquery | **1.00x** | 1.09x |
| index-range | 1.00x | **1.00x** |
| upsert | **1.00x** | 1.01x |
| update | 1.00x | **0.94x** |
| update-returning | **1.00x** | 1.90x |
| delete | **1.00x** | 1.37x |
| wide-row | **1.00x** | 1.08x |
| error-constraint | **1.00x** | 1.11x |
| error-undefined-table | 1.00x | **0.86x** |
| aborted-transaction | 1.00x | **0.79x** |
| rollback | 1.00x | **0.89x** |
| portal-batch-fetch | 1.00x | **0.98x** |
| temp-table | **1.00x** | 1.04x |
| multi-statement | 1.00x | **0.89x** |
| constraint-violation-rollback | 1.00x | **0.67x** |
| repeatable-read-tx | 1.00x | **0.84x** |
| update-delete-bulk | **1.00x** | 1.10x |
| copy-from | 1.00x | **0.96x** |
| savepoint-rollback | 1.00x | **1.00x** |
| listen-notify | 1.00x | **0.86x** |
| large-result-cursor | 1.00x | **1.00x** |
| cte | 1.00x | **0.86x** |
| recursive-cte | 1.00x | **0.98x** |
| window | **1.00x** | 1.03x |
| union-all | **1.00x** | 1.17x |
| on-conflict-do-nothing | 1.00x | **0.83x** |
| insert-returning | 1.00x | **0.99x** |
| explain | 1.00x | **0.78x** |
| view-select | 1.00x | **0.97x** |
| vacuum-analyze | 1.00x | **0.78x** |
| array-agg | **1.00x** | 1.13x |
| unnest-array | 1.00x | **0.95x** |
| like-prefix | 1.00x | **0.86x** |
| ilike-filter | 1.00x | **0.98x** |
| regex-filter | 1.00x | **0.85x** |
| group-having | 1.00x | **0.89x** |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| connect | pg | 31.00 | 32.71 | 0.620 | 1,613/s |
| connect | @yydb/postgres | 25.67 | 30.07 | 0.513 | 1,948/s |
| insert | pg | 697.00 | 707.92 | 3.485 | 287/s |
| insert | @yydb/postgres | 641.87 | 642.02 | 3.209 | 312/s |
| select-point | pg | 126.54 | 128.18 | 0.253 | 3,951/s |
| select-point | @yydb/postgres | 102.28 | 104.79 | 0.205 | 4,889/s |
| simple-point | pg | 106.84 | 107.72 | 0.214 | 4,680/s |
| simple-point | @yydb/postgres | 102.68 | 104.44 | 0.205 | 4,870/s |
| select-scan | pg | 10.39 | 11.06 | 0.010 | 96,284/s |
| select-scan | @yydb/postgres | 10.88 | 11.90 | 0.011 | 91,913/s |
| prepared-point | pg | 144.77 | 154.15 | 0.290 | 3,454/s |
| prepared-point | @yydb/postgres | 84.35 | 85.69 | 0.169 | 5,928/s |
| tx-prepared | pg | 54.78 | 56.18 | 0.274 | 3,651/s |
| tx-prepared | @yydb/postgres | 38.21 | 38.53 | 0.191 | 5,235/s |
| point-uk | pg | 137.01 | 140.94 | 0.274 | 3,649/s |
| point-uk | @yydb/postgres | 121.29 | 123.05 | 0.243 | 4,122/s |
| order-limit | pg | 20.09 | 20.92 | 0.402 | 2,489/s |
| order-limit | @yydb/postgres | 20.13 | 20.82 | 0.403 | 2,484/s |
| group-by | pg | 26.54 | 27.75 | 0.531 | 1,884/s |
| group-by | @yydb/postgres | 26.21 | 27.43 | 0.524 | 1,908/s |
| join | pg | 47.74 | 48.09 | 0.955 | 1,047/s |
| join | @yydb/postgres | 47.69 | 47.71 | 0.954 | 1,048/s |
| batch-insert | pg | 46.80 | 47.56 | 0.234 | 4,274/s |
| batch-insert | @yydb/postgres | 47.56 | 48.02 | 0.238 | 4,205/s |
| batch-insert-params | pg | 48.28 | 48.32 | 0.241 | 4,142/s |
| batch-insert-params | @yydb/postgres | 48.55 | 48.68 | 0.243 | 4,119/s |
| distinct | pg | 20.25 | 22.53 | 0.405 | 2,469/s |
| distinct | @yydb/postgres | 20.45 | 20.95 | 0.409 | 2,445/s |
| aggregate | pg | 21.47 | 22.11 | 0.429 | 2,329/s |
| aggregate | @yydb/postgres | 19.88 | 20.37 | 0.398 | 2,515/s |
| subquery | pg | 57.36 | 59.23 | 1.147 | 872/s |
| subquery | @yydb/postgres | 62.56 | 64.47 | 1.251 | 799/s |
| index-range | pg | 65.72 | 67.64 | 0.657 | 1,522/s |
| index-range | @yydb/postgres | 65.53 | 66.51 | 0.655 | 1,526/s |
| upsert | pg | 775.98 | 792.23 | 3.880 | 258/s |
| upsert | @yydb/postgres | 784.57 | 787.24 | 3.923 | 255/s |
| update | pg | 785.39 | 829.05 | 3.927 | 255/s |
| update | @yydb/postgres | 739.63 | 747.66 | 3.698 | 270/s |
| update-returning | pg | 380.02 | 392.08 | 3.800 | 263/s |
| update-returning | @yydb/postgres | 722.97 | 1051.98 | 7.230 | 138/s |
| delete | pg | 705.94 | 724.05 | 3.530 | 283/s |
| delete | @yydb/postgres | 966.92 | 1306.09 | 4.835 | 207/s |
| wide-row | pg | 23.83 | 24.20 | 0.238 | 4,196/s |
| wide-row | @yydb/postgres | 25.64 | 26.23 | 0.256 | 3,900/s |
| error-constraint | pg | 43.66 | 49.02 | 0.437 | 2,290/s |
| error-constraint | @yydb/postgres | 48.36 | 53.83 | 0.484 | 2,068/s |
| error-undefined-table | pg | 30.39 | 30.83 | 0.304 | 3,290/s |
| error-undefined-table | @yydb/postgres | 26.13 | 26.19 | 0.261 | 3,826/s |
| aborted-transaction | pg | 52.65 | 53.81 | 1.053 | 950/s |
| aborted-transaction | @yydb/postgres | 41.40 | 43.03 | 0.828 | 1,208/s |
| rollback | pg | 50.57 | 53.21 | 0.253 | 3,955/s |
| rollback | @yydb/postgres | 45.22 | 45.80 | 0.226 | 4,423/s |
| portal-batch-fetch | pg | 35.33 | 36.15 | 0.018 | 56,602/s |
| portal-batch-fetch | @yydb/postgres | 34.62 | 40.08 | 0.017 | 57,767/s |
| temp-table | pg | 564.71 | 567.69 | 11.294 | 89/s |
| temp-table | @yydb/postgres | 585.52 | 591.45 | 11.710 | 85/s |
| multi-statement | pg | 29.00 | 30.31 | 0.058 | 17,240/s |
| multi-statement | @yydb/postgres | 25.87 | 26.77 | 0.052 | 19,329/s |
| constraint-violation-rollback | pg | 97.95 | 119.32 | 0.980 | 1,021/s |
| constraint-violation-rollback | @yydb/postgres | 65.58 | 66.41 | 0.656 | 1,525/s |
| repeatable-read-tx | pg | 85.42 | 90.77 | 0.285 | 3,512/s |
| repeatable-read-tx | @yydb/postgres | 71.62 | 72.26 | 0.239 | 4,189/s |
| update-delete-bulk | pg | 37.89 | 39.87 | 0.095 | 10,557/s |
| update-delete-bulk | @yydb/postgres | 41.84 | 46.95 | 0.105 | 9,560/s |
| copy-from | pg | 199.93 | 201.12 | 0.100 | 10,004/s |
| copy-from | @yydb/postgres | 192.32 | 194.91 | 0.096 | 10,399/s |
| savepoint-rollback | pg | 110.52 | 110.70 | 0.691 | 1,448/s |
| savepoint-rollback | @yydb/postgres | 110.49 | 112.45 | 0.691 | 1,448/s |
| listen-notify | pg | 12.93 | 13.40 | 0.129 | 7,731/s |
| listen-notify | @yydb/postgres | 11.09 | 11.71 | 0.111 | 9,018/s |
| large-result-cursor | pg | 25.38 | 26.34 | 0.013 | 78,803/s |
| large-result-cursor | @yydb/postgres | 25.32 | 26.09 | 0.013 | 78,995/s |
| cte | pg | 24.19 | 25.26 | 0.484 | 2,067/s |
| cte | @yydb/postgres | 20.88 | 21.27 | 0.418 | 2,394/s |
| recursive-cte | pg | 238.69 | 242.65 | 2.387 | 419/s |
| recursive-cte | @yydb/postgres | 232.84 | 234.37 | 2.328 | 429/s |
| window | pg | 29.35 | 29.65 | 0.587 | 1,703/s |
| window | @yydb/postgres | 30.33 | 32.29 | 0.607 | 1,649/s |
| union-all | pg | 57.77 | 59.58 | 1.155 | 866/s |
| union-all | @yydb/postgres | 67.84 | 77.63 | 1.357 | 737/s |
| on-conflict-do-nothing | pg | 45.36 | 47.75 | 0.227 | 4,409/s |
| on-conflict-do-nothing | @yydb/postgres | 37.78 | 37.78 | 0.189 | 5,294/s |
| insert-returning | pg | 385.03 | 386.15 | 3.850 | 260/s |
| insert-returning | @yydb/postgres | 381.89 | 384.07 | 3.819 | 262/s |
| explain | pg | 10.95 | 11.43 | 0.219 | 4,568/s |
| explain | @yydb/postgres | 8.59 | 8.79 | 0.172 | 5,822/s |
| view-select | pg | 25.87 | 26.05 | 0.517 | 1,933/s |
| view-select | @yydb/postgres | 24.99 | 25.27 | 0.500 | 2,001/s |
| vacuum-analyze | pg | 10.73 | 11.66 | 0.107 | 9,322/s |
| vacuum-analyze | @yydb/postgres | 8.42 | 8.42 | 0.084 | 11,880/s |
| array-agg | pg | 15.74 | 16.38 | 0.315 | 3,177/s |
| array-agg | @yydb/postgres | 17.72 | 19.12 | 0.354 | 2,821/s |
| unnest-array | pg | 14.99 | 15.85 | 0.300 | 3,337/s |
| unnest-array | @yydb/postgres | 14.29 | 15.97 | 0.286 | 3,498/s |
| like-prefix | pg | 19.61 | 20.13 | 0.392 | 2,550/s |
| like-prefix | @yydb/postgres | 16.95 | 17.23 | 0.339 | 2,950/s |
| ilike-filter | pg | 20.10 | 21.26 | 0.402 | 2,488/s |
| ilike-filter | @yydb/postgres | 19.68 | 21.81 | 0.394 | 2,540/s |
| regex-filter | pg | 21.83 | 23.70 | 0.437 | 2,290/s |
| regex-filter | @yydb/postgres | 18.58 | 19.04 | 0.372 | 2,691/s |
| group-having | pg | 23.44 | 24.72 | 0.469 | 2,133/s |
| group-having | @yydb/postgres | 20.93 | 21.69 | 0.419 | 2,389/s |

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
