// 服务端对服务端：本仓 @yydb/postgres 与真实 PostgreSQL 16 的同机对比。
//
// 公平口径：
// - 双方都用 `pg` 驱动的简单查询（无参数绑定、无预处理、无连接池、无 TLS），
//   唯一差别是服务端实现；
// - 固定建表语句、固定种子数据、固定语句集合；
// - 本仓每轮测量都新起一个子进程服务与临时数据目录，建表与灌种子不计时；
// - 真实库沿用 truth corpus 的连接口径（postgres / 库 postgres），只重建表，不重启实例；
// - 每项先跑一轮热身，再跑 BENCH_ROUNDS 轮，取中位数并记 p95。
//
// 真实库连接：
//   BENCH_REAL_HOST（默认 127.0.0.1）
//   BENCH_REAL_PORT（默认 35432）
//   BENCH_REAL_USER（默认 postgres）
//   BENCH_REAL_PASSWORD（缺省交给 libpq 口径的 `PGPASSWORD`）
//   BENCH_REAL_DATABASE（默认 postgres）
// 真实库不可达时直接失败，不降级为本仓自比。
//
// 统计口径：median/p95 一律走 `database.harness` 的 `harnessBenchSummary`
// （经本仓 napi 直通），JS 侧不另写一份 nearest-rank。
//
// 运行：`pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`

import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadNative } from "../../../packages/postgres/dist/index.js";
import { startPgServer } from "../src/pg-server.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(exampleRoot, "..", "..", "..", "..");
const { Client } = pg;

const native = loadNative();
if (typeof native.harnessBenchSummary !== "function") {
  throw new Error("the native binding must expose `harnessBenchSummary`; rebuild it with `pnpm build:napi`");
}

const REAL = {
  host: process.env.BENCH_REAL_HOST ?? "127.0.0.1",
  port: Number(process.env.BENCH_REAL_PORT ?? 35_432),
  user: process.env.BENCH_REAL_USER ?? "postgres",
  password: process.env.BENCH_REAL_PASSWORD,
  database: process.env.BENCH_REAL_DATABASE ?? "postgres",
};

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const DATASET = Number(process.env.BENCH_DATASET ?? 1_000);
const INSERT_SINGLE = Number(process.env.BENCH_INSERT ?? 300);
const MULTI_BATCH = Number(process.env.BENCH_MULTI_BATCH ?? 100);
const MULTI_STATEMENTS = Number(process.env.BENCH_MULTI_STATEMENTS ?? 4);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 300);
const RANGE_OPS = Number(process.env.BENCH_RANGE ?? 100);
const UPDATE_STATEMENTS = Number(process.env.BENCH_UPDATE ?? 20);
const DELETE_STATEMENTS = Number(process.env.BENCH_DELETE ?? 10);
const ORDER_OPS = Number(process.env.BENCH_ORDER ?? 50);
const GROUP_OPS = Number(process.env.BENCH_GROUP ?? 50);
const JOIN_OPS = Number(process.env.BENCH_JOIN ?? 50);
const TX_COUNT = Number(process.env.BENCH_TX ?? 30);
const TX_ROWS = Number(process.env.BENCH_TX_ROWS ?? 10);
const CONNECT_OPS = Number(process.env.BENCH_CONNECT ?? 20);
const BASELINE_OPS = Number(process.env.BENCH_BASELINE ?? 300);

const ID_BASE = 1_000;
const GROUP_SIZE = Math.floor(DATASET / 10);

const CREATE_TABLE =
  "CREATE TABLE bench (id INT NOT NULL PRIMARY KEY, uk INT UNIQUE, grp INT, val INT, pad VARCHAR(40))";

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// median/p95 走上游 `database.harness` 的 nearest-rank 判定（经 napi 直通），
// 与 SQLite 线 `sqlite-harness` 的 `bench` 同一口径。
function median(samples) {
  return native.harnessBenchSummary(samples).medianMs;
}

function p95(samples) {
  return native.harnessBenchSummary(samples).p95Ms;
}

function rowTuple(id) {
  const grp = Math.floor((id - ID_BASE) / GROUP_SIZE);
  const val = (id * 137) % 997;
  return `(${id}, ${id}, ${grp}, ${val}, 'row-${id}')`;
}

async function seed(connection, statements) {
  await connection.query("DROP TABLE IF EXISTS bench");
  await connection.query(CREATE_TABLE);
  const rows = [];
  for (let id = ID_BASE; id < ID_BASE + statements * MULTI_BATCH; id += 1) rows.push(rowTuple(id));
  if (rows.length > 0) await connection.query(`INSERT INTO bench VALUES ${rows.join(", ")}`);
  const remainder = DATASET - statements * MULTI_BATCH;
  if (remainder > 0) {
    const extra = [];
    for (let offset = 0; offset < remainder; offset += 1) extra.push(rowTuple(ID_BASE + statements * MULTI_BATCH + offset));
    await connection.query(`INSERT INTO bench VALUES ${extra.join(", ")}`);
  }
}

function datasetStatements() {
  return Math.floor(DATASET / MULTI_BATCH);
}

function multiStatement(start) {
  const rows = [];
  for (let id = start; id < start + MULTI_BATCH; id += 1) rows.push(rowTuple(id));
  return `INSERT INTO bench VALUES ${rows.join(", ")}`;
}

const WORKLOADS = [
  {
    name: "insert-single",
    unit: "statements",
    ops: INSERT_SINGLE,
    async setup(connection) {
      await connection.query("DROP TABLE IF EXISTS bench");
      await connection.query(CREATE_TABLE);
    },
    async run(connection) {
      for (let offset = 0; offset < INSERT_SINGLE; offset += 1) {
        await connection.query(`INSERT INTO bench VALUES ${rowTuple(ID_BASE + offset)}`);
      }
      return INSERT_SINGLE;
    },
  },
  {
    name: "insert-multi",
    unit: "rows",
    ops: MULTI_BATCH * MULTI_STATEMENTS,
    async setup(connection) {
      await connection.query("DROP TABLE IF EXISTS bench");
      await connection.query(CREATE_TABLE);
    },
    async run(connection) {
      for (let statement = 0; statement < MULTI_STATEMENTS; statement += 1) {
        await connection.query(multiStatement(ID_BASE + statement * MULTI_BATCH));
      }
      return MULTI_BATCH * MULTI_STATEMENTS;
    },
  },
  {
    name: "point-pk",
    unit: "statements",
    ops: POINT_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      for (let index = 0; index < POINT_OPS; index += 1) {
        const id = ID_BASE + (index % DATASET);
        const result = await connection.query(`SELECT id, val FROM bench WHERE id = ${id}`);
        if (result.rowCount !== 1) throw new Error(`point-pk miss id=${id}`);
      }
      return POINT_OPS;
    },
  },
  {
    name: "point-uk",
    unit: "statements",
    ops: POINT_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      for (let index = 0; index < POINT_OPS; index += 1) {
        const uk = ID_BASE + (index % DATASET);
        const result = await connection.query(`SELECT id, val FROM bench WHERE uk = ${uk}`);
        if (result.rowCount !== 1) throw new Error(`point-uk miss uk=${uk}`);
      }
      return POINT_OPS;
    },
  },
  {
    name: "range-limit",
    unit: "statements",
    ops: RANGE_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      // 用 `> AND <=` 表达 20 行窗口，和 `BETWEEN` 走同一组索引下界与上界。
      const span = Math.floor((DATASET - 20) / RANGE_OPS);
      for (let index = 0; index < RANGE_OPS; index += 1) {
        const from = ID_BASE + index * span;
        const result = await connection.query(
          `SELECT id, val FROM bench WHERE id > ${from} AND id <= ${from + 20}`,
        );
        if (result.rowCount !== 20) throw new Error(`range-limit rows=${result.rowCount} from=${from}`);
      }
      return RANGE_OPS;
    },
  },
  {
    name: "update-many",
    unit: "rows",
    ops: UPDATE_STATEMENTS * GROUP_SIZE,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      let matched = 0;
      for (let grp = 0; grp < UPDATE_STATEMENTS; grp += 1) {
        const result = await connection.query(`UPDATE bench SET val = ${1000 + grp} WHERE grp = ${grp % 10}`);
        matched += result.rowCount ?? 0;
      }
      return matched;
    },
  },
  {
    name: "delete-many",
    unit: "rows",
    ops: DELETE_STATEMENTS * GROUP_SIZE,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      let deleted = 0;
      for (let grp = 0; grp < DELETE_STATEMENTS; grp += 1) {
        const result = await connection.query(`DELETE FROM bench WHERE grp = ${grp % 10}`);
        deleted += result.rowCount ?? 0;
      }
      return deleted;
    },
  },
  {
    name: "order-limit",
    unit: "statements",
    ops: ORDER_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
      // 双方都建同一条索引，`ORDER BY ... LIMIT` 才能走有序索引扫描而不是内存排序。
      await connection.query("CREATE INDEX bench_val_idx ON bench (val DESC, id)");
    },
    async run(connection) {
      for (let index = 0; index < ORDER_OPS; index += 1) {
        const result = await connection.query("SELECT id, val FROM bench ORDER BY val DESC, id LIMIT 20");
        if (result.rowCount !== 20) throw new Error(`order-limit rows=${result.rowCount}`);
      }
      return ORDER_OPS;
    },
  },
  {
    name: "group-by",
    unit: "statements",
    ops: GROUP_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
    },
    async run(connection) {
      for (let index = 0; index < GROUP_OPS; index += 1) {
        const result = await connection.query(
          "SELECT grp, COUNT(*) AS n, SUM(val) AS s FROM bench GROUP BY grp ORDER BY grp",
        );
        if (result.rowCount !== 10) throw new Error(`group-by groups=${result.rowCount}`);
      }
      return GROUP_OPS;
    },
  },
  {
    name: "join",
    unit: "statements",
    ops: JOIN_OPS,
    async setup(connection) {
      await seed(connection, datasetStatements());
      await connection.query("DROP TABLE IF EXISTS bench_join");
      await connection.query("CREATE TABLE bench_join (id INT NOT NULL PRIMARY KEY, note VARCHAR(40))");
      const rows = [];
      for (let id = ID_BASE; id < ID_BASE + DATASET; id += 1) rows.push(`(${id}, 'note-${id}')`);
      for (let start = 0; start < rows.length; start += MULTI_BATCH) {
        await connection.query(`INSERT INTO bench_join VALUES ${rows.slice(start, start + MULTI_BATCH).join(", ")}`);
      }
    },
    async run(connection) {
      for (let index = 0; index < JOIN_OPS; index += 1) {
        const grp = index % 10;
        const result = await connection.query(
          `SELECT b.id, o.note FROM bench b INNER JOIN bench_join o ON o.id = b.id WHERE b.grp = ${grp}`,
        );
        if (result.rowCount !== GROUP_SIZE) throw new Error(`join rows=${result.rowCount} grp=${grp}`);
      }
      return JOIN_OPS;
    },
  },
  {
    name: "tx-commit",
    unit: "rows",
    ops: TX_COUNT * TX_ROWS,
    async setup(connection) {
      await connection.query("DROP TABLE IF EXISTS bench");
      await connection.query(CREATE_TABLE);
    },
    async run(connection) {
      let offset = 0;
      for (let tx = 0; tx < TX_COUNT; tx += 1) {
        await connection.query("BEGIN");
        for (let row = 0; row < TX_ROWS; row += 1) {
          await connection.query(`INSERT INTO bench VALUES ${rowTuple(ID_BASE + offset)}`);
          offset += 1;
        }
        await connection.query("COMMIT");
      }
      return TX_COUNT * TX_ROWS;
    },
  },
  {
    name: "baseline-select1",
    unit: "statements",
    ops: BASELINE_OPS,
    async setup(connection) {
      await connection.query("SELECT 1");
    },
    async run(connection) {
      for (let index = 0; index < BASELINE_OPS; index += 1) await connection.query("SELECT 1");
      return BASELINE_OPS;
    },
  },
  {
    name: "connect",
    unit: "connections",
    ops: CONNECT_OPS,
    async setup() {},
    async run(_connection, open) {
      for (let index = 0; index < CONNECT_OPS; index += 1) {
        const connection = await open();
        await connection.query("SELECT 1");
        await connection.end();
      }
      return CONNECT_OPS;
    },
  },
];

async function openReal() {
  const client = new Client({
    host: REAL.host,
    port: REAL.port,
    user: REAL.user,
    password: REAL.password,
    database: REAL.database,
  });
  await client.connect();
  return client;
}

async function openOurs(port) {
  const client = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
  return client;
}

async function measureOurs(workload) {
  const server = await startPgServer();
  let connection;
  try {
    connection = await openOurs(server.port);
    await workload.setup(connection);
    const start = process.hrtime.bigint();
    const ops = await workload.run(connection, () => openOurs(server.port));
    return { ms: elapsedMs(start), ops };
  } finally {
    if (connection !== undefined) await connection.end().catch(() => {});
    await server.close();
  }
}

async function measureReal(workload) {
  const connection = await openReal();
  try {
    await workload.setup(connection);
    const start = process.hrtime.bigint();
    const ops = await workload.run(connection, openReal);
    return { ms: elapsedMs(start), ops };
  } finally {
    await connection.end().catch(() => {});
  }
}

// 语义探针：`BETWEEN` 与等价的 `> AND <=` 必须给出同一结果，不参与性能比值。
async function probeSemantics() {
  const insert = `INSERT INTO semantics VALUES ${Array.from({ length: 100 }, (_, index) => `(${index + 1})`).join(", ")}`;
  const queries = {
    between: "SELECT COUNT(*) AS n FROM semantics WHERE id BETWEEN 6 AND 46",
    range: "SELECT COUNT(*) AS n FROM semantics WHERE id > 6 AND id <= 46",
  };

  async function run(connection) {
    const result = {};
    for (const [key, sql] of Object.entries(queries)) {
      try {
        const outcome = await connection.query(sql);
        result[key] = String(outcome.rows[0].n);
      } catch (error) {
        result[key] = `${error.code ?? "ERR"}: ${error.message}`;
      }
    }
    return result;
  }

  const real = await openReal();
  let realResult;
  try {
    await real.query("DROP TABLE IF EXISTS semantics");
    await real.query("CREATE TABLE semantics (id INT NOT NULL PRIMARY KEY)");
    await real.query(insert);
    realResult = await run(real);
  } finally {
    await real.query("DROP TABLE IF EXISTS semantics").catch(() => {});
    await real.end().catch(() => {});
  }

  const server = await startPgServer();
  let oursResult;
  try {
    const connection = await openOurs(server.port);
    try {
      await connection.query("CREATE TABLE semantics (id INT NOT NULL PRIMARY KEY)");
      await connection.query(insert);
      oursResult = await run(connection);
    } finally {
      await connection.end().catch(() => {});
    }
  } finally {
    await server.close();
  }
  return { real: realResult, ours: oursResult };
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
  return {
    node: process.version,
    rustc: run("rustc", ["--version"]),
    rev: run("git", ["rev-parse", "--short", "HEAD"]),
    databaseRsPin: pin.slice(0, 7),
    dataset: `数据集 ${DATASET} 行（uk 唯一、grp 每组 ${GROUP_SIZE} 行、(val DESC, id) 索引），固定 seed。`,
  };
}

function markdownReport(samples, version, semantics) {
  const lines = [];
  lines.push("# 服务端对服务端：`@yydb/postgres` 与真实 PostgreSQL 16");
  lines.push("");
  lines.push(`真实库：\`${version}\`（\`${REAL.host}:${REAL.port}\`，库 \`${REAL.database}\`）`);
  lines.push("本仓：`@yydb/postgres`（每轮新起子进程服务与临时数据目录）");
  const source = provenance();
  lines.push("统计口径：median/p95 由 `database.harness` 的 nearest-rank 判定计算（经本仓 napi 直通 `harnessBenchSummary`），JS 侧不另写一份。");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|----|----|");
  lines.push(`| node | \`${source.node}\` |`);
  lines.push(`| rustc | \`${source.rustc}\` |`);
  lines.push(`| 本仓 rev | \`${source.rev}\` |`);
  lines.push(`| database.rs 钉住 rev | \`${source.databaseRsPin}\` |`);
  lines.push(`| 数据规模 | ${source.dataset} |`);
  lines.push("");
  lines.push(
    "说明：truth corpus 的 SQL 差分基线来自 pglite 0.5.15；本机装有 PostgreSQL 16.15，这次直接用真实服务端。CI 有 `postgres:16` 时用 `BENCH_REAL_*` 指向该实例重跑。",
  );
  lines.push(`轮次：1 轮热身 + ${ROUNDS} 轮测量，取中位数并记 p95；数据集 ${DATASET} 行，固定 seed。`);
  lines.push("比值 = 本仓耗时 / 真实库耗时，小于 1 表示本仓更快。");
  lines.push("口径：`connect` 一项真实库每次都做认证与初始化握手，本仓连接是极简实现，两者不可比，该行不能当作性能结论。");
  lines.push("口径：`order-limit` 在双方都先建同一条 `(val DESC, id)` 索引，测的是有序索引扫描加 `LIMIT` 提前停止，不是无索引内存排序。");
  lines.push("");
  lines.push("## 按差距排序");
  lines.push("");
  lines.push("| 工作负载 | 单位 | 真实库 ms/op | 本仓 ms/op | 倍数 |");
  lines.push("|---------:|-----:|-------------:|-----------:|-----:|");
  const ranked = WORKLOADS.map((workload) => {
    const real = median(samples.get(workload.name).real);
    const ours = median(samples.get(workload.name).ours);
    return { workload, real, ours, factor: ours / real };
  }).sort((a, b) => b.factor - a.factor);
  for (const entry of ranked) {
    lines.push(
      `| ${entry.workload.name} | ${entry.workload.unit} | ${(entry.real / entry.workload.ops).toFixed(3)} | ${(entry.ours / entry.workload.ops).toFixed(3)} | ${entry.factor.toFixed(2)}x |`,
    );
  }
  lines.push("");
  lines.push("## 绝对耗时与 p95");
  lines.push("");
  lines.push("| 工作负载 | 真实库中位总耗时 ms | 本仓中位总耗时 ms | 真实库 p95 ms | 本仓 p95 ms |");
  lines.push("|---------:|--------------------:|------------------:|--------------:|------------:|");
  for (const workload of WORKLOADS) {
    lines.push(
      `| ${workload.name} | ${median(samples.get(workload.name).real).toFixed(2)} | ${median(samples.get(workload.name).ours).toFixed(2)} | ${p95(samples.get(workload.name).real).toFixed(2)} | ${p95(samples.get(workload.name).ours).toFixed(2)} |`,
    );
  }
  lines.push("");
  lines.push("## 粗粒度阶段差分");
  lines.push("");
  lines.push(
    "线上协议不暴露解析/执行/存储/回包各阶段耗时，这里只做差分估计：以 `baseline-select1` 作为“传输 + 解析 + 回包”地板，写读路径按语句数折算。",
  );
  lines.push("");
  lines.push("| 路径 | 真实库额外 ms/语句 | 本仓额外 ms/语句 | 差额 ms/语句 |");
  lines.push("|-----:|-------------------:|-----------------:|-------------:|");
  const floorReal = median(samples.get("baseline-select1").real) / BASELINE_OPS;
  const floorOurs = median(samples.get("baseline-select1").ours) / BASELINE_OPS;
  const statements = {
    "insert-single": INSERT_SINGLE,
    "point-pk": POINT_OPS,
    "point-uk": POINT_OPS,
    "range-limit": RANGE_OPS,
    "update-many": UPDATE_STATEMENTS,
    "group-by": GROUP_OPS,
    "order-limit": ORDER_OPS,
    join: JOIN_OPS,
  };
  for (const [name, count] of Object.entries(statements)) {
    const real = median(samples.get(name).real) / count - floorReal;
    const ours = median(samples.get(name).ours) / count - floorOurs;
    lines.push(`| ${name} | ${real.toFixed(3)} | ${ours.toFixed(3)} | ${(ours - real).toFixed(3)} |`);
  }
  lines.push("");
  lines.push("## 根因假设与预计收益");
  lines.push("");
  const pkOurs = median(samples.get("point-pk").ours) / POINT_OPS;
  const ukOurs = median(samples.get("point-uk").ours) / POINT_OPS;
  const rangeOurs = median(samples.get("range-limit").ours) / RANGE_OPS;
  const orderOurs = median(samples.get("order-limit").ours) / ORDER_OPS;
  const groupOurs = median(samples.get("group-by").ours) / GROUP_OPS;
  lines.push(
    `- **每语句固定地板**：\`baseline-select1\` 本仓 ${floorOurs.toFixed(3)}ms/语句，真库 ${floorReal.toFixed(3)}ms。地板本身不高，差距主要来自读路径。`,
  );
  lines.push(
    `- **点查走索引**：\`point-pk\` ${pkOurs.toFixed(3)}ms/语句、\`point-uk\` ${ukOurs.toFixed(3)}ms/语句，扣掉地板后为 ${(pkOurs - floorOurs).toFixed(3)}ms 与 ${(ukOurs - floorOurs).toFixed(3)}ms，剩余是索引条目解码与逐行过滤的固定成本，不再随行数整表扫描。`,
  );
  lines.push(
    `- **范围与有序访问走索引、排序与分组仍整表扫**：\`range-limit\` ${rangeOurs.toFixed(3)}ms/语句按索引区间取 20 行后逐行过滤；\`order-limit\` ${orderOurs.toFixed(3)}ms/语句在双方同建的 \`(val DESC, id)\` 上做有序索引扫描，取够 \`LIMIT\` 即停，不再整表排序；\`group-by\` ${groupOurs.toFixed(2)}ms/语句，\`grp\` 没有索引，仍整表扫描后聚合。`,
  );
  lines.push(
    `- **写入成本集中在每次提交的落盘**：\`insert-single\` ${(median(samples.get("insert-single").ours) / INSERT_SINGLE).toFixed(3)}ms/语句，比真库多 ${(median(samples.get("insert-single").ours) / INSERT_SINGLE - median(samples.get("insert-single").real) / INSERT_SINGLE).toFixed(1)}ms；\`tx-commit\` 摊到 ${(median(samples.get("tx-commit").ours) / (TX_COUNT * TX_ROWS)).toFixed(3)}ms/行，说明单条插入把整次提交的落盘成本整笔付一次。同机真实库保持默认 \`synchronous_commit=on\`，口径一致。`,
  );
  lines.push(
    `- **条件更新与删除同样是扫描加逐行改写**：\`update-many\` ${(median(samples.get("update-many").ours) / (UPDATE_STATEMENTS * GROUP_SIZE)).toFixed(3)}ms/行、\`delete-many\` ${(median(samples.get("delete-many").ours) / (DELETE_STATEMENTS * GROUP_SIZE)).toFixed(3)}ms/行。`,
  );
  lines.push(
    `- **连接走等值哈希**：\`join\` ${(median(samples.get("join").ours) / JOIN_OPS).toFixed(3)}ms/语句，两侧各整表载入一次，\`ON o.id = b.id\` 的整数等值键建哈希表后逐行探测，不再逐对求值；\`grp\` 仍无索引，过滤在连接之后。`,
  );
  lines.push("");
  lines.push("## 语义差异（不计入性能比值）");
  lines.push("");
  lines.push("| 语句 | 真实库 | 本仓 |");
  lines.push("|-----:|-------:|-----:|");
  lines.push(`| \`WHERE id BETWEEN 6 AND 46\` | ${semantics.real.between} | ${semantics.ours.between} |`);
  lines.push(`| \`WHERE id > 6 AND id <= 46\` | ${semantics.real.range} | ${semantics.ours.range} |`);
  lines.push("");
  lines.push("Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries benchmark:postgres16`");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const probe = await openReal();
  const query = await probe.query("SELECT version() AS version");
  const version = query.rows[0].version;
  await probe.end();
  console.log(`真实库 ${version} @ ${REAL.host}:${REAL.port}/${REAL.database}`);
  const semantics = await probeSemantics();

  const samples = new Map();
  for (const workload of WORKLOADS) samples.set(workload.name, { real: [], ours: [] });

  console.log("热身一轮（不计入样本）");
  for (const workload of WORKLOADS) {
    await measureReal(workload);
    await measureOurs(workload);
  }

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const workload of WORKLOADS) {
      const real = await measureReal(workload);
      const ours = await measureOurs(workload);
      samples.get(workload.name).real.push(real.ms);
      samples.get(workload.name).ours.push(ours.ms);
      console.log(`round ${round}/${ROUNDS} ${workload.name}: real ${real.ms.toFixed(1)}ms, ours ${ours.ms.toFixed(1)}ms`);
    }
  }

  const report = markdownReport(samples, version, semantics);
  writeFileSync(join(exampleRoot, "reports", "benchmark-vs-postgres16.md"), report, "utf8");
  console.log("");
  console.log(report);
}

try {
  await main();
} catch (error) {
  console.error("BENCHMARK-VS-POSTGRES16 FAIL");
  console.error(error);
  process.exitCode = 1;
}
