# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:5432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | `v24.18.0` |
| rustc | `rustc 1.101.0-nightly (1c3a65069 2026-11-02)` |
| 本仓 rev | `9abdc89` |
| database.rs 钉住 rev | `70aee1e` |
| 数据规模 | 数据集 1000 行（uk 唯一、grp 每组 100 行、(val DESC, id) 索引），固定 seed。 |

说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。
口径：`connect` 一项真实库每次都做认证与初始化握手，本仓连接是极简实现，两者不可比，该行不能当作性能结论。
口径：`order-limit` 在双方都先建同一条 `(val DESC, id)` 索引，测的是有序索引扫描加 `LIMIT` 提前停止，不是无索引内存排序。
口径：`cursor-fetch` 双方都走 `BEGIN` + `DECLARE ... CURSOR` + `FETCH 20` + `CLOSE`，测的是一次只取一页的服务端游标，与本仓 `Execute` 带 `max_rows` 的分页是同一条执行路径；每轮都要取满 1000 行才算通过。
口径：`temp-table` 在同一个连接上循环 `CREATE TEMP TABLE` / 20 行 `INSERT` / `SELECT` / `DROP TABLE` 30 次，测的是会话级临时关系的建删与目录变更成本。
口径：`multi-statement` 每条简单查询报文携带 5 条语句，共 50 条报文；`pg` 会回一个结果数组，两侧都按数组长度断言条数。
口径：`constraint-violation-rollback` 每条语句都是「开事务 → 重复主键插入被 23505 拒绝 → ROLLBACK」，测的是错误回包加事务撤销，不是成功写入。
口径：`repeatable-read-tx` 每事务 10 条主键点查，全部在 `BEGIN ISOLATION LEVEL REPEATABLE READ` 内，快照级别不做逐语句重读。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| delete-many | rows | 0.007 | 0.176 | 26.22x |
| insert-single | statements | 0.326 | 7.505 | 23.02x |
| update-many | rows | 0.011 | 0.242 | 22.79x |
| insert-multi | rows | 0.023 | 0.334 | 14.85x |
| temp-table | cycles | 5.356 | 71.603 | 13.37x |
| tx-commit | rows | 0.203 | 1.559 | 7.68x |
| left-join-count | statements | 0.299 | 2.075 | 6.95x |
| window-rank | statements | 0.514 | 3.072 | 5.98x |
| distinct-groups | statements | 0.383 | 2.217 | 5.79x |
| sort-limit | statements | 0.423 | 2.248 | 5.32x |
| cte-filter | statements | 0.356 | 1.847 | 5.18x |
| in-list | statements | 0.318 | 1.647 | 5.18x |
| multi-statement | statements | 0.030 | 0.128 | 4.30x |
| group-by | statements | 0.479 | 2.015 | 4.21x |
| count-scan | statements | 0.254 | 1.068 | 4.20x |
| range-limit | statements | 0.245 | 1.023 | 4.18x |
| join | statements | 0.794 | 2.975 | 3.75x |
| constraint-violation-rollback | statements | 0.476 | 1.701 | 3.58x |
| text-compare | statements | 0.673 | 2.356 | 3.50x |
| order-limit | statements | 0.254 | 0.884 | 3.48x |
| cursor-fetch | rows | 0.008 | 0.028 | 3.43x |
| baseline-select1 | statements | 0.087 | 0.256 | 2.93x |
| point-uk | statements | 0.175 | 0.447 | 2.55x |
| repeatable-read-tx | statements | 0.203 | 0.488 | 2.40x |
| point-pk | statements | 0.203 | 0.456 | 2.24x |
| connect | connections | 67.046 | 2.823 | 0.04x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 97.82 | 2251.47 | 118.05 | 2341.11 |
| insert-multi | 9.00 | 133.69 | 15.57 | 158.77 |
| point-pk | 60.98 | 136.89 | 71.27 | 146.84 |
| point-uk | 52.45 | 133.97 | 61.83 | 156.01 |
| range-limit | 24.48 | 102.29 | 30.23 | 134.45 |
| update-many | 21.22 | 483.65 | 21.88 | 563.50 |
| delete-many | 6.70 | 175.74 | 8.46 | 189.54 |
| order-limit | 12.71 | 44.19 | 15.78 | 49.23 |
| group-by | 23.95 | 100.73 | 24.96 | 150.47 |
| join | 39.68 | 148.74 | 50.13 | 200.54 |
| count-scan | 12.71 | 53.42 | 15.11 | 61.33 |
| distinct-groups | 19.13 | 110.87 | 27.26 | 141.56 |
| cte-filter | 17.82 | 92.35 | 28.81 | 110.92 |
| window-rank | 25.70 | 153.60 | 27.90 | 175.39 |
| text-compare | 33.65 | 117.80 | 42.93 | 119.42 |
| left-join-count | 14.93 | 103.73 | 15.67 | 148.02 |
| sort-limit | 21.13 | 112.42 | 33.83 | 123.20 |
| in-list | 15.90 | 82.37 | 16.76 | 103.25 |
| tx-commit | 60.87 | 467.75 | 80.37 | 537.43 |
| cursor-fetch | 82.30 | 281.91 | 95.00 | 298.39 |
| temp-table | 160.67 | 2148.09 | 188.45 | 2407.81 |
| multi-statement | 7.45 | 32.02 | 8.53 | 35.44 |
| constraint-violation-rollback | 23.79 | 85.06 | 26.24 | 92.89 |
| repeatable-read-tx | 40.65 | 97.60 | 53.59 | 107.49 |
| baseline-select1 | 26.23 | 76.79 | 29.78 | 101.29 |
| connect | 1340.91 | 56.47 | 1576.69 | 79.52 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.239 | 7.249 | 7.010 |
| point-pk | 0.116 | 0.200 | 0.084 |
| point-uk | 0.087 | 0.191 | 0.103 |
| range-limit | 0.157 | 0.767 | 0.609 |
| update-many | 0.974 | 23.927 | 22.953 |
| group-by | 0.392 | 1.759 | 1.367 |
| order-limit | 0.167 | 0.628 | 0.461 |
| join | 0.706 | 2.719 | 2.013 |
| count-scan | 0.167 | 0.812 | 0.646 |
| distinct-groups | 0.295 | 1.961 | 1.666 |
| cte-filter | 0.269 | 1.591 | 1.322 |
| window-rank | 0.427 | 2.816 | 2.389 |
| text-compare | 0.586 | 2.100 | 1.514 |
| left-join-count | 0.211 | 1.819 | 1.607 |
| sort-limit | 0.335 | 1.992 | 1.657 |
| in-list | 0.231 | 1.391 | 1.161 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.256ms/语句，真库 0.087ms。地板本身不高，差距主要来自读路径。
- **点查走索引**：`point-pk` 0.456ms/语句、`point-uk` 0.447ms/语句，扣掉地板后为 0.200ms 与 0.191ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。
- **范围与有序访问走索引、排序与分组仍整表扫**：`range-limit` 1.023ms/语句按索引区间取 20 行后逐行过滤；`order-limit` 0.884ms/语句在双方同建的 `(val DESC, id)` 上做有序索引扫描，取够 `LIMIT` 即停，不再整表排序；`group-by` 2.01ms/语句，`grp` 没有索引，仍整表扫描后聚合。
- **写入成本集中在每次提交的落盘**：`insert-single` 7.505ms/语句，比真库多 7.2ms；`tx-commit` 摊到 1.559ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.242ms/行、`delete-many` 0.176ms/行。
- **连接走等值哈希**：`join` 2.975ms/语句，两侧各整表载入一次，`ON o.id = b.id` 的整数等值键建哈希表后逐行探测，不再逐对求值；`grp` 仍无索引，过滤在连接之后。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 41 |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
