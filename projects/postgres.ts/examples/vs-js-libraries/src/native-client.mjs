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
  SCAN_SQL,
  bench2BatchInsert,
  bench2ParamBatchInsert,
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
