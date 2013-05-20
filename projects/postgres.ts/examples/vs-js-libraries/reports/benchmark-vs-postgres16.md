# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:35432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| insert-single | statements | 0.317 | 10.436 | 32.90x |
| update-many | rows | 0.015 | 0.467 | 31.12x |
| delete-many | rows | 0.006 | 0.187 | 30.08x |
| order-limit | statements | 0.439 | 12.154 | 27.68x |
| group-by | statements | 0.506 | 11.860 | 23.44x |
| insert-multi | rows | 0.021 | 0.391 | 18.41x |
| tx-commit | rows | 0.169 | 1.712 | 10.15x |
| range-limit | statements | 0.271 | 2.068 | 7.64x |
| point-pk | statements | 0.193 | 0.900 | 4.66x |
| point-uk | statements | 0.215 | 0.939 | 4.36x |
| baseline-select1 | statements | 0.090 | 0.357 | 3.98x |
| connect | connections | 63.292 | 3.005 | 0.05x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 95.15 | 3130.93 | 147.63 | 3775.15 |
| insert-multi | 8.50 | 156.45 | 13.68 | 179.33 |
| point-pk | 57.96 | 269.86 | 117.92 | 412.93 |
| point-uk | 64.63 | 281.64 | 88.58 | 377.43 |
| range-limit | 27.06 | 206.78 | 30.88 | 250.25 |
| update-many | 30.02 | 934.17 | 32.64 | 1097.62 |
| delete-many | 6.23 | 187.32 | 6.90 | 213.77 |
| order-limit | 21.95 | 607.69 | 29.69 | 714.74 |
| group-by | 25.30 | 593.02 | 35.68 | 704.86 |
| tx-commit | 50.62 | 513.67 | 63.87 | 610.34 |
| baseline-select1 | 26.96 | 107.21 | 33.91 | 113.92 |
| connect | 1265.84 | 60.09 | 1371.33 | 65.57 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.227 | 10.079 | 9.852 |
| point-pk | 0.103 | 0.542 | 0.439 |
| point-uk | 0.126 | 0.581 | 0.456 |
| range-limit | 0.181 | 1.710 | 1.530 |
| update-many | 1.411 | 46.351 | 44.940 |
| group-by | 0.416 | 11.503 | 11.087 |
| order-limit | 0.349 | 11.796 | 11.447 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.357ms/语句，真库 0.090ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.900ms/语句、`point-uk` 0.939ms/语句，扣掉地板后为 0.542ms 与 0.581ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围走索引、排序与分组仍整表扫**：`range-limit` 2.068ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 12.15ms/语句、`group-by` 11.86ms/语句，`val`/`grp` 没有索引，仍整表扫描后排序与聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 10.436ms/语句，比真库多 10.1ms；`tx-commit` 摊到 1.712ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.467ms/行、`delete-many` 0.187ms/行。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
