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
//      BENCH_JOIN (50), BENCH_BATCH (100), BENCH_RANGE (100), BENCH_MUTATE (200), BENCH_UPSERT (200),
//      BENCH_SIMPLE (500), BENCH_TX_PREPARED (200), BENCH_RETURNING (100), BENCH_WIDE (100), BENCH_ERROR (100)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadNative } from "../../../packages/postgres/dist/index.js";
import { openNativeClient } from "../src/native-client.mjs";
import { openPgClient } from "../src/pg-client.mjs";
import { startPgServer } from "../src/pg-server.mjs";
import { bench2RowTuple } from "../src/sql.mjs";
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
const RANGE_OPS = readInt("BENCH_RANGE", 100, 1);
const MUTATE_OPS = readInt("BENCH_MUTATE", 200, 1);
const UPSERT_OPS = readInt("BENCH_UPSERT", 200, 1);
const SIMPLE_OPS = readInt("BENCH_SIMPLE", 500, 1);
const TX_PREPARED_OPS = readInt("BENCH_TX_PREPARED", 200, 1);
const RETURNING_OPS = readInt("BENCH_RETURNING", 100, 1);
const WIDE_OPS = readInt("BENCH_WIDE", 100, 1);
const ERROR_OPS = readInt("BENCH_ERROR", 100, 1);

const GROUP_SIZE = 10;
const GROUP_COUNT = Math.ceil(BENCH2_ROWS / GROUP_SIZE);

const WORKLOADS = [
  "insert",
  "select-point",
  "simple-point",
  "select-scan",
  "prepared-point",
  "tx-prepared",
  "point-uk",
  "order-limit",
  "group-by",
  "join",
  "batch-insert",
  "batch-insert-params",
  "distinct",
  "aggregate",
  "subquery",
  "index-range",
  "upsert",
  "update",
  "update-returning",
  "delete",
  "wide-row",
  "error-constraint",
  "rollback",
];
const BENCH_SEEDED = new Set([
  "point-uk",
  "order-limit",
  "group-by",
  "join",
  "distinct",
  "aggregate",
  "subquery",
  "index-range",
  "upsert",
  "update",
  "update-returning",
  "delete",
  "wide-row",
  "error-constraint",
  "rollback",
]);

/** `bench` 的 `val` 由 `bench2RowTuple` 的 `(id * 137) % 997` 决定。 */
function expectedSubqueryRows() {
  let count = 0;
  for (let id = 1; id <= BENCH2_ROWS; id += 1) if ((id * 137) % 997 > 500) count += 1;
  return count;
}

function expectedIndexRangeRows() {
  let count = 0;
  for (let id = 1; id <= BENCH2_ROWS; id += 1) if (id >= 100 && id <= 199) count += 1;
  return count;
}
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
      if (
        workload === "insert"
        || workload === "select-point"
        || workload === "simple-point"
        || workload === "select-scan"
        || workload === "prepared-point"
        || workload === "tx-prepared"
      ) {
        const seedRows = workload === "insert" ? 0 : workload === "select-scan" ? SCAN_ROWS : ROWS;
        for (let id = 1; id <= seedRows; id += 1) await client.insert(id, `row-${id}`, id);
      }
      if (workload === "batch-insert" || workload === "batch-insert-params") {
        // 批量写入从空 `bench` 开始，计时区内灌满 `BENCH_ROWS` 行。
        await client.createBench(0, BATCH);
      } else if (BENCH_SEEDED.has(workload)) {
        await client.createBench(BENCH2_ROWS, BATCH);
      }
      if (workload === "wide-row") {
        // 一半行是 NULL 单元格，另有一行携带 4 KiB 文本，覆盖两类行解码。
        await client.query("UPDATE bench SET pad = NULL WHERE id % 2 = 0");
        await client.query(`UPDATE bench SET pad = '${"x".repeat(4096)}' WHERE id = 1`);
      }

      let preparedName = null;
      if (workload === "prepared-point" || workload === "tx-prepared") preparedName = await client.preparePoint();

      const start = process.hrtime.bigint();
      let ops;

      if (workload === "insert") {
        for (let id = 1; id <= ROWS; id += 1) await client.insert(id, `row-${id}`, id);
        ops = ROWS;
      } else if (workload === "select-point") {
        for (const id of idsFor(POINT_OPS, ROWS)) await client.point(id);
        ops = POINT_OPS;
      } else if (workload === "simple-point") {
        for (const id of idsFor(SIMPLE_OPS, ROWS)) {
          const rows = await client.query(`SELECT id, label, score FROM bench_items WHERE id = ${id}`);
          if (rows !== 1) throw new Error(`simple-point miss id=${id}`);
        }
        ops = SIMPLE_OPS;
      } else if (workload === "select-scan") {
        const rows = await client.scan();
        if (rows.length !== SCAN_ROWS) throw new Error(`scan returned ${rows.length} rows, expected ${SCAN_ROWS}`);
        ops = rows.length;
      } else if (workload === "prepared-point") {
        for (const id of idsFor(PREPARED_OPS, ROWS)) await client.preparedPoint(preparedName, id);
        ops = PREPARED_OPS;
      } else if (workload === "tx-prepared") {
        await client.query("BEGIN");
        for (const id of idsFor(TX_PREPARED_OPS, ROWS)) await client.preparedPoint(preparedName, id);
        await client.query("COMMIT");
        ops = TX_PREPARED_OPS;
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
      } else if (workload === "batch-insert-params") {
        let inserted = 0;
        for (let start2 = 1; start2 <= ROWS; start2 += BATCH) {
          const count = Math.min(BATCH, ROWS - start2 + 1);
          const touched = await client.batchInsertParams(start2, count);
          if (touched !== count) throw new Error(`batch-insert-params touched=${touched} expected=${count}`);
          inserted += touched;
        }
        ops = inserted;
      } else if (workload === "distinct") {
        for (let index = 0; index < GROUP_OPS; index += 1) {
          const rows = await client.query("SELECT DISTINCT grp FROM bench");
          if (rows !== GROUP_COUNT) throw new Error(`distinct groups=${rows} expected=${GROUP_COUNT}`);
        }
        ops = GROUP_OPS;
      } else if (workload === "aggregate") {
        for (let index = 0; index < GROUP_OPS; index += 1) {
          const rows = await client.query("SELECT COUNT(*), SUM(val), MIN(val), MAX(val) FROM bench");
          if (rows !== 1) throw new Error(`aggregate rows=${rows} expected=1`);
        }
        ops = GROUP_OPS;
      } else if (workload === "subquery") {
        const expected = expectedSubqueryRows();
        for (let index = 0; index < GROUP_OPS; index += 1) {
          const rows = await client.query("SELECT COUNT(*) FROM bench WHERE id IN (SELECT id FROM bench WHERE val > 500)");
          if (rows !== 1) throw new Error(`subquery rows=${rows} expected=1 (${expected} matches)`);
        }
        ops = GROUP_OPS;
      } else if (workload === "index-range") {
        const expected = expectedIndexRangeRows();
        for (let index = 0; index < RANGE_OPS; index += 1) {
          const rows = await client.query("SELECT id FROM bench WHERE uk BETWEEN 100 AND 199");
          if (rows !== expected) throw new Error(`index-range rows=${rows} expected=${expected}`);
        }
        ops = RANGE_OPS;
      } else if (workload === "upsert") {
        for (let index = 0; index < UPSERT_OPS; index += 1) {
          const id = (index % BENCH2_ROWS) + 1;
          await client.query(`INSERT INTO bench VALUES ${bench2RowTuple(id)} ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val`);
        }
        ops = UPSERT_OPS;
      } else if (workload === "update") {
        for (let index = 0; index < MUTATE_OPS; index += 1) {
          const id = (index % BENCH2_ROWS) + 1;
          await client.query(`UPDATE bench SET val = val + 1 WHERE id = ${id}`);
        }
        ops = MUTATE_OPS;
      } else if (workload === "update-returning") {
        for (let index = 0; index < RETURNING_OPS; index += 1) {
          const id = (index % BENCH2_ROWS) + 1;
          const rows = await client.query(`UPDATE bench SET val = val + 1 WHERE id = ${id} RETURNING id, val`);
          if (rows !== 1) throw new Error(`update-returning rows=${rows} expected=1 id=${id}`);
        }
        ops = RETURNING_OPS;
      } else if (workload === "wide-row") {
        for (let index = 0; index < WIDE_OPS; index += 1) {
          const id = (index % BENCH2_ROWS) + 1;
          const rows = await client.query(`SELECT id, pad FROM bench WHERE id = ${id}`);
          if (rows !== 1) throw new Error(`wide-row miss id=${id}`);
        }
        ops = WIDE_OPS;
      } else if (workload === "error-constraint") {
        for (let index = 0; index < ERROR_OPS; index += 1) {
          try {
            await client.query("INSERT INTO bench VALUES (1, 1, 0, 0, 'duplicate')");
            throw new Error("expected a unique violation");
          } catch (error) {
            if (!/23505|duplicate key/.test(String(error))) throw error;
          }
        }
        ops = ERROR_OPS;
      } else if (workload === "delete") {
        for (let index = 0; index < MUTATE_OPS; index += 1) {
          const id = (index % BENCH2_ROWS) + 1;
          await client.query(`DELETE FROM bench WHERE id = ${id}`);
        }
        ops = MUTATE_OPS;
      } else if (workload === "rollback") {
        await client.query("BEGIN");
        for (let index = 0; index < MUTATE_OPS; index += 1) {
          const id = 1_000_000 + index;
          await client.query(`INSERT INTO bench VALUES (${id}, ${id}, 0, 0, 'rollback-${index}')`);
        }
        await client.query("ROLLBACK");
        ops = MUTATE_OPS;
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
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_POINT=${POINT_OPS}, BENCH_SCAN=${SCAN_ROWS}, BENCH_PREPARED=${PREPARED_OPS}, BENCH_ROUNDS=${ROUNDS}, BENCH2_ROWS=${BENCH2_ROWS}, BENCH_ORDER=${ORDER_OPS}, BENCH_GROUP=${GROUP_OPS}, BENCH_JOIN=${JOIN_OPS}, BENCH_BATCH=${BATCH}, BENCH_RANGE=${RANGE_OPS}, BENCH_MUTATE=${MUTATE_OPS}, BENCH_UPSERT=${UPSERT_OPS}, BENCH_SIMPLE=${SIMPLE_OPS}, BENCH_TX_PREPARED=${TX_PREPARED_OPS}, BENCH_RETURNING=${RETURNING_OPS}, BENCH_WIDE=${WIDE_OPS}, BENCH_ERROR=${ERROR_OPS}`,
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
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_SCAN=${SCAN_ROWS}\`, \`BENCH_PREPARED=${PREPARED_OPS}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH2_ROWS=${BENCH2_ROWS}\`, \`BENCH_ORDER=${ORDER_OPS}\`, \`BENCH_GROUP=${GROUP_OPS}\`, \`BENCH_JOIN=${JOIN_OPS}\`, \`BENCH_BATCH=${BATCH}\`, \`BENCH_RANGE=${RANGE_OPS}\`, \`BENCH_MUTATE=${MUTATE_OPS}\`, \`BENCH_UPSERT=${UPSERT_OPS}\`, \`BENCH_SIMPLE=${SIMPLE_OPS}\`, \`BENCH_TX_PREPARED=${TX_PREPARED_OPS}\`, \`BENCH_RETURNING=${RETURNING_OPS}\`, \`BENCH_WIDE=${WIDE_OPS}\`, \`BENCH_ERROR=${ERROR_OPS}\`
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

An op is one inserted row, one point query, one simple-protocol point query, one scanned row, one prepared execution, one prepared execution inside a transaction, one ordered-limit statement, one grouping statement, one join statement, one batched row, one parameter-bound batched row, one distinct projection, one aggregate projection, one subquery, one indexed range statement, one upsert, one update, one update with \`RETURNING\`, one delete, one row with a \`NULL\` or 4 KiB cell, one rejected duplicate-key insert, or one rolled-back insert.
One warmup round runs before the measured rounds. The table reports median and p95 of ${ROUNDS} measured rounds.

## Intentional deltas

- Both clients talk to the same product server over loopback with exactly one connection. No pooling, TLS, or compression is used on either side.
- \`pg\` is asynchronous JavaScript and converts result types while it builds rows. The native client is synchronous Rust and returns text cells, so it can only run because the server lives in a child process.
- The \`pg\` client uses the extended protocol for parameterized statements and a simple query for the unparameterized scan. The native client uses a simple query for the scan plus extended query messages for parameterized and prepared statements.
- Every measured round starts a fresh child server and a fresh \`mkdtemp\` data directory. Table creation and seeding happen before timing, and the client is closed and the server killed after the timed region.
- The native prepared path is \`prepare\` plus \`executePrepared\`. The pg prepared path is a named query that prepares on first use, and that preparation call is outside the timed region.
- \`point-uk\`, \`order-limit\`, \`group-by\`, \`join\` and \`batch-insert\` run against the shared \`bench\`/\`bench_join\` shape of \`benchmark-vs-postgres16.mjs\`: \`uk\` carries the unique index, \`(val DESC, id)\` carries the ordered index, \`grp\` has no index.
- \`simple-point\` runs an unparameterised statement through the simple-query protocol, while \`select-point\` binds \`$1\` through Parse/Bind/Describe/Execute. \`batch-insert-params\` is the parameterised twin of \`batch-insert\`, so the pair isolates literal parsing from bind encoding. \`tx-prepared\` runs the same prepared statement inside one \`BEGIN\`/\`COMMIT\`.
- The SQL-feature rows (\`distinct\`, \`aggregate\`, \`subquery\`, \`index-range\`, \`upsert\`, \`update\`, \`update-returning\`, \`delete\`, \`wide-row\`, \`error-constraint\`, \`rollback\`) also run on the shared \`bench\` shape. Both clients send the same literal SQL; their \`query\` wrapper only exposes the returned row count, so aggregate and subquery values are asserted in the SQLite side's benchmark, while this side pins the row-count shape and the client/server ratio.
- \`upsert\` uses the server's \`ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val\`, arbitrated through the primary-key index instead of a full table scan. \`wide-row\` reads rows whose \`pad\` is \`NULL\` on half the ids and 4 KiB on id 1. \`error-constraint\` sends a duplicate-key insert every iteration and times the \`ErrorResponse\` plus \`ReadyForQuery\` round trip.

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
