import pg from "pg";
import { CREATE_TABLE_SQL, INSERT_SQL, POINT_SQL, PREPARED_NAME, SCAN_SQL } from "./sql.mjs";

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
    async close() {
      await client.end();
    },
  };
}
