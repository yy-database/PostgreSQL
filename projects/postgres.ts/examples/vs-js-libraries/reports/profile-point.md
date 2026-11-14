# 每语句固定开销拆分：`@yydb/postgres` 点查剖析

对象：`SELECT id, val FROM bench WHERE id = ?`，1000 行数据集、主键点查，连续 15000 条简单查询（无参数绑定、无连接池）。
方法：服务端子进程加 `--cpu-prof --cpu-prof-interval=100`，按 self time 归并到阶段，除以语句数得到 µs/语句；客户端在同一台机器上，`idle` 是等回包的往返时间。
本报告只记录服务端 CPU 采样，不含客户端驱动自身开销；绝对值与基准脚本的 ms/语句不可直接相加。

## Provenance

- node `v24.18.0`，rustc `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`，本仓 rev `9abdc89`，database.rs 钉住 rev `70aee1e`
- 采样 7662 帧，采样总时长 3828.8 ms，实测 0.254 ms/语句

## 阶段拆分

| 阶段 | µs/语句 | 占比 |
|-----:|--------:|-----:|
| 原生扫描（catalog、索引、行数据） | 25.7 | 10.1% |
| socket 写入（`writeBuffer`、写封装） | 36.0 | 14.1% |
| 网络往返等待（`idle`） | 43.7 | 17.1% |
| catalog 克隆（`clone`） | 0.0 | 0.0% |
| catalog 深拷贝（`structuredClone`） | 0.0 | 0.0% |
| 打开数据库（`open`） | 0.2 | 0.1% |
| 语句切分（`scanStatements`） | 6.6 | 2.6% |
| catalog 载入（`loadCatalog`） | 2.7 | 1.1% |
| 解析（切词、`parsePrimary`、注释跳过） | 16.4 | 6.4% |
| 计划与执行（索引选择、解码、过滤、聚合） | 33.9 | 13.3% |
| 行文本编码与字段描述 | 5.6 | 2.2% |
| GC | 6.3 | 2.5% |
| 事件循环与其余杂项 | 78.2 | 30.6% |
| **合计（采样）** | **255.3** | 100.0% |

## 事件循环与杂项的 top 帧

| 帧 | µs/语句 |
|----|--------:|
| `(program)` @ node 内部 | 13.8 |
| `cloneCatalog` @ postgres/dist/server/sql/database.js | 6.6 |
| `nextTick` @ node:internal/process/task_queues | 4.3 |
| `cloneCatalog` @ postgres/dist/server/sql/database.js | 3.7 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 2.9 |
| `handleSimpleQuery` @ postgres/dist/server/server.js | 1.8 |
| `runSimpleBatch` @ postgres/dist/server/server.js | 1.5 |
| `integerText` @ postgres/dist/server/sql/types.js | 1.3 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 1.1 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 1.0 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 0.9 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 0.8 |

## 归并规则

V8 CPU profile 里 napi 调用没有独立 JS 帧，原生耗时记在直接调用它的 JS 帧上：`store.js` 的 scan/commitChanges 包装与 `database.js` 的 `table`/`scanIndex`（含行数据解码）归入原生扫描；`node:net`/`node:internal` 的写帧归入 socket 写入；其余未识别帧归入事件循环与杂项。

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries profile:point`
