# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:5432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `85efb10` |
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
| delete-many | rows | 0.003 | 0.087 | 28.32x |
| insert-single | statements | 0.195 | 4.394 | 22.51x |
| update-many | rows | 0.006 | 0.130 | 21.85x |
| insert-multi | rows | 0.011 | 0.188 | 17.57x |
| tx-commit | rows | 0.125 | 0.894 | 7.14x |
| join | statements | 0.418 | 1.768 | 4.23x |
| baseline-select1 | statements | 0.037 | 0.148 | 3.99x |
| group-by | statements | 0.294 | 1.166 | 3.97x |
| order-limit | statements | 0.125 | 0.455 | 3.65x |
| range-limit | statements | 0.136 | 0.496 | 3.64x |
| point-pk | statements | 0.084 | 0.262 | 3.13x |
| point-uk | statements | 0.090 | 0.271 | 3.03x |
| connect | connections | 32.686 | 1.404 | 0.04x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 58.57 | 1318.31 | 74.01 | 1524.34 |
| insert-multi | 4.27 | 75.11 | 6.88 | 84.93 |
| point-pk | 25.08 | 78.51 | 38.23 | 84.28 |
| point-uk | 26.91 | 81.39 | 34.18 | 91.82 |
| range-limit | 13.64 | 49.59 | 14.33 | 53.21 |
| update-many | 11.87 | 259.42 | 12.47 | 315.20 |
| delete-many | 3.07 | 86.85 | 4.69 | 91.78 |
| order-limit | 6.23 | 22.74 | 7.50 | 33.55 |
| group-by | 14.69 | 58.31 | 15.96 | 70.37 |
| join | 20.92 | 88.38 | 21.75 | 93.95 |
| tx-commit | 37.56 | 268.30 | 48.24 | 272.84 |
| baseline-select1 | 11.09 | 44.28 | 14.06 | 49.54 |
| connect | 653.72 | 28.08 | 758.98 | 30.11 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.158 | 4.247 | 4.089 |
| point-pk | 0.047 | 0.114 | 0.067 |
| point-uk | 0.053 | 0.124 | 0.071 |
| range-limit | 0.099 | 0.348 | 0.249 |
| update-many | 0.557 | 12.823 | 12.267 |
| group-by | 0.257 | 1.019 | 0.762 |
| order-limit | 0.088 | 0.307 | 0.220 |
| join | 0.381 | 1.620 | 1.239 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.148ms/语句，真库 0.037ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.262ms/语句、`point-uk` 0.271ms/语句，扣掉地板后为 0.114ms 与 0.124ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围与有序访问走索引、排序与分组仍整表扫**：`range-limit` 0.496ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 0.455ms/语句在双方同建的 `(val DESC, id)` 上做有序索引扫描，取够 `LIMIT` 即停，不再整表排序；`group-by` 1.17ms/语句，`grp` 没有索引，仍整表扫描后聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 4.394ms/语句，比真库多 4.2ms；`tx-commit` 摊到 0.894ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.130ms/行、`delete-many` 0.087ms/行。
- **连接走等值哈希**：`join` 1.768ms/语句，两侧各整表载入一次，`ON o.id = b.id` 的整数等值键建哈希表后逐行探测，不再逐对求值；`grp` 仍无索引，过滤在连接之后。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
