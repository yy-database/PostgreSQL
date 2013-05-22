# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:35432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。
口径：`connect` 一项真实库每次都做认证与初始化握手，本仓连接是极简实现，两者不可比，该行不能当作性能结论。
口径：`order-limit` 在双方都先建同一条 `(val DESC, id)` 索引，测的是有序索引扫描加 `LIMIT` 提前停止，不是无索引内存排序。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| insert-single | statements | 0.234 | 8.929 | 38.23x |
| update-many | rows | 0.008 | 0.261 | 33.63x |
| delete-many | rows | 0.004 | 0.113 | 32.00x |
| insert-multi | rows | 0.014 | 0.295 | 21.77x |
| group-by | statements | 0.426 | 7.429 | 17.42x |
| tx-commit | rows | 0.147 | 1.260 | 8.56x |
| order-limit | statements | 0.182 | 0.866 | 4.77x |
| range-limit | statements | 0.255 | 0.873 | 3.43x |
| point-pk | statements | 0.187 | 0.619 | 3.31x |
| point-uk | statements | 0.162 | 0.506 | 3.12x |
| baseline-select1 | statements | 0.082 | 0.210 | 2.55x |
| connect | connections | 41.006 | 1.852 | 0.05x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 70.08 | 2678.64 | 97.61 | 2888.28 |
| insert-multi | 5.42 | 118.02 | 6.97 | 124.16 |
| point-pk | 56.02 | 185.65 | 63.30 | 330.62 |
| point-uk | 48.75 | 151.93 | 72.74 | 254.32 |
| range-limit | 25.48 | 87.34 | 28.43 | 154.14 |
| update-many | 15.52 | 522.02 | 28.70 | 663.59 |
| delete-many | 3.52 | 112.65 | 6.96 | 146.67 |
| order-limit | 9.09 | 43.32 | 13.61 | 68.82 |
| group-by | 21.32 | 371.45 | 24.25 | 493.86 |
| tx-commit | 44.17 | 377.98 | 55.23 | 431.89 |
| baseline-select1 | 24.67 | 62.88 | 27.24 | 78.21 |
| connect | 820.13 | 37.05 | 1050.49 | 41.46 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.151 | 8.719 | 8.568 |
| point-pk | 0.105 | 0.409 | 0.305 |
| point-uk | 0.080 | 0.297 | 0.217 |
| range-limit | 0.173 | 0.664 | 0.491 |
| update-many | 0.694 | 25.891 | 25.198 |
| group-by | 0.344 | 7.219 | 6.875 |
| order-limit | 0.100 | 0.657 | 0.557 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.210ms/语句，真库 0.082ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.619ms/语句、`point-uk` 0.506ms/语句，扣掉地板后为 0.409ms 与 0.297ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围与有序访问走索引、排序与分组仍整表扫**：`range-limit` 0.873ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 0.866ms/语句在双方同建的 `(val DESC, id)` 上做有序索引扫描，取够 `LIMIT` 即停，不再整表排序；`group-by` 7.43ms/语句，`grp` 没有索引，仍整表扫描后聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 8.929ms/语句，比真库多 8.7ms；`tx-commit` 摊到 1.260ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.261ms/行、`delete-many` 0.113ms/行。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
