export const CREATE_TABLE_SQL =
  "CREATE TABLE bench_items (id integer PRIMARY KEY, label text NOT NULL, score integer NOT NULL)";

export const INSERT_SQL = "INSERT INTO bench_items (id, label, score) VALUES ($1, $2, $3)";

export const POINT_SQL = "SELECT label FROM bench_items WHERE id = $1";

export const SCAN_SQL = "SELECT id, label, score FROM bench_items ORDER BY id";

export const PREPARED_NAME = "bench-point";

export const INSERT_TYPE_OIDS = [23, 25, 23];
export const POINT_TYPE_OIDS = [23];
