export const CREATE_TABLE_SQL =
  "CREATE TABLE bench_items (id integer PRIMARY KEY, label text NOT NULL, score integer NOT NULL)";

export const INSERT_SQL = "INSERT INTO bench_items (id, label, score) VALUES ($1, $2, $3)";

export const POINT_SQL = "SELECT label FROM bench_items WHERE id = $1";

export const SCAN_SQL = "SELECT id, label, score FROM bench_items ORDER BY id";

export const PREPARED_NAME = "bench-point";

export const INSERT_TYPE_OIDS = [23, 25, 23];
export const POINT_TYPE_OIDS = [23];

// 场景对齐 SQLite 仓的 `vs-js-libraries`：唯一索引点查、有序索引加 `LIMIT`、
// 分组聚合、两表连接、批量写入。表形状与 `benchmark-vs-postgres16.mjs` 一致，
// 两侧客户端跑同一组语句文本。

export const BENCH2_CREATE_SQL =
  "CREATE TABLE bench (id integer PRIMARY KEY, uk integer UNIQUE, grp integer NOT NULL, val integer NOT NULL, pad text)";

export const BENCH2_INDEX_SQL = "CREATE INDEX bench_val_idx ON bench (val DESC, id)";

export const BENCH2_JOIN_CREATE_SQL = "CREATE TABLE bench_join (id integer PRIMARY KEY, note text)";

export const POINT_UK_SQL = "SELECT id, val FROM bench WHERE uk = $1";

export const ORDER_LIMIT_SQL = "SELECT id, val FROM bench ORDER BY val DESC, id LIMIT 20";

export const GROUP_BY_SQL = "SELECT grp, COUNT(*) AS n, SUM(val) AS s FROM bench GROUP BY grp ORDER BY grp";

export const JOIN_SQL = "SELECT b.id, o.note FROM bench b INNER JOIN bench_join o ON o.id = b.id WHERE b.grp = $1";

export const POINT_UK_TYPE_OIDS = [23];
export const JOIN_TYPE_OIDS = [23];

/** `rowTuple` 与 `benchmark-vs-postgres16.mjs` 同形，保证两侧数据集一致。 */
export function bench2RowTuple(id) {
  const grp = Math.floor((id - 1) / 10);
  const val = (id * 137) % 997;
  return `(${id}, ${id}, ${grp}, ${val}, 'row-${id}')`;
}

export function bench2BatchInsert(start, count) {
  const rows = [];
  for (let id = start; id < start + count; id += 1) rows.push(bench2RowTuple(id));
  return `INSERT INTO bench VALUES ${rows.join(", ")}`;
}
