# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=3`, `BENCH2_ROWS=200`, `BENCH_ORDER=50`, `BENCH_GROUP=50`, `BENCH_JOIN=50`, `BENCH_BATCH=100`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `3b9d08d` |
| database.rs 钉住 rev | `0d688fe` |
| 数据规模 | bench_items 200/1000 行，bench 200 行（uk 唯一、grp 每组 10 行、(val DESC, id) 索引），批量 100 行/语句 |

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| insert | 1.00x | **0.97x** |
| select-point | 1.00x | **0.88x** |
| select-scan | **1.00x** | 1.39x |
| prepared-point | 1.00x | **0.86x** |
| point-uk | **1.00x** | 1.09x |
| order-limit | **1.00x** | 1.12x |
| group-by | 1.00x | **0.72x** |
| join | **1.00x** | 1.01x |
| batch-insert | **1.00x** | 1.10x |

## Absolute

| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|-------:|
| insert | pg | 1515.79 | 1531.58 | 7.579 | 132/s |
| insert | @yydb/postgres | 1475.60 | 1554.00 | 7.378 | 136/s |
| select-point | pg | 160.33 | 187.96 | 0.321 | 3,119/s |
| select-point | @yydb/postgres | 141.33 | 144.46 | 0.283 | 3,538/s |
| select-scan | pg | 19.05 | 24.34 | 0.019 | 52,500/s |
| select-scan | @yydb/postgres | 26.45 | 28.88 | 0.026 | 37,805/s |
| prepared-point | pg | 153.28 | 157.11 | 0.307 | 3,262/s |
| prepared-point | @yydb/postgres | 131.66 | 136.71 | 0.263 | 3,798/s |
| point-uk | pg | 174.82 | 181.11 | 0.350 | 2,860/s |
| point-uk | @yydb/postgres | 190.41 | 200.31 | 0.381 | 2,626/s |
| order-limit | pg | 24.09 | 24.67 | 0.482 | 2,076/s |
| order-limit | @yydb/postgres | 27.01 | 27.64 | 0.540 | 1,851/s |
| group-by | pg | 65.52 | 68.26 | 1.310 | 763/s |
| group-by | @yydb/postgres | 47.40 | 52.38 | 0.948 | 1,055/s |
| join | pg | 94.39 | 117.50 | 1.888 | 530/s |
| join | @yydb/postgres | 95.18 | 105.42 | 1.904 | 525/s |
| batch-insert | pg | 39.99 | 46.01 | 0.200 | 5,002/s |
| batch-insert | @yydb/postgres | 44.08 | 46.22 | 0.220 | 4,538/s |

An op is one inserted row, one point query, one scanned row, one prepared execution, one ordered-limit statement, one grouping statement, one join statement, or one batched row.
One warmup round runs before the measured rounds. The table reports median and p95 of 3 measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- `pg` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The `pg` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh `mkdtemp` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is `prepare` plus `executePrepared`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.
- `point-uk`, `order-limit`, `group-by`, `join` and `batch-insert` run against the shared `bench`/`bench_join` shape of `benchmark-vs-postgres16.mjs`: `uk` carries the unique index, `(val DESC, id)` carries the ordered index, `grp` has no index.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
