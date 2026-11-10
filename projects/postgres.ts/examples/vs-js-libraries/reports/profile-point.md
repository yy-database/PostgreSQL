# 每语句固定开销拆分：`@yydb/postgres` 点查剖析

对象：`SELECT id, val FROM bench WHERE id = ?`，1000 行数据集、主键点查，连续 15000 条简单查询（无参数绑定、无连接池）。
方法：服务端子进程加 `--cpu-prof --cpu-prof-interval=100`，按 self time 归并到阶段，除以语句数得到 µs/语句；客户端在同一台机器上，`idle` 是等回包的往返时间。
本报告只记录服务端 CPU 采样，不含客户端驱动自身开销；绝对值与基准脚本的 ms/语句不可直接相加。

## Provenance

- node `v24.18.0`，rustc `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`，本仓 rev `3b9d08d`，database.rs 钉住 rev `0d688fe`
- 采样 4713 帧，采样总时长 2018.7 ms，实测 0.134 ms/语句

## 阶段拆分

| 阶段 | µs/语句 | 占比 |
|-----:|--------:|-----:|
| 原生扫描（catalog、索引、行数据） | 16.9 | 12.6% |
| socket 写入（`writeBuffer`、写封装） | 17.7 | 13.2% |
| 网络往返等待（`idle`） | 21.0 | 15.6% |
| catalog 克隆（`clone`） | 0.0 | 0.0% |
| catalog 深拷贝（`structuredClone`） | 0.0 | 0.0% |
| 打开数据库（`open`） | 15.6 | 11.6% |
| 语句切分（`scanStatements`） | 2.3 | 1.7% |
| catalog 载入（`loadCatalog`） | 6.8 | 5.1% |
| 解析（切词、`parsePrimary`、注释跳过） | 7.4 | 5.5% |
| 计划与执行（索引选择、解码、过滤、聚合） | 12.3 | 9.1% |
| 行文本编码与字段描述 | 2.9 | 2.2% |
| GC | 2.9 | 2.1% |
| 事件循环与其余杂项 | 28.7 | 21.3% |
| **合计（采样）** | **134.6** | 100.0% |

## 事件循环与杂项的 top 帧

| 帧 | µs/语句 |
|----|--------:|
| `(program)` @ node 内部 | 6.4 |
| `nextTick` @ node:internal/process/task_queues | 1.3 |
| `integerText` @ postgres/dist/server/sql/types.js | 0.8 |
| `runSimpleBatch` @ postgres/dist/server/server.js | 0.8 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 0.5 |
| `handleSimpleQuery` @ postgres/dist/server/server.js | 0.5 |
| `(anonymous)` @ postgres/dist/server/sql/database.js | 0.4 |
| `(anonymous)` @ node 内部 | 0.3 |
| `(anonymous)` @ postgres/dist/server/server.js | 0.3 |
| `openImplicit` @ postgres/dist/server/server.js | 0.3 |
| `nextTick` @ node:internal/process/task_queues | 0.3 |
| `concat` @ node:buffer | 0.3 |

## 归并规则

V8 CPU profile 里 napi 调用没有独立 JS 帧，原生耗时记在直接调用它的 JS 帧上：`store.js` 的 scan/commitChanges 包装与 `database.js` 的 `table`/`scanIndex`（含行数据解码）归入原生扫描；`node:net`/`node:internal` 的写帧归入 socket 写入；其余未识别帧归入事件循环与杂项。

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries profile:point`
