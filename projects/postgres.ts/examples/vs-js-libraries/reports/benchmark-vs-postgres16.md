# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:5432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `db86d93` |
| database.rs 钉住 rev | `c80cb0d` |
| 数据规模 | 数据集 1000 行（uk 唯一、grp 每组 100 行、(val DESC, id) 索引），固定 seed。 |

说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。
口径：`connect` 一项真实库每次都做认证与初始化握手，本仓连接是极简实现，两者不可比，该行不能当作性能结论。
口径：`order-limit` 在双方都先建同一条 `(val DESC, id)` 索引，测的是有序索引扫描加 `LIMIT` 提前停止，不是无索引内存排序。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| delete-many | rows | 0.005 | 0.095 | 18.86x |
| insert-single | statements | 0.309 | 4.983 | 16.11x |
| update-many | rows | 0.009 | 0.137 | 14.92x |
| insert-multi | rows | 0.016 | 0.212 | 13.43x |
| tx-commit | rows | 0.127 | 0.876 | 6.92x |
| group-by | statements | 0.295 | 1.517 | 5.15x |
| join | statements | 0.424 | 1.810 | 4.27x |
| range-limit | statements | 0.147 | 0.558 | 3.78x |
| order-limit | statements | 0.137 | 0.498 | 3.64x |
| point-uk | statements | 0.089 | 0.278 | 3.14x |
| baseline-select1 | statements | 0.045 | 0.130 | 2.91x |
| point-pk | statements | 0.100 | 0.264 | 2.63x |
| connect | connections | 38.311 | 1.331 | 0.03x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 92.82 | 1495.00 | 136.25 | 2093.20 |
| insert-multi | 6.30 | 84.66 | 8.00 | 87.29 |
| point-pk | 30.14 | 79.34 | 33.74 | 90.05 |
| point-uk | 26.59 | 83.36 | 36.82 | 92.35 |
| range-limit | 14.74 | 55.79 | 27.18 | 71.54 |
| update-many | 18.33 | 273.56 | 27.74 | 302.99 |
| delete-many | 5.02 | 94.69 | 7.67 | 97.10 |
| order-limit | 6.85 | 24.92 | 7.63 | 38.02 |
| group-by | 14.74 | 75.86 | 15.82 | 96.12 |
| join | 21.18 | 90.51 | 30.56 | 98.98 |
| tx-commit | 37.97 | 262.81 | 39.63 | 521.12 |
| baseline-select1 | 13.41 | 38.98 | 22.22 | 46.53 |
| connect | 766.23 | 26.62 | 882.05 | 27.85 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.265 | 4.853 | 4.589 |
| point-pk | 0.056 | 0.135 | 0.079 |
| point-uk | 0.044 | 0.148 | 0.104 |
| range-limit | 0.103 | 0.428 | 0.325 |
| update-many | 0.872 | 13.548 | 12.676 |
| group-by | 0.250 | 1.387 | 1.137 |
| order-limit | 0.092 | 0.369 | 0.276 |
| join | 0.379 | 1.680 | 1.301 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.130ms/语句，真库 0.045ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.264ms/语句、`point-uk` 0.278ms/语句，扣掉地板后为 0.135ms 与 0.148ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围与有序访问走索引、排序与分组仍整表扫**：`range-limit` 0.558ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 0.498ms/语句在双方同建的 `(val DESC, id)` 上做有序索引扫描，取够 `LIMIT` 即停，不再整表排序；`group-by` 1.52ms/语句，`grp` 没有索引，仍整表扫描后聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 4.983ms/语句，比真库多 4.7ms；`tx-commit` 摊到 0.876ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.137ms/行、`delete-many` 0.095ms/行。
- **连接走等值哈希**：`join` 1.810ms/语句，两侧各整表载入一次，`ON o.id = b.id` 的整数等值键建哈希表后逐行探测，不再逐对求值；`grp` 仍无索引，过滤在连接之后。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
