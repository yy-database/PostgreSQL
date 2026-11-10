// 每语句固定开销剖析：服务端子进程加 `--cpu-prof`，按 self time 归并到阶段，
// 除以语句数得到 µs/语句。客户端与剖析对象同机，`idle` 是等回包的往返时间。
//
// 方法沿用 `reports/profile-point.md` 的口径：1000 行数据集、主键点查、
// 连续简单查询（无参数绑定、无连接池），采样间隔 100µs。
//
// 归并规则（V8 CPU profile 里 napi 调用没有独立 JS 帧，原生耗时记在
// 直接调用它的 JS 帧上，所以 `store.js` 的 scan/commitChanges 包装即原生扫描）：
//   - `(idle)` → 网络往返等待
//   - `(garbage collector)` → GC
//   - `store.js` 帧与 `database.js` 的 `table`/`scanIndex` → 原生扫描（catalog、索引、行数据）
//   - `structuredClone` → catalog 深拷贝
//   - `clone`（`database.js`） → catalog 克隆
//   - `loadCatalog` → catalog 载入
//   - `open`（`database.js`） → 打开数据库
//   - `scanStatements` → 语句切分
//   - `parser.js` → 解析
//   - `engine.js` → 计划与执行
//   - `protocol.js` 与回包封装 → 行文本编码与字段描述
//   - `node:net`/`node:internal` 的写帧 → socket 写入
//   - 其余 → 事件循环与其余杂项
//
// 运行：`pnpm --dir projects/postgres.ts/examples/vs-js-libraries profile:point`
// Env: PROFILE_STATEMENTS (15000), PROFILE_ROWS (1000), PROFILE_INTERVAL_US (100)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadNative } from "../../../packages/postgres/dist/index.js";
import { openNativeClient } from "../src/native-client.mjs";
import { startPgServer } from "../src/pg-server.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(exampleRoot, "..", "..", "..", "..");
const native = loadNative();

const STATEMENTS = Number(process.env.PROFILE_STATEMENTS ?? 15_000);
const SEED_ROWS = Number(process.env.PROFILE_ROWS ?? 1_000);
const INTERVAL_US = Number(process.env.PROFILE_INTERVAL_US ?? 100);

const STAGES = [
  "原生扫描（catalog、索引、行数据）",
  "socket 写入（`writeBuffer`、写封装）",
  "网络往返等待（`idle`）",
  "catalog 克隆（`clone`）",
  "catalog 深拷贝（`structuredClone`）",
  "打开数据库（`open`）",
  "语句切分（`scanStatements`）",
  "catalog 载入（`loadCatalog`）",
  "解析（切词、`parsePrimary`、注释跳过）",
  "计划与执行（索引选择、解码、过滤、聚合）",
  "行文本编码与字段描述",
  "GC",
  "事件循环与其余杂项",
];

function classify(node) {
  const name = node.callFrame.functionName ?? "";
  const url = node.callFrame.url ?? "";
  if (name === "(idle)") return "网络往返等待（`idle`）";
  if (name === "(garbage collector)") return "GC";
  if (url.includes("store.js") || url.includes("store.ts")) return "原生扫描（catalog、索引、行数据）";
  if ((url.includes("database.js") || url.includes("database.ts")) && (name === "table" || name === "scanIndex")) {
    return "原生扫描（catalog、索引、行数据）";
  }
  if (name === "structuredClone") return "catalog 深拷贝（`structuredClone`）";
  if ((url.includes("database.js") || url.includes("database.ts")) && name === "clone") return "catalog 克隆（`clone`）";
  if (name === "loadCatalog") return "catalog 载入（`loadCatalog`）";
  if ((url.includes("database.js") || url.includes("database.ts")) && name === "open") return "打开数据库（`open`）";
  if (name === "scanStatements") return "语句切分（`scanStatements`）";
  if (url.includes("parser.js") || url.includes("parser.ts")) return "解析（切词、`parsePrimary`、注释跳过）";
  if (url.includes("engine.js") || url.includes("engine.ts")) return "计划与执行（索引选择、解码、过滤、聚合）";
  if (url.includes("protocol.js") || url.includes("protocol.ts")) return "行文本编码与字段描述";
  if ((name === "emitOutcome" || name === "send") && (url.includes("server.js") || url.includes("server.ts"))) {
    return "行文本编码与字段描述";
  }
  if (url.startsWith("node:net") || url.startsWith("node:internal")) {
    if (name.toLowerCase().includes("write") || url.includes("socket") || url.includes("stream")) {
      return "socket 写入（`writeBuffer`、写封装）";
    }
  }
  if (name === "writev") return "socket 写入（`writeBuffer`、写封装）";
  return "事件循环与其余杂项";
}

function summarizeProfile(profilePath, timedRegionStartUs) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const selfMicroseconds = new Map();
  // 剖析从进程启动就挂着，建表与灌种（整段快照重编码 + fsync + rename）不是
  // 每语句成本。`uv_hrtime` 在父子进程间同源，用计时区起点对齐 `startTime`
  // 丢弃稳态查询之前的采样。
  const cutoff = timedRegionStartUs - profile.startTime;
  let cumulative = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    cumulative += profile.timeDeltas[index] ?? 0;
    if (cumulative < cutoff) continue;
    const id = profile.samples[index];
    const delta = profile.timeDeltas[index] ?? 0;
    selfMicroseconds.set(id, (selfMicroseconds.get(id) ?? 0) + delta);
  }
  const buckets = new Map(STAGES.map((stage) => [stage, 0]));
  const miscFrames = [];
  let total = 0;
  for (const node of profile.nodes) {
    const own = selfMicroseconds.get(node.id);
    if (own === undefined) continue;
    const stage = classify(node);
    buckets.set(stage, (buckets.get(stage) ?? 0) + own);
    total += own;
    if (stage === "事件循环与其余杂项") {
      miscFrames.push({ name: node.callFrame.functionName || "(anonymous)", url: node.callFrame.url || "", us: own });
    }
  }
  miscFrames.sort((left, right) => right.us - left.us);
  return { buckets, total, samples: profile.samples.length, miscFrames: miscFrames.slice(0, 12) };
}

function provenance() {
  const run = (command, args) => {
    try {
      return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "n/a";
    }
  };
  const cargoToml = readFileSync(join(repoRoot, "projects", "postgres.rs", "postgres-napi", "Cargo.toml"), "utf8");
  const pin = /rev = "([0-9a-f]{40})"/.exec(cargoToml)?.[1] ?? "n/a";
  return { node: process.version, rustc: run("rustc", ["--version"]), rev: run("git", ["rev-parse", "--short", "HEAD"]), databaseRsPin: pin.slice(0, 7) };
}

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), "postgres-profile-"));
  const server = await startPgServer({
    execArgv: ["--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-interval=${INTERVAL_US}`],
  });
  const client = await openNativeClient(server);
  let wallMs = 0;
  let timedRegionStartUs = 0;
  try {
    await client.createTable();
    await client.createBench(SEED_ROWS, 100);

    // 热身：剖析从计时区开始就挂着，先让服务端进入稳态，再截断式计时。
    for (let index = 0; index < 200; index += 1) await client.query(`SELECT id, val FROM bench WHERE id = ${1 + (index % SEED_ROWS)}`);

    // `process.hrtime.bigint()` 与子进程剖析的 `startTime` 同为 `uv_hrtime`，
    // 用计时区起点对齐剖析时间轴，丢弃灌种与热身的采样。
    timedRegionStartUs = Number(process.hrtime.bigint()) / 1_000;
    const start = process.hrtime.bigint();
    for (let index = 0; index < STATEMENTS; index += 1) {
      const id = 1 + (index % SEED_ROWS);
      const rows = await client.query(`SELECT id, val FROM bench WHERE id = ${id}`);
      if (rows !== 1) throw new Error(`point miss id=${id}`);
    }
    wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(`wall: ${(wallMs / STATEMENTS).toFixed(3)} ms/语句（${STATEMENTS} 条）`);
  } finally {
    await client.close();
    await server.close();
  }

  const files = readdirSync(profileDir).filter((name) => name.endsWith(".cpuprofile"));
  if (files.length !== 1) throw new Error(`expected one cpuprofile, found ${files.length}`);
  const { buckets, total, samples, miscFrames } = summarizeProfile(join(profileDir, files[0]), timedRegionStartUs);
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  const source = provenance();
  const summary = native.harnessBenchSummary([wallMs / STATEMENTS]);
  const lines = [];
  lines.push("# 每语句固定开销拆分：`@yydb/postgres` 点查剖析");
  lines.push("");
  lines.push(
    `对象：\`SELECT id, val FROM bench WHERE id = ?\`，${SEED_ROWS} 行数据集、主键点查，连续 ${STATEMENTS} 条简单查询（无参数绑定、无连接池）。`,
  );
  lines.push(
    `方法：服务端子进程加 \`--cpu-prof --cpu-prof-interval=${INTERVAL_US}\`，按 self time 归并到阶段，除以语句数得到 µs/语句；客户端在同一台机器上，\`idle\` 是等回包的往返时间。`,
  );
  lines.push("本报告只记录服务端 CPU 采样，不含客户端驱动自身开销；绝对值与基准脚本的 ms/语句不可直接相加。");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push(`- node \`${source.node}\`，rustc \`${source.rustc}\`，本仓 rev \`${source.rev}\`，database.rs 钉住 rev \`${source.databaseRsPin}\``);
  lines.push(`- 采样 ${samples} 帧，采样总时长 ${(total / 1_000).toFixed(1)} ms，实测 ${(summary.medianMs).toFixed(3)} ms/语句`);
  lines.push("");
  lines.push("## 阶段拆分");
  lines.push("");
  lines.push("| 阶段 | µs/语句 | 占比 |");
  lines.push("|-----:|--------:|-----:|");
  for (const stage of STAGES) {
    const micros = buckets.get(stage) ?? 0;
    lines.push(`| ${stage} | ${(micros / STATEMENTS).toFixed(1)} | ${((micros / total) * 100).toFixed(1)}% |`);
  }
  lines.push(`| **合计（采样）** | **${(total / STATEMENTS).toFixed(1)}** | 100.0% |`);
  lines.push("");
  lines.push("## 事件循环与杂项的 top 帧");
  lines.push("");
  lines.push("| 帧 | µs/语句 |");
  lines.push("|----|--------:|");
  for (const frame of miscFrames) {
    const short = frame.url.replace(/^file:\/\/\/.*?packages\//, "").replace(/\?.*$/, "");
    lines.push(`| \`${frame.name}\` @ ${short || "node 内部"} | ${(frame.us / STATEMENTS).toFixed(1)} |`);
  }
  lines.push("");
  lines.push("## 归并规则");
  lines.push("");
  lines.push("V8 CPU profile 里 napi 调用没有独立 JS 帧，原生耗时记在直接调用它的 JS 帧上：`store.js` 的 scan/commitChanges 包装与 `database.js` 的 `table`/`scanIndex`（含行数据解码）归入原生扫描；`node:net`/`node:internal` 的写帧归入 socket 写入；其余未识别帧归入事件循环与杂项。");
  lines.push("");
  lines.push("Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries profile:point`");
  lines.push("");

  writeFileSync(join(exampleRoot, "reports", "profile-point.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
}

try {
  await main();
} catch (error) {
  console.error("PROFILE-POINT FAIL");
  console.error(error);
  process.exitCode = 1;
}
