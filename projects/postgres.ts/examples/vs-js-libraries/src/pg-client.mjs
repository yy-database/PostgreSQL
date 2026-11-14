import pg from "pg";
import {
  BENCH2_CREATE_SQL,
  BENCH2_INDEX_SQL,
  BENCH2_JOIN_CREATE_SQL,
  CREATE_TABLE_SQL,
  INSERT_SQL,
  JOIN_SQL,
  POINT_SQL,
  POINT_UK_SQL,
  PORTAL_SQL,
  PREPARED_NAME,
  SCAN_SQL,
  TEMP_CREATE_SQL,
  TEMP_DROP_SQL,
  TEMP_SELECT_SQL,
  bench2BatchInsert,
  bench2ParamBatchInsert,
  tempTableRows,
} from "./sql.mjs";

const { Client } = pg;

/** Wraps one `pg` connection in the same surface the native client exposes. */
export async function openPgClient(options) {
  const client = new Client({
    host: options.host,
    port: options.port,
    user: options.user ?? "postgres",
    database: options.database ?? "postgres",
  });
  await client.connect();

  return {
    name: "pg",
    async createTable() {
      await client.query(CREATE_TABLE_SQL);
    },
    async insert(id, label, score) {
      const result = await client.query(INSERT_SQL, [id, label, score]);
      if (result.rowCount !== 1) throw new Error(`insert ${id} touched ${result.rowCount} rows`);
    },
    async point(id) {
      const result = await client.query(POINT_SQL, [id]);
      if (result.rowCount !== 1) throw new Error(`point miss id=${id}`);
      return [result.rows[0].label];
    },
    async scan() {
      const result = await client.query(SCAN_SQL);
      return result.rows.map((row) => [String(row.id), row.label, String(row.score)]);
    },
    async preparePoint() {
      const name = PREPARED_NAME;
      await client.query({ name, text: POINT_SQL, values: [1] });
      return name;
    },
    async preparedPoint(name, id) {
      const result = await client.query({ name, text: POINT_SQL, values: [id] });
      if (result.rowCount !== 1) throw new Error(`prepared point miss id=${id}`);
      return [result.rows[0].label];
    },
    /**
     * `pg` exposes no `Execute` row limit, so the driver-level equivalent of a
     * suspended portal is a server-side cursor fetched a page at a time.
     */
    async prepareScan() {
      return PORTAL_SQL;
    },
    async portalFetch(sql, batch) {
      await client.query(`DECLARE bench_page CURSOR FOR ${sql}`);
      let rows = 0;
      try {
        for (;;) {
          const result = await client.query(`FETCH ${batch} FROM bench_page`);
          rows += result.rowCount;
          if (result.rowCount < batch) break;
        }
      } finally {
        await client.query("CLOSE bench_page");
      }
      return rows;
    },
    async tempTableCycle() {
      await client.query(TEMP_CREATE_SQL);
      await client.query(`INSERT INTO tmp_bench VALUES ${tempTableRows()}`);
      const result = await client.query(TEMP_SELECT_SQL);
      await client.query(TEMP_DROP_SQL);
      return result.rowCount;
    },
    async multi(sql, expected) {
      const result = await client.query(sql);
      // 一条简单查询报文里有多条语句时，`pg` 回一个结果数组。
      const results = Array.isArray(result) ? result : [result];
      if (results.length !== expected) throw new Error(`multi-statement ran ${results.length} of ${expected}`);
      return results.length;
    },
    async createBench(seedRows, batch) {
      await client.query(BENCH2_CREATE_SQL);
      await client.query(BENCH2_INDEX_SQL);
      await client.query(BENCH2_JOIN_CREATE_SQL);
      const joinRows = [];
      for (let id = 1; id <= seedRows; id += 1) joinRows.push(`(${id}, 'note-${id}')`);
      for (let start = 0; start < joinRows.length; start += batch) {
        await client.query(`INSERT INTO bench_join VALUES ${joinRows.slice(start, start + batch).join(", ")}`);
      }
      for (let start = 1; start <= seedRows; start += batch) {
        await client.query(bench2BatchInsert(start, Math.min(batch, seedRows - start + 1)));
      }
    },
    async pointUk(uk) {
      const result = await client.query(POINT_UK_SQL, [uk]);
      if (result.rowCount !== 1) throw new Error(`point-uk miss uk=${uk}`);
      return [String(result.rows[0].id), String(result.rows[0].val)];
    },
    async query(sql) {
      const result = await client.query(sql);
      return result.rows.length;
    },
    async join(grp) {
      const result = await client.query(JOIN_SQL, [grp]);
      return result.rows.length;
    },
    async batchInsert(start, count) {
      const result = await client.query(bench2BatchInsert(start, count));
      return result.rowCount;
    },
    async batchInsertParams(start, count) {
      const { sql, values } = bench2ParamBatchInsert(start, count);
      const result = await client.query(sql, values);
      return result.rowCount;
    },
    async close() {
      await client.end();
    },
  };
}
