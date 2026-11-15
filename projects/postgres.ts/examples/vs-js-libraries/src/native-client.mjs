import { loadNative } from "../../../packages/postgres/dist/index.js";
import {
  BENCH2_CREATE_SQL,
  BENCH2_INDEX_SQL,
  BENCH2_JOIN_CREATE_SQL,
  CREATE_TABLE_SQL,
  INSERT_SQL,
  INSERT_TYPE_OIDS,
  JOIN_SQL,
  JOIN_TYPE_OIDS,
  POINT_SQL,
  POINT_TYPE_OIDS,
  POINT_UK_SQL,
  POINT_UK_TYPE_OIDS,
  PORTAL_CURSOR,
  PORTAL_SQL,
  SCAN_SQL,
  TEMP_CREATE_SQL,
  TEMP_DROP_SQL,
  TEMP_SELECT_SQL,
  bench2BatchInsert,
  bench2ParamBatchInsert,
  tempTableRows,
} from "./sql.mjs";

function singleResult(results, context) {
  const [result] = results;
  if (result === undefined) throw new Error(`${context}: the server returned no statement`);
  return result;
}

/**
 * Wraps the synchronous native connection in the same small surface the pg
 * client exposes, so both sides run identical SQL through the same helpers.
 */
export function openNativeClient(options) {
  const connection = loadNative().connect({
    host: options.host,
    port: options.port,
    user: options.user ?? "postgres",
    database: options.database ?? "postgres",
  });

  return {
    name: "@yydb/postgres",
    async createTable() {
      const result = singleResult(connection.execute(CREATE_TABLE_SQL), "create table");
      if (!result.tag.startsWith("CREATE")) throw new Error(`create table tag ${result.tag}`);
    },
    async insert(id, label, score) {
      const result = singleResult(
        connection.executeWithParams(INSERT_SQL, [String(id), label, String(score)], INSERT_TYPE_OIDS),
        `insert ${id}`,
      );
      if (result.tag !== "INSERT 0 1") throw new Error(`insert ${id} tag ${result.tag}`);
    },
    async point(id) {
      const result = singleResult(
        connection.executeWithParams(POINT_SQL, [String(id)], POINT_TYPE_OIDS),
        `point ${id}`,
      );
      if (result.rows.length !== 1) throw new Error(`point miss id=${id}`);
      return result.rows[0].values;
    },
    async scan() {
      const result = singleResult(connection.execute(SCAN_SQL), "scan");
      return result.rows.map((row) => row.values);
    },
    async preparePoint() {
      return connection.prepare(POINT_SQL, POINT_TYPE_OIDS).name();
    },
    async preparedPoint(name, id) {
      const result = singleResult(connection.executePrepared(name, [String(id)]), `prepared point ${id}`);
      if (result.rows.length !== 1) throw new Error(`prepared point miss id=${id}`);
      return result.rows[0].values;
    },
    async prepareScan() {
      return connection.prepare(PORTAL_SQL, []).name();
    },
    /**
     * Drains one named portal in `Execute` batches of `batch` rows.
     *
     * The portal only survives a `Sync` inside an explicit transaction, which the
     * benchmark opens around every drain.
     */
    async portalFetch(statement, batch) {
      connection.bindPortal(statement, PORTAL_CURSOR, [], []);
      let rows = 0;
      try {
        for (;;) {
          const report = connection.executePortal(PORTAL_CURSOR, batch);
          for (const result of report.results) rows += result.rows.length;
          if (!report.suspended) break;
        }
      } finally {
        connection.closePortal(PORTAL_CURSOR);
      }
      return rows;
    },
    async tempTableCycle() {
      connection.execute(TEMP_CREATE_SQL);
      connection.execute(`INSERT INTO tmp_bench VALUES ${tempTableRows()}`);
      const rows = singleResult(connection.execute(TEMP_SELECT_SQL), "temp table select").rows.length;
      connection.execute(TEMP_DROP_SQL);
      return rows;
    },
    /** Runs one statement and returns its affected-row count from the command tag. */
    async mutate(sql) {
      const result = singleResult(connection.execute(sql), `mutate ${sql.slice(0, 40)}`);
      return Number(result.tag.split(" ").pop()) || 0;
    },
    /** One cell of the first row, or `null`. */
    async scalar(sql) {
      const result = singleResult(connection.execute(sql), `scalar ${sql.slice(0, 40)}`);
      const row = result.rows[0];
      return row === undefined ? null : (row.values[0] ?? null);
    },
    /** `COPY ... FROM STDIN` of the pre-built payload; returns the row count. */
    async copyRows(table, columns, payload) {
      const sql = `COPY ${table} (${columns.join(", ")}) FROM STDIN`;
      const report = connection.copyIn(sql, [Buffer.from(payload, "utf8")]);
      if (report.error) throw new Error(`copy-from: ${report.error.code}: ${report.error.message}`);
      return Number(report.tag.split(" ")[1]);
    },
    async listen(channel) {
      connection.execute(`LISTEN ${channel}`);
    },
    async notify(channel, payload) {
      connection.execute(`NOTIFY ${channel}, '${payload}'`);
    },
    /** Number of `NOTIFY` messages drained since the previous call. */
    takeNotifications() {
      return connection.takeNotifications().length;
    },
    /**
     * Drains a `DECLARE`/`FETCH` cursor over `sql`, one page at a time, and
     * returns the number of rows fetched. Both clients run the same SQL.
     */
    async cursorDrain(sql, batch) {
      connection.execute(`DECLARE bench_cursor CURSOR FOR ${sql}`);
      let rows = 0;
      try {
        for (;;) {
          const fetched = singleResult(connection.execute(`FETCH ${batch} FROM bench_cursor`), "fetch").rows.length;
          rows += fetched;
          if (fetched < batch) break;
        }
      } finally {
        connection.execute("CLOSE bench_cursor");
      }
      return rows;
    },
    async multi(sql, expected) {
      const results = connection.execute(sql);
      if (results.length !== expected) throw new Error(`multi-statement ran ${results.length} of ${expected}`);
      return results.length;
    },
    async createBench(seedRows, batch) {
      connection.execute(BENCH2_CREATE_SQL);
      connection.execute(BENCH2_INDEX_SQL);
      connection.execute(BENCH2_JOIN_CREATE_SQL);
      const joinRows = [];
      for (let id = 1; id <= seedRows; id += 1) joinRows.push(`(${id}, 'note-${id}')`);
      for (let start = 0; start < joinRows.length; start += batch) {
        connection.execute(`INSERT INTO bench_join VALUES ${joinRows.slice(start, start + batch).join(", ")}`);
      }
      for (let start = 1; start <= seedRows; start += batch) {
        connection.execute(bench2BatchInsert(start, Math.min(batch, seedRows - start + 1)));
      }
    },
    async pointUk(uk) {
      const result = singleResult(connection.executeWithParams(POINT_UK_SQL, [String(uk)], POINT_UK_TYPE_OIDS), `point-uk ${uk}`);
      if (result.rows.length !== 1) throw new Error(`point-uk miss uk=${uk}`);
      return result.rows[0].values;
    },
    async query(sql) {
      const result = singleResult(connection.execute(sql), `query ${sql.slice(0, 40)}`);
      return result.rows.length;
    },
    async join(grp) {
      const result = singleResult(connection.executeWithParams(JOIN_SQL, [String(grp)], JOIN_TYPE_OIDS), `join grp=${grp}`);
      return result.rows.length;
    },
    async batchInsert(start, count) {
      const result = singleResult(connection.execute(bench2BatchInsert(start, count)), `batch insert ${start}`);
      return Number(result.tag.split(" ")[2]);
    },
    async batchInsertParams(start, count) {
      const { sql, values, types } = bench2ParamBatchInsert(start, count);
      const result = singleResult(connection.executeWithParams(sql, values, types), `param batch insert ${start}`);
      return Number(result.tag.split(" ")[2]);
    },
    async close() {
      connection.close();
    },
  };
}
