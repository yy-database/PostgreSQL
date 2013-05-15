# Benchmark report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=200`, `BENCH_POINT=500`, `BENCH_SCAN=1000`, `BENCH_PREPARED=500`, `BENCH_ROUNDS=3`
Baseline: `pg` (one `pg.Client` connection) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to `pg`

| Workload | pg | @yydb/postgres |
|---------:|-------:|-------:|
| insert | **1.00x** | 1.04x |
| select-point | **1.00x** | 1.03x |
| select-scan | **1.00x** | 1.22x |
| prepared-point | 1.00x | **0.84x** |

## Absolute

| Workload | Client | Median round ms | ms/op | ops/s |
|---------:|-------:|-------:|-------:|-------:|
| insert | pg | 1476.02 | 7.380 | 135/s |
| insert | @yydb/postgres | 1538.10 | 7.691 | 130/s |
| select-point | pg | 962.62 | 1.925 | 519/s |
| select-point | @yydb/postgres | 994.74 | 1.989 | 503/s |
| select-scan | pg | 28.75 | 0.029 | 34,778/s |
| select-scan | @yydb/postgres | 35.09 | 0.035 | 28,500/s |
| prepared-point | pg | 1194.70 | 2.389 | 419/s |
| prepared-point | @yydb/postgres | 1005.91 | 2.012 | 497/s |

An op is one inserted row, one point query, one scanned row, or one prepared execution.
One warmup round runs before the measured rounds. The table reports the median of 3 measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- `pg` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The `pg` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh `mkdtemp` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is `prepare` plus `executePrepared`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
