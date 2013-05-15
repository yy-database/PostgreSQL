// Side-by-side throughput of @yydb/postgres and the `pg` driver against the
// same product server. `pg` is the baseline (`1.00x`).
//
// Run: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (200), BENCH_POINT (500), BENCH_SCAN (1000), BENCH_PREPARED (500), BENCH_ROUNDS (3)

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openNativeClient } from "../src/native-client.mjs";
import { openPgClient } from "../src/pg-client.mjs";
import { startPgServer } from "../src/pg-server.mjs";
import { elapsedMs, median, throughput } from "../src/timing.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const WORKLOADS = ["insert", "select-point", "select-scan", "prepared-point"];
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
      const seedRows = workload === "insert" ? 0 : workload === "select-scan" ? SCAN_ROWS : ROWS;
      for (let id = 1; id <= seedRows; id += 1) await client.insert(id, `row-${id}`, id);

      let preparedName = null;
      if (workload === "prepared-point") preparedName = await client.preparePoint();

      const ids = workload === "select-point" ? idsFor(POINT_OPS, ROWS) : workload === "prepared-point" ? idsFor(PREPARED_OPS, ROWS) : [];
      const start = process.hrtime.bigint();
      let ops;

      if (workload === "insert") {
        for (let id = 1; id <= ROWS; id += 1) await client.insert(id, `row-${id}`, id);
        ops = ROWS;
      } else if (workload === "select-point") {
        for (const id of ids) await client.point(id);
        ops = ids.length;
      } else if (workload === "select-scan") {
        const rows = await client.scan();
        if (rows.length !== SCAN_ROWS) throw new Error(`scan returned ${rows.length} rows, expected ${SCAN_ROWS}`);
        ops = rows.length;
      } else {
        for (const id of ids) await client.preparedPoint(preparedName, id);
        ops = ids.length;
      }

      return { ms: elapsedMs(start), ops };
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
}

function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return "n/a";
  if (Math.abs(ratio - 1) < 0.005) return "1.00x";
  return `${ratio.toFixed(2)}x`;
}

function ratioTable(results) {
  return WORKLOADS.map((workload) => {
    const baseline = results[workload].pg.ms;
    const ratios = Object.fromEntries(
      CLIENTS.map((client) => {
        const entry = results[workload][client.key];
        return [client.key, entry.ms / baseline];
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

function printTables(results) {
  const names = CLIENTS.map((client) => client.key);
  const relative = ratioTable(results);
  const widths = names.map((name) => Math.max(name.length, ...relative.map((row) => row.cells[name].length)));
  const workloadWidth = 15;
  const pad = (text, width) => String(text).padStart(width);

  console.log("vs-js-libraries — relative to `pg` baseline (time ratio; smaller is faster)");
  console.log(
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_POINT=${POINT_OPS}, BENCH_SCAN=${SCAN_ROWS}, BENCH_PREPARED=${PREPARED_OPS}, BENCH_ROUNDS=${ROUNDS}`,
  );
  console.log(["Workload".padEnd(workloadWidth), ...names.map((name, index) => pad(name, widths[index]))].join("  "));
  for (const row of relative) {
    console.log([row.workload.padEnd(workloadWidth), ...names.map((name, index) => pad(row.cells[name], widths[index]))].join("  "));
  }
  console.log("");

  console.log("Absolute median per round");
  console.log(
    ["Workload".padEnd(workloadWidth), "Client".padEnd(16), pad("ms", 10), pad("ms/op", 10), pad("ops/s", 16)].join("  "),
  );
  for (const workload of WORKLOADS) {
    for (const client of CLIENTS) {
      const entry = results[workload][client.key];
      console.log(
        [
          workload.padEnd(workloadWidth),
          client.key.padEnd(16),
          pad(entry.ms.toFixed(2), 10),
          pad((entry.ms / entry.ops).toFixed(3), 10),
          pad(throughput(entry.ops, entry.ms), 16),
        ].join("  "),
      );
    }
  }
  console.log("");
}

function markdownReport(results) {
  const names = CLIENTS.map((client) => client.key);
  const relative = ratioTable(results);
  const relativeLines = [
    `| Workload | ${names.join(" | ")} |`,
    `|---------:|${names.map(() => "-------:").join("|")}|`,
    ...relative.map((row) => `| ${row.workload} | ${names.map((name) => row.cells[name]).join(" | ")} |`),
  ].join("\n");

  const absoluteLines = [
    "| Workload | Client | Median round ms | ms/op | ops/s |",
    "|---------:|-------:|-------:|-------:|-------:|",
    ...WORKLOADS.flatMap((workload) =>
      CLIENTS.map((client) => {
        const entry = results[workload][client.key];
        return `| ${workload} | ${client.key} | ${entry.ms.toFixed(2)} | ${(entry.ms / entry.ops).toFixed(3)} | ${throughput(entry.ops, entry.ms)} |`;
      }),
    ),
  ].join("\n");

  return `# Benchmark report

Command: \`pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark\`
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_SCAN=${SCAN_ROWS}\`, \`BENCH_PREPARED=${PREPARED_OPS}\`, \`BENCH_ROUNDS=${ROUNDS}\`
Baseline: \`pg\` (one \`pg.Client\` connection) = \`1.00x\`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to \`pg\`

${relativeLines}

## Absolute

${absoluteLines}

An op is one inserted row, one point query, one scanned row, or one prepared execution.
One warmup round runs before the measured rounds. The table reports the median of ${ROUNDS} measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- \`pg\` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The \`pg\` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh \`mkdtemp\` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is \`prepare\` plus \`executePrepared\`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.

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
        ms: median(samples.map((sample) => sample.ms)),
        ops: samples[0].ops,
        samples: samples.map((sample) => sample.ms),
      };
    }
  }

  printTables(results);
  writeFileSync(join(exampleRoot, "reports", "benchmark.md"), markdownReport(results), "utf8");
  console.log("Wrote reports/benchmark.md");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
