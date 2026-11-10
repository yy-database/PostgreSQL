// Side-by-side throughput of @yydb/postgres and the `pg` driver against the
// same product server. `pg` is the baseline (`1.00x`).
//
// 场景对齐 SQLite 仓 `vs-js-libraries`：批量写入、唯一索引点查、有序索引加
// `LIMIT`、分组聚合、两表连接都在内。统计一律走 `database.harness` 的
// `harnessBenchSummary`（经本仓 napi 直通），不在 JS 侧另写 median/p95。
//
// Run: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (200), BENCH_POINT (500), BENCH_SCAN (1000), BENCH_PREPARED (500),
//      BENCH_ROUNDS (3), BENCH2_ROWS (200), BENCH_ORDER (50), BENCH_GROUP (50),
//      BENCH_JOIN (50), BENCH_BATCH (100)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadNative } from "../../../packages/postgres/dist/index.js";
import { openNativeClient } from "../src/native-client.mjs";
import { openPgClient } from "../src/pg-client.mjs";
import { startPgServer } from "../src/pg-server.mjs";
import { elapsedMs, throughput } from "../src/timing.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(exampleRoot, "..", "..", "..", "..");

const native = loadNative();
if (typeof native.harnessBenchSummary !== "function") {
  throw new Error("the native binding must expose `harnessBenchSummary`; rebuild it with `pnpm build:napi`");
}

function readInt(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

const ROWS = readInt("BENCH_ROWS", 200, 1);
const POINT_OPS = readInt("BENCH_POINT", 500, 1);
const SCAN_ROWS = readInt("BENCH_SCAN", 1_000, 1);
const PREPARED_OPS = readInt("BENCH_PREPARED", 500, 1);
const ROUNDS = readInt("BENCH_ROUNDS", 3, 1);
const BENCH2_ROWS = readInt("BENCH2_ROWS", 200, 1);
const ORDER_OPS = readInt("BENCH_ORDER", 50, 1);
const GROUP_OPS = readInt("BENCH_GROUP", 50, 1);
const JOIN_OPS = readInt("BENCH_JOIN", 50, 1);
const BATCH = readInt("BENCH_BATCH", 100, 1);

const GROUP_SIZE = 10;
const GROUP_COUNT = Math.ceil(BENCH2_ROWS / GROUP_SIZE);

const WORKLOADS = [
  "insert",
  "select-point",
  "select-scan",
  "prepared-point",
  "point-uk",
  "order-limit",
  "group-by",
  "join",
  "batch-insert",
];
const CLIENTS = [
  { key: "pg", open: openPgClient },
  { key: "@yydb/postgres", open: openNativeClient },
];

function idsFor(count, seedRows) {
  return Array.from({ length: count }, (_, index) => (index % seedRows) + 1);
}

async function runRound(clientSpec, workload) {
  const server = await startPgServer();
  try {
    const client = await clientSpec.open(server);
    try {
      await client.createTable();
      if (workload === "insert" || workload === "select-point" || workload === "select-scan" || workload === "prepared-point") {
        const seedRows = workload === "insert" ? 0 : workload === "select-scan" ? SCAN_ROWS : ROWS;
        for (let id = 1; id <= seedRows; id += 1) await client.insert(id, `row-${id}`, id);
      }
      if (workload === "batch-insert") {
        // 批量写入从空 `bench` 开始，计时区内灌满 `BENCH_ROWS` 行。
        await client.createBench(0, BATCH);
      } else if (workload === "point-uk" || workload === "order-limit" || workload === "group-by" || workload === "join") {
        await client.createBench(BENCH2_ROWS, BATCH);
      }

      let preparedName = null;
      if (workload === "prepared-point") preparedName = await client.preparePoint();

      const start = process.hrtime.bigint();
      let ops;

      if (workload === "insert") {
        for (let id = 1; id <= ROWS; id += 1) await client.insert(id, `row-${id}`, id);
        ops = ROWS;
      } else if (workload === "select-point") {
        for (const id of idsFor(POINT_OPS, ROWS)) await client.point(id);
        ops = POINT_OPS;
      } else if (workload === "select-scan") {
        const rows = await client.scan();
        if (rows.length !== SCAN_ROWS) throw new Error(`scan returned ${rows.length} rows, expected ${SCAN_ROWS}`);
        ops = rows.length;
      } else if (workload === "prepared-point") {
        for (const id of idsFor(PREPARED_OPS, ROWS)) await client.preparedPoint(preparedName, id);
        ops = PREPARED_OPS;
      } else if (workload === "point-uk") {
        for (const id of idsFor(POINT_OPS, BENCH2_ROWS)) await client.pointUk(id);
        ops = POINT_OPS;
      } else if (workload === "order-limit") {
        for (let index = 0; index < ORDER_OPS; index += 1) {
          const rows = await client.query("SELECT id, val FROM bench ORDER BY val DESC, id LIMIT 20");
          if (rows !== 20) throw new Error(`order-limit rows=${rows}`);
        }
        ops = ORDER_OPS;
      } else if (workload === "group-by") {
        for (let index = 0; index < GROUP_OPS; index += 1) {
          const rows = await client.query("SELECT grp, COUNT(*) AS n, SUM(val) AS s FROM bench GROUP BY grp ORDER BY grp");
          if (rows !== GROUP_COUNT) throw new Error(`group-by groups=${rows}`);
        }
        ops = GROUP_OPS;
      } else if (workload === "join") {
        for (let index = 0; index < JOIN_OPS; index += 1) {
          const grp = index % GROUP_COUNT;
          const rows = await client.join(grp);
          const expected = Math.min(GROUP_SIZE, BENCH2_ROWS - grp * GROUP_SIZE);
          if (rows !== expected) throw new Error(`join rows=${rows} expected=${expected} grp=${grp}`);
        }
        ops = JOIN_OPS;
      } else if (workload === "batch-insert") {
        let inserted = 0;
        for (let start2 = 1; start2 <= ROWS; start2 += BATCH) {
          const count = Math.min(BATCH, ROWS - start2 + 1);
          const touched = await client.batchInsert(start2, count);
          if (touched !== count) throw new Error(`batch-insert touched=${touched} expected=${count}`);
          inserted += touched;
        }
        ops = inserted;
      } else {
        throw new Error(`unknown workload ${workload}`);
      }

      return { ms: elapsedMs(start), ops };
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
}

function summaryOf(samples) {
  return native.harnessBenchSummary(samples);
}

function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return "n/a";
  if (Math.abs(ratio - 1) < 0.005) return "1.00x";
  return `${ratio.toFixed(2)}x`;
}

function ratioTable(results) {
  return WORKLOADS.map((workload) => {
    const baseline = results[workload].pg.summary.medianMs;
    const ratios = Object.fromEntries(
      CLIENTS.map((client) => {
        const summary = results[workload][client.key].summary;
        return [client.key, summary.medianMs / baseline];
      }),
    );
    const best = Math.min(...Object.values(ratios).filter((ratio) => Number.isFinite(ratio)));
    const cells = Object.fromEntries(
      Object.entries(ratios).map(([key, ratio]) => [
        key,
        Number.isFinite(ratio) && Math.abs(ratio - best) < 1e-9 ? `**${formatRatio(ratio)}**` : formatRatio(ratio),
      ]),
    );
    return { workload, ratios, cells };
  });
}

function provenance() {
  const run = (command, args, cwd) => {
    try {
      return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "n/a";
    }
  };
  const cargoToml = readFileSync(join(repoRoot, "projects", "postgres.rs", "postgres-napi", "Cargo.toml"), "utf8");
  const pin = /rev = "([0-9a-f]{40})"/.exec(cargoToml)?.[1] ?? "n/a";
  return {
    node: process.version,
    rustc: run("rustc", ["--version"], repoRoot),
    rev: run("git", ["rev-parse", "--short", "HEAD"], repoRoot),
    databaseRsPin: pin.slice(0, 7),
    dataset: `bench_items ${ROWS}/${SCAN_ROWS} 行，bench ${BENCH2_ROWS} 行（uk 唯一、grp 每组 ${GROUP_SIZE} 行、(val DESC, id) 索引），批量 ${BATCH} 行/语句`,
  };
}

function printTables(results, source) {
  const names = CLIENTS.map((client) => client.key);
  const relative = ratioTable(results);
  const widths = names.map((name) => Math.max(name.length, ...relative.map((row) => row.cells[name].length)));
  const workloadWidth = 15;
  const pad = (text, width) => String(text).padStart(width);

  console.log("vs-js-libraries — relative to `pg` baseline (time ratio; smaller is faster)");
  console.log(
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_POINT=${POINT_OPS}, BENCH_SCAN=${SCAN_ROWS}, BENCH_PREPARED=${PREPARED_OPS}, BENCH_ROUNDS=${ROUNDS}, BENCH2_ROWS=${BENCH2_ROWS}, BENCH_ORDER=${ORDER_OPS}, BENCH_GROUP=${GROUP_OPS}, BENCH_JOIN=${JOIN_OPS}, BENCH_BATCH=${BATCH}`,
  );
  console.log(["Workload".padEnd(workloadWidth), ...names.map((name, index) => pad(name, widths[index]))].join("  "));
  for (const row of relative) {
    console.log([row.workload.padEnd(workloadWidth), ...names.map((name, index) => pad(row.cells[name], widths[index]))].join("  "));
  }
  console.log("");

  console.log("Absolute median/p95 per round (`database.harness` nearest-rank)");
  console.log(
    ["Workload".padEnd(workloadWidth), "Client".padEnd(16), pad("median ms", 12), pad("p95 ms", 12), pad("ms/op", 10), pad("ops/s", 16)].join("  "),
  );
  for (const workload of WORKLOADS) {
    for (const client of CLIENTS) {
      const result = results[workload][client.key];
      const summary = result.summary;
      const perOp = native.harnessBenchPerOp(summary, result.ops);
      console.log(
        [
          workload.padEnd(workloadWidth),
          client.key.padEnd(16),
          pad(summary.medianMs.toFixed(2), 12),
          pad(summary.p95Ms.toFixed(2), 12),
          pad(perOp.toFixed(3), 10),
          pad(throughput(result.ops, summary.medianMs), 16),
        ].join("  "),
      );
    }
  }
  console.log("");
  console.log(`provenance: node ${source.node}, rustc ${source.rustc}, rev ${source.rev}, database.rs pin ${source.databaseRsPin}`);
  console.log(`dataset: ${source.dataset}`);
  console.log("");
}

function markdownReport(results, source) {
  const names = CLIENTS.map((client) => client.key);
  const relative = ratioTable(results);
  const relativeLines = [
    `| Workload | ${names.join(" | ")} |`,
    `|---------:|${names.map(() => "-------:").join("|")}|`,
    ...relative.map((row) => `| ${row.workload} | ${names.map((name) => row.cells[name]).join(" | ")} |`),
  ].join("\n");

  const absoluteLines = [
    "| Workload | Client | Median round ms | p95 round ms | ms/op | ops/s |",
    "|---------:|-------:|-------:|-------:|-------:|-------:|",
    ...WORKLOADS.flatMap((workload) =>
      CLIENTS.map((client) => {
        const result = results[workload][client.key];
        const summary = result.summary;
        const perOp = native.harnessBenchPerOp(summary, result.ops);
        return `| ${workload} | ${client.key} | ${summary.medianMs.toFixed(2)} | ${summary.p95Ms.toFixed(2)} | ${perOp.toFixed(3)} | ${throughput(result.ops, summary.medianMs)} |`;
      }),
    ),
  ].join("\n");

  return `# Benchmark report

Command: \`pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark\`
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_SCAN=${SCAN_ROWS}\`, \`BENCH_PREPARED=${PREPARED_OPS}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH2_ROWS=${BENCH2_ROWS}\`, \`BENCH_ORDER=${ORDER_OPS}\`, \`BENCH_GROUP=${GROUP_OPS}\`, \`BENCH_JOIN=${JOIN_OPS}\`, \`BENCH_BATCH=${BATCH}\`
Baseline: \`pg\` (one \`pg.Client\` connection) = \`1.00x\`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
统计口径：median/p95 由 \`database.harness\` 的 nearest-rank 判定计算（经本仓 napi 直通 \`harnessBenchSummary\`），JS 侧不另写一份。

## Provenance

| 项 | 值 |
|----|----|
| node | \`${source.node}\` |
| rustc | \`${source.rustc}\` |
| 本仓 rev | \`${source.rev}\` |
| database.rs 钉住 rev | \`${source.databaseRsPin}\` |
| 数据规模 | ${source.dataset} |

## Relative to \`pg\`

${relativeLines}

## Absolute

${absoluteLines}

An op is one inserted row, one point query, one scanned row, one prepared execution, one ordered-limit statement, one grouping statement, one join statement, or one batched row.
One warmup round runs before the measured rounds. The table reports median and p95 of ${ROUNDS} measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- \`pg\` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The \`pg\` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh \`mkdtemp\` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is \`prepare\` plus \`executePrepared\`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.
- \`point-uk\`, \`order-limit\`, \`group-by\`, \`join\` and \`batch-insert\` run against the shared \`bench\`/\`bench_join\` shape of \`benchmark-vs-postgres16.mjs\`: \`uk\` carries the unique index, \`(val DESC, id)\` carries the ordered index, \`grp\` has no index.

Regenerate: \`pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark\`
`;
}

try {
  const results = {};
  for (const workload of WORKLOADS) {
    results[workload] = {};
    for (const client of CLIENTS) {
      await runRound(client, workload);
      const samples = [];
      for (let round = 0; round < ROUNDS; round += 1) samples.push(await runRound(client, workload));
      results[workload][client.key] = {
        summary: summaryOf(samples.map((sample) => sample.ms)),
        ops: samples[0].ops,
        samples: samples.map((sample) => sample.ms),
      };
    }
  }

  const source = provenance();
  printTables(results, source);
  writeFileSync(join(exampleRoot, "reports", "benchmark.md"), markdownReport(results, source), "utf8");
  console.log("Wrote reports/benchmark.md");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
