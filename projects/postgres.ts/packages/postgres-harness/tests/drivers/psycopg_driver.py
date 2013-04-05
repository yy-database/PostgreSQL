"""psycopg driver acceptance script.

Runs the same logical cases as ``node_pg_driver.mjs``. Values are normalized to
strings so both drivers produce identical JSON for the committed real-server
fixture. ``psycopg`` sends binary parameters for the types it knows, which is
what makes this script cover wire-level parameter decoding.
"""

import datetime
import decimal
import json
import os
import sys
import uuid

import psycopg

HOST = os.environ.get("DRIVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("DRIVER_PORT", "55432"))
USER = os.environ.get("DRIVER_USER", "postgres")
DATABASE = os.environ.get("DRIVER_DATABASE", "postgres")
RESULT = os.environ.get("DRIVER_RESULT_FILE")

TYPES = """
CREATE TABLE driver_types (
    c_bool boolean,
    c_int2 int2,
    c_int4 int4,
    c_int8 int8,
    c_float4 float4,
    c_float8 float8,
    c_numeric numeric,
    c_text text,
    c_varchar varchar(16),
    c_bpchar char(8),
    c_date date,
    c_timestamp timestamp,
    c_timestamptz timestamptz,
    c_uuid uuid,
    c_bytea bytea,
    c_int4_array int4[],
    c_text_array text[]
)
"""

TYPE_COLUMNS = [
    "c_bool",
    "c_int2",
    "c_int4",
    "c_int8",
    "c_float4",
    "c_float8",
    "c_numeric",
    "c_text",
    "c_varchar",
    "c_bpchar",
    "c_date",
    "c_timestamp",
    "c_timestamptz",
    "c_uuid",
    "c_bytea",
    "c_int4_array",
    "c_text_array",
]

TYPE_PARAMETERS = (
    True,
    -32768,
    -2147483648,
    9007199254740993,
    1.25,
    -2.5,
    decimal.Decimal("1234567890.123456789"),
    "héllo",
    "abc",
    "abc",
    datetime.date(2024, 2, 29),
    datetime.datetime(2024, 2, 29, 12, 34, 56, 789012),
    datetime.datetime(2024, 2, 29, 12, 34, 56, 789012, tzinfo=datetime.timezone.utc),
    uuid.UUID("123e4567-e89b-12d3-a456-426614174000"),
    b"\x00\xff\x10",
    [1, -2, 3],
    ["a", "b c", None],
)


def text_projection():
    return ", ".join(f"{column}::text" for column in TYPE_COLUMNS)


def run():
    result = {}
    with psycopg.connect(host=HOST, port=PORT, user=USER, dbname=DATABASE) as conn:
        conn.execute("SET TimeZone TO 'UTC'")
        conn.execute("SET DateStyle TO 'ISO, MDY'")

        conn.execute("DROP TABLE IF EXISTS driver_types")
        conn.execute(TYPES)
        placeholders = ", ".join(["%s"] * len(TYPE_COLUMNS))
        conn.execute(f"INSERT INTO driver_types VALUES ({placeholders})", TYPE_PARAMETERS)
        conn.commit()
        result["fidelity/row"] = dict(
            zip(TYPE_COLUMNS, conn.execute(f"SELECT {text_projection()} FROM driver_types").fetchone())
        )

        conn.execute("DROP TABLE IF EXISTS driver_crud")
        conn.execute("CREATE TABLE driver_crud (id int PRIMARY KEY, name text)")
        conn.execute("INSERT INTO driver_crud VALUES (%s, %s)", (1, "alpha"))
        conn.execute("INSERT INTO driver_crud VALUES (%s, %s)", (2, "beta"))
        conn.commit()
        result["crud/select"] = [list(row) for row in conn.execute("SELECT id, name FROM driver_crud ORDER BY id").fetchall()]
        conn.execute("UPDATE driver_crud SET name = %s WHERE id = %s", ("gamma", 2))
        conn.execute("DELETE FROM driver_crud WHERE id = %s", (1,))
        conn.commit()
        result["crud/after"] = [list(row) for row in conn.execute("SELECT id, name FROM driver_crud ORDER BY id").fetchall()]

        conn.execute("DROP TABLE IF EXISTS driver_tx")
        conn.execute("CREATE TABLE driver_tx (n int)")
        conn.commit()
        conn.execute("INSERT INTO driver_tx VALUES (1)")
        conn.rollback()
        result["transaction/count"] = conn.execute("SELECT count(*) FROM driver_tx").fetchone()[0]

        conn.execute("DROP TABLE IF EXISTS driver_err")
        conn.execute("CREATE TABLE driver_err (id int PRIMARY KEY, n int CHECK (n > 0))")
        conn.commit()
        try:
            conn.execute("INSERT INTO driver_err VALUES (1, -1)")
        except psycopg.Error as error:
            info = error.diag
            result["error"] = {
                "code": info.sqlstate,
                "detail": info.message_detail,
                "constraint": info.constraint_name,
                "schema": info.schema_name,
                "table": info.table_name,
            }
        conn.rollback()

        conn.execute("DROP TABLE IF EXISTS driver_cursor")
        conn.execute("CREATE TABLE driver_cursor (n int)")
        conn.execute("INSERT INTO driver_cursor VALUES (1), (2), (3)")
        conn.commit()
        with conn.cursor(name="driver_cur") as cursor:
            cursor.execute("SELECT n FROM driver_cursor ORDER BY n")
            result["cursor/rows"] = [row[0] for row in cursor.fetchall()]
    return result


try:
    payload = run()
except Exception as error:  # noqa: BLE001
    print(f"psycopg driver failed: {type(error).__name__}: {error}", file=sys.stderr)
    raise

text = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2)
if RESULT:
    with open(RESULT, "w", encoding="utf-8") as handle:
        handle.write(text + "\n")
else:
    print(text)
