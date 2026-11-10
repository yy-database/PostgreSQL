# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:5432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `3b9d08d` |
| database.rs 钉住 rev | `0d688fe` |
| 数据规模 | 数据集 1000 行（uk 唯一、grp 每组 100 行、(val DESC, id) 索引），固定 seed。 |

说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。
口径：`connect` 一项真实库每次都做认证与初始化握手，本仓连接是极简实现，两者不可比，该行不能当作性能结论。
口径：`order-limit` 在双方都先建同一条 `(val DESC, id)` 索引，测的是有序索引扫描加 `LIMIT` 提前停止，不是无索引内存排序。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| insert-single | statements | 0.187 | 7.859 | 41.95x |
| update-many | rows | 0.006 | 0.185 | 28.74x |
| delete-many | rows | 0.004 | 0.081 | 22.20x |
| insert-multi | rows | 0.010 | 0.191 | 18.83x |
| tx-commit | rows | 0.091 | 1.106 | 12.20x |
| group-by | statements | 0.266 | 2.335 | 8.76x |
| join | statements | 0.451 | 3.548 | 7.87x |
| range-limit | statements | 0.145 | 0.514 | 3.54x |
| baseline-select1 | statements | 0.047 | 0.137 | 2.91x |
| point-pk | statements | 0.084 | 0.226 | 2.70x |
| order-limit | statements | 0.172 | 0.420 | 2.45x |
| point-uk | statements | 0.106 | 0.242 | 2.28x |
| connect | connections | 40.546 | 1.417 | 0.03x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 56.20 | 2357.78 | 79.02 | 2695.90 |
| insert-multi | 4.06 | 76.53 | 5.33 | 86.44 |
| point-pk | 25.09 | 67.84 | 37.80 | 91.26 |
| point-uk | 31.76 | 72.55 | 42.32 | 82.80 |
| range-limit | 14.54 | 51.43 | 21.87 | 80.05 |
| update-many | 12.86 | 369.55 | 15.39 | 399.21 |
| delete-many | 3.67 | 81.41 | 9.35 | 89.27 |
| order-limit | 8.59 | 21.01 | 9.02 | 24.54 |
| group-by | 13.32 | 116.73 | 15.31 | 121.91 |
| join | 22.55 | 177.40 | 25.71 | 191.32 |
| tx-commit | 27.19 | 331.83 | 32.43 | 334.21 |
| baseline-select1 | 14.18 | 41.21 | 23.76 | 46.51 |
| connect | 810.92 | 28.34 | 869.49 | 35.09 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.140 | 7.722 | 7.582 |
| point-pk | 0.036 | 0.089 | 0.052 |
| point-uk | 0.059 | 0.104 | 0.046 |
| range-limit | 0.098 | 0.377 | 0.279 |
| update-many | 0.596 | 18.340 | 17.745 |
| group-by | 0.219 | 2.197 | 1.978 |
| order-limit | 0.125 | 0.283 | 0.158 |
| join | 0.404 | 3.411 | 3.007 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.137ms/语句，真库 0.047ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.226ms/语句、`point-uk` 0.242ms/语句，扣掉地板后为 0.089ms 与 0.104ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围与有序访问走索引、排序与分组仍整表扫**：`range-limit` 0.514ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 0.420ms/语句在双方同建的 `(val DESC, id)` 上做有序索引扫描，取够 `LIMIT` 即停，不再整表排序；`group-by` 2.33ms/语句，`grp` 没有索引，仍整表扫描后聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 7.859ms/语句，比真库多 7.7ms；`tx-commit` 摊到 1.106ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.185ms/行、`delete-many` 0.081ms/行。
- **连接走等值哈希**：`join` 3.548ms/语句，两侧各整表载入一次，`ON o.id = b.id` 的整数等值键建哈希表后逐行探测，不再逐对求值；`grp` 仍无索引，过滤在连接之后。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
