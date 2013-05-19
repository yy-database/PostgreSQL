# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16

真实库：`PostgreSQL 16.15, compiled by Visual C++ build 1944, 64-bit`（`127.0.0.1:35432`，库 `postgres`）
本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）
说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。
轮次：1 轮热身 + 5 轮测量，取中位数并记 p95；数据集 1000 行，固定 seed。
比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。

## 按差距排序

| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |
|---------:|-----:|-------------:|-----------:|-----:|
| point-uk | statements | 0.232 | 13.915 | 59.93x |
| point-pk | statements | 0.255 | 13.532 | 53.13x |
| range-limit | statements | 0.300 | 14.597 | 48.68x |
| insert-single | statements | 0.374 | 12.496 | 33.44x |
| order-limit | statements | 0.542 | 18.053 | 33.29x |
| update-many | rows | 0.015 | 0.485 | 32.54x |
| group-by | statements | 0.638 | 16.257 | 25.48x |
| delete-many | rows | 0.007 | 0.162 | 24.63x |
| insert-multi | rows | 0.028 | 0.431 | 15.27x |
| tx-commit | rows | 0.238 | 2.138 | 8.99x |
| baseline-select1 | statements | 0.139 | 0.421 | 3.03x |
| connect | connections | 82.726 | 3.580 | 0.04x |

## 绝对耗时与 p95

| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |
|---------:|--------------------:|------------------:|--------------:|------------:|
| insert-single | 112.11 | 3748.71 | 143.32 | 3803.07 |
| insert-multi | 11.31 | 172.60 | 13.69 | 189.72 |
| point-pk | 76.42 | 4059.71 | 85.44 | 5174.53 |
| point-uk | 69.66 | 4174.61 | 92.82 | 4328.65 |
| range-limit | 29.99 | 1459.73 | 31.71 | 1555.52 |
| update-many | 29.80 | 969.76 | 33.99 | 1617.47 |
| delete-many | 6.57 | 161.93 | 7.90 | 189.99 |
| order-limit | 27.12 | 902.63 | 31.22 | 1034.90 |
| group-by | 31.90 | 812.86 | 36.87 | 1023.68 |
| tx-commit | 71.37 | 641.28 | 80.25 | 662.39 |
| baseline-select1 | 41.68 | 126.42 | 45.93 | 142.91 |
| connect | 1654.53 | 71.60 | 1842.95 | 87.75 |

## 粗粒度阶段差分

线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。

| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |
|-----:|-------------------:|-----------------:|-------------:|
| insert-single | 0.235 | 12.074 | 11.840 |
| point-pk | 0.116 | 13.111 | 12.995 |
| point-uk | 0.093 | 13.494 | 13.401 |
| range-limit | 0.161 | 14.176 | 14.015 |
| update-many | 1.351 | 48.066 | 46.715 |
| group-by | 0.499 | 15.836 | 15.337 |
| order-limit | 0.403 | 17.631 | 17.228 |

## 根因假设与预计收益

- **每语句固定地板**：`baseline-select1` 本仓 0.421ms/语句，真库 0.139ms。地板本身不高，差距主要来自读路径。
- **点查没有走索引**：`point-pk` 13.532ms/语句、`point-uk` 13.915ms/语句，两者几乎相同且都远高于地板，说明主键与唯一键都没有参与定位，读路径是整表扫描；1000 行扫描约 13.1ms。
- **范围、排序与分组都含整表扫描**：`range-limit` 14.597ms/语句、`order-limit` 18.05ms/语句、`group-by` 16.26ms/语句，扫描之后再叠加排序与聚合成本。
- **写入成本集中在每次提交的落盘**：`insert-single` 12.496ms/语句，比真库多 12.1ms；`tx-commit` 摊到 2.138ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 `synchronous_commit=on`，口径一致。
- **条件更新与删除同样是扫描加逐行改写**：`update-many` 0.485ms/行、`delete-many` 0.162ms/行。

## 语义差异（不计入性能比值）

| 语句 | 真实库 | 本仓 |
|-----:|-------:|-----:|
| `WHERE id BETWEEN 6 AND 46` | 41 | 42601: syntax error at or near "BETWEEN" |
| `WHERE id > 6 AND id <= 46` | 40 | 40 |

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`
