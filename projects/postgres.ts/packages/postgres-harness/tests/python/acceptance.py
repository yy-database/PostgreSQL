"""Acceptance assertions over the installed `postgres_pyo3` wheel.

The same JSON corpus that drives the Node suite is replayed here, and every
assertion is recorded under the same `cases` key so the harness can compare
the two bindings case by case.
"""

import json
import os
import shutil
import struct
import sys
import time

import postgres_pyo3 as native
from postgres_pyo3 import ColumnInfo, PostgresError, PsqlOptions, StatementResult

CASES_DIR = os.environ["POSTGRES_CASES_DIR"]
RESULT_FILE = os.environ["POSTGRES_RESULT_FILE"]
STORE_ROOT = os.environ["POSTGRES_STORE_ROOT"]

CONFIG = {
    "host": os.environ.get("POSTGRES_TEST_HOST", "127.0.0.1"),
    "port": int(os.environ.get("POSTGRES_TEST_PORT", "5432")),
    "user": os.environ.get("POSTGRES_TEST_USER", "postgres"),
    "database": os.environ.get("POSTGRES_TEST_DATABASE", "postgres"),
}

counters = {"executed": 0, "skipped": 0, "failed": 0}
failures = []
actual = {}


def same(left, right):
    return json.dumps(left, ensure_ascii=False) == json.dumps(right, ensure_ascii=False)


def check(name, run):
    counters["executed"] += 1
    try:
        run()
    except Exception as error:  # noqa: BLE001 - every assertion failure is captured
        counters["failed"] += 1
        failures.append(f"{name}: {error}")


def expect_equal(name, value, expected):
    def run():
        if not same(value, expected):
            raise AssertionError(f"expected {json.dumps(expected, ensure_ascii=False)} got {json.dumps(value, ensure_ascii=False)}")

    check(name, run)


def expect_error(name, run, expected_message=None):
    def assertion():
        try:
            run()
        except PostgresError as error:
            if expected_message is not None and str(error) != expected_message:
                raise AssertionError(f"expected error '{expected_message}' got '{str(error)}'")
            return
        raise AssertionError("expected an error, none was raised")

    check(name, assertion)


def load_case(name):
    with open(os.path.join(CASES_DIR, name), "r", encoding="utf-8") as handle:
        return json.load(handle)


def to_bytes(value):
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    return bytes(value)


def read_text(value):
    return to_bytes(value).decode("utf-8")


def text(value):
    return value


def statement_from(item):
    return StatementResult(
        [ColumnInfo(column["name"]) for column in item["columns"]],
        [row["values"] for row in item["rows"]],
        item["tag"],
    )


def options_from(**overrides):
    values = {
        "host": "127.0.0.1",
        "port": 5432,
        "user": "postgres",
        "database": "postgres",
        "sql": "",
        "headers": True,
        "separator": "|",
        "null_value": "",
    }
    values.update(overrides)
    return PsqlOptions(**values)


def normalize(results):
    return [
        {
            "columns": [column.name for column in result.columns],
            "rows": [[text(value) for value in row] for row in result.rows],
            "tag": result.tag,
        }
        for result in results
    ]


# -------------------------------------------------------------------------------
# SQL statement surface.
# -------------------------------------------------------------------------------
connection = native.connect(CONFIG["host"], CONFIG["port"], CONFIG["user"], CONFIG["database"])

for item in load_case("sql.json"):
    key = f"sql/{item['name']}"
    try:
        for statement in item.get("setup", []):
            connection.execute(statement)
        results = normalize(connection.execute(item["sql"]))
        actual[key] = results
        expect_equal(f"{key}/result-count", len(results), len(item["expect"]))
        for index, expected in enumerate(item["expect"]):
            result = results[index]
            expect_equal(f"{key}/{index}/columns", result["columns"], expected["columns"])
            expect_equal(f"{key}/{index}/rows", result["rows"], expected["rows"])
            expect_equal(f"{key}/{index}/tag", result["tag"], expected["tag"])
        for statement in item.get("teardown", []):
            connection.execute(statement)
    except Exception as error:  # noqa: BLE001 - a failing case is a failed assertion
        actual[key] = {"error": str(error)}
        check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))

# -------------------------------------------------------------------------------
# Known differences from PGlite, frozen as assertions. `cases/sql-diff.json`
# records the PGlite reply and the reason next to every entry produced by
# `scripts/sql-diff.mjs`, so these guard the documented gap instead of hiding it.
# -------------------------------------------------------------------------------
for item in load_case("sql-diff.json"):
    key = f"sql-diff/{item['name']}"
    try:
        for statement in item.get("setup", []):
            connection.execute(statement)
        if "expectError" in item:
            try:
                connection.execute(item["sql"])
                actual[key] = {"message": None}
                expect_equal(f"{key}/error", None, item["expectError"])
            except PostgresError as error:
                actual[key] = {"code": str(error)[:5], "message": str(error)}
                expect_equal(f"{key}/error", str(error), item["expectError"])
        else:
            results = normalize(connection.execute(item["sql"]))
            actual[key] = results
            expect_equal(f"{key}/result-count", len(results), len(item["expect"]))
            for index, expected in enumerate(item["expect"]):
                result = results[index]
                expect_equal(f"{key}/{index}/columns", result["columns"], expected["columns"])
                expect_equal(f"{key}/{index}/rows", result["rows"], expected["rows"])
                expect_equal(f"{key}/{index}/tag", result["tag"], expected["tag"])
        for statement in item.get("teardown", []):
            connection.execute(statement)
    except Exception as error:  # noqa: BLE001 - a failing case is a failed assertion
        actual[key] = {"error": str(error)}
        check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))

sql_executed = counters["executed"]

# -------------------------------------------------------------------------------
# Server errors and recovery on a still-open connection.
# -------------------------------------------------------------------------------
for item in load_case("errors.json"):
    key = f"errors/{item['name']}"
    try:
        for statement in item.get("setup", []):
            connection.execute(statement)
        try:
            connection.execute(item["sql"])
            raise AssertionError("expected an error, none was raised")
        except PostgresError as error:
            actual[key] = {"code": str(error)[:5], "message": str(error)}
            expect_equal(f"{key}/code", str(error)[:5], item["code"])
            check(
                f"{key}/message",
                lambda error=error: None if item["messageContains"] in str(error) else (_ for _ in ()).throw(
                    AssertionError(f"expected '{item['messageContains']}' in '{str(error)}'")
                ),
            )
            if item.get("recovery"):
                results = connection.execute("SELECT 1 AS n")
                expect_equal(f"{key}/recovery", results[0].rows[0], ["1"])
        for statement in item.get("teardown", []):
            connection.execute(statement)
    except Exception as error:  # noqa: BLE001
        actual[key] = {"error": str(error)}
        check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))
errors_executed = counters["executed"]
connection.close()

# -------------------------------------------------------------------------------
# Parameter binding, extended-protocol frames and prepared statement lifecycle.
# -------------------------------------------------------------------------------
params = load_case("params.json")
params_connection = native.connect(CONFIG["host"], CONFIG["port"], CONFIG["user"], CONFIG["database"])


def type_oids(names):
    oids = []
    for name in names:
        oid = native.parameter_type_oid(name)
        if oid is None:
            raise AssertionError(f"unknown parameter type {name}")
        oids.append(oid)
    return oids


def split_error(message):
    separator = message.find(": ")
    return message[:separator] if separator > 0 else "client"


def count_prepared():
    results = params_connection.execute("SELECT count(*) AS n FROM pg_prepared_statements")
    return int(results[0].rows[0][0])


def encode_message(item):
    kind = item["kind"]
    if kind == "parse":
        return native.encode_parse_message(item["name0"], item["sql"], item["types"])
    if kind == "bind":
        return native.encode_bind_message(item["portal"], item["statement"], item["params"], item["resultFormat"])
    if kind == "describe":
        return native.encode_describe_message(item["target"], item["name0"])
    if kind == "execute":
        return native.encode_execute_message(item["portal"], item["maxRows"])
    if kind == "sync":
        return native.encode_sync_message()
    if kind == "close":
        return native.encode_close_message(item["target"], item["name0"])
    raise AssertionError(f"unknown message kind {kind}")


def reject_message(item):
    if "count" in item:
        if item["kind"] == "parse":
            return native.encode_parse_message("", "SELECT 1", [23] * item["count"])
        return native.encode_bind_message("", "", [None] * item["count"], 0)
    return encode_message(item)


def expect_results(key, results, expected):
    expect_equal(f"{key}/result-count", len(results), len(expected))
    for index, entry in enumerate(expected):
        result = results[index]
        expect_equal(f"{key}/{index}/columns", result["columns"], entry["columns"])
        expect_equal(f"{key}/{index}/rows", result["rows"], entry["rows"])
        expect_equal(f"{key}/{index}/tag", result["tag"], entry["tag"])


for item in params["messages"]["encode"]:
    key = f"params/message/{item['name']}"
    packet = to_bytes(encode_message(item))
    actual[key] = {"hex": packet.hex(), "length": len(packet)}
    expect_equal(f"{key}/bytes", packet.hex(), item["expectHex"])
    expect_equal(f"{key}/length", len(packet), len(item["expectHex"]) // 2)
    expect_equal(f"{key}/length-field", int.from_bytes(packet[1:5], "big"), len(packet) - 1)

for item in params["messages"]["decode"]:
    key = f"params/parameter-description/{item['name']}"
    payload = bytes.fromhex(item["payloadHex"])
    try:
        oids = native.decode_parameter_description(payload)
        actual[key] = {"oids": oids}
        expect_equal(f"{key}/oids", oids, item["expect"])
    except PostgresError as error:
        actual[key] = {"error": str(error)}
        expect_equal(f"{key}/error", str(error), item["expectError"])

for item in params["messages"]["reject"]:
    key = f"params/reject/{item['name']}"
    raised = None
    try:
        reject_message(item)
    except PostgresError as error:
        raised = str(error)
    actual[key] = {"error": raised}
    expect_equal(f"{key}/error", raised, item["expectError"])

for item in params["messages"]["types"]:
    key = f"params/type-oid/{item['name']}"
    oid = native.parameter_type_oid(item["type"])
    actual[key] = oid
    expect_equal(f"{key}/oid", oid, item["oid"])

for item in params["messages"]["bytea"]:
    key = f"params/bytea/{item['name']}"
    encoded = native.encode_bytea(bytes(item["bytes"]))
    actual[key] = encoded
    expect_equal(f"{key}/text", encoded, item["expect"])

for item in params["binding"]:
    key = f"params/binding/{item['name']}"
    try:
        for statement in item.get("setup", []):
            params_connection.execute(statement)
        results = normalize(params_connection.execute_with_params(item["sql"], item["params"], type_oids(item["types"])))
        actual[key] = results
        expect_results(key, results, item["expect"])
        for statement in item.get("teardown", []):
            params_connection.execute(statement)
    except Exception as error:  # noqa: BLE001
        actual[key] = {"error": str(error)}
        check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))

for item in params["errors"]:
    key = f"params/error/{item['name']}"
    raised = None
    try:
        params_connection.execute_with_params(item["sql"], item["params"], type_oids(item["types"]))
    except PostgresError as error:
        raised = error
    if raised is None:
        actual[key] = {"error": "expected an error, none was raised"}
        check(f"{key}/run", lambda: (_ for _ in ()).throw(AssertionError("expected an error, none was raised")))
    else:
        actual[key] = {"code": split_error(str(raised))}
        expect_equal(f"{key}/code", split_error(str(raised)), item["error"]["code"])
        check(
            f"{key}/message",
            lambda raised=raised: None if item["error"]["messageContains"] in str(raised) else (_ for _ in ()).throw(
                AssertionError(f"expected '{item['error']['messageContains']}' in '{str(raised)}'")
            ),
        )
        check(
            f"{key}/recovery",
            lambda: None
            if normalize(params_connection.execute("SELECT 1 AS n"))[0]["rows"] == [["1"]]
            else (_ for _ in ()).throw(AssertionError("recovery query did not return 1")),
        )

for item in params["prepare"]:
    key = f"params/prepare/{item['name']}"
    for statement in item.get("setup", []):
        params_connection.execute(statement)
    try:
        prepared = params_connection.prepare(item["sql"], type_oids(item["types"]))
        metadata = {"parameters": prepared.parameters, "columns": [column.name for column in prepared.columns]}
        actual[key] = metadata
        expect_equal(f"{key}/parameters", metadata["parameters"], item["expectParameters"])
        expect_equal(f"{key}/columns", metadata["columns"], item["expectColumns"])
        prepared.close()
        expect_equal(f"{key}/closed", prepared.is_closed, True)
    except PostgresError as error:
        actual[key] = {"code": split_error(str(error))}
        if "expectError" not in item:
            check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))
        else:
            expect_equal(f"{key}/code", split_error(str(error)), item["expectError"]["code"])
            check(
                f"{key}/message",
                lambda error=error: None if item["expectError"]["messageContains"] in str(error) else (_ for _ in ()).throw(
                    AssertionError(f"expected '{item['expectError']['messageContains']}' in '{str(error)}'")
                ),
            )
    for statement in item.get("teardown", []):
        params_connection.execute(statement)

for item in params["lifecycle"]:
    for statement in item.get("setup", []):
        params_connection.execute(statement)
    statements = []
    for index, op in enumerate(item["ops"]):
        key = f"params/lifecycle/{item['name']}/{index}-{op['op']}"
        try:
            if op["op"] == "prepare":
                prepared = params_connection.prepare(op["sql"], type_oids(op["types"]))
                statements.append(prepared)
                metadata = {"parameters": prepared.parameters, "columns": [column.name for column in prepared.columns]}
                actual[key] = metadata
                expect_equal(f"{key}/parameters", metadata["parameters"], op["expectParameters"])
                expect_equal(f"{key}/columns", metadata["columns"], op["expectColumns"])
            elif op["op"] == "execute":
                results = normalize(statements[op["stmt"]].execute(op["params"]))
                actual[key] = results
                expect_results(key, results, op["expect"])
            elif op["op"] == "close":
                statements[op["stmt"]].close()
                actual[key] = {"closed": statements[op["stmt"]].is_closed}
                expect_equal(f"{key}/closed", statements[op["stmt"]].is_closed, True)
            elif op["op"] == "executeError":
                raised = None
                try:
                    statements[op["stmt"]].execute(op["params"])
                except PostgresError as error:
                    raised = str(error)
                actual[key] = {"error": raised}
                expect_equal(f"{key}/error", raised, op["message"])
            elif op["op"] == "executePreparedError":
                raised = None
                try:
                    params_connection.execute_prepared(statements[op["stmt"]].name, op["params"])
                except PostgresError as error:
                    raised = error
                actual[key] = {"code": None if raised is None else split_error(str(raised))}
                expect_equal(f"{key}/code", None if raised is None else split_error(str(raised)), op["code"])
                check(
                    f"{key}/message",
                    lambda raised=raised: None if raised is not None and op["messageContains"] in str(raised) else (_ for _ in ()).throw(
                        AssertionError(f"expected '{op['messageContains']}' in '{raised}'")
                    ),
                )
            elif op["op"] == "closeNamed":
                params_connection.close_prepared(op["name"])
                actual[key] = {"closed": True}
            elif op["op"] == "query":
                results = normalize(params_connection.execute(op["sql"]))
                actual[key] = results
                expect_results(key, results, op["expect"])
            else:
                raise AssertionError(f"unknown lifecycle op {op['op']}")
        except Exception as error:  # noqa: BLE001
            actual[key] = {"error": str(error)}
            check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))
    for statement in item.get("teardown", []):
        params_connection.execute(statement)

# A statement outliving its connection fails locally instead of writing to a
# closed socket.
key = "params/lifecycle/connection-close"
temporary = native.connect(CONFIG["host"], CONFIG["port"], CONFIG["user"], CONFIG["database"])
prepared = temporary.prepare("SELECT $1::int4 AS v", [23])
temporary.close()
execute_error = None
try:
    prepared.execute(["1"])
except PostgresError as error:
    execute_error = str(error)
prepare_error = None
try:
    temporary.prepare("SELECT 1", [])
except PostgresError as error:
    prepare_error = str(error)
prepared.close()
actual[key] = {"executeError": execute_error, "prepareError": prepare_error, "statementClosed": prepared.is_closed}
expect_equal(f"{key}/execute", execute_error, "connection is closed")
expect_equal(f"{key}/prepare", prepare_error, "connection is closed")
expect_equal(f"{key}/closed", prepared.is_closed, True)

# Unnamed one-shot statements never stay in `pg_prepared_statements`; named
# ones do until they are closed.
key = "params/leak"
baseline = count_prepared()
statements = [params_connection.prepare(params["leak"]["sql"], type_oids(params["leak"]["types"])) for _ in range(3)]
prepared_delta = count_prepared() - baseline
statements[0].execute(params["leak"]["boundParams"])
after_unnamed_delta = count_prepared() - baseline
for statement in statements:
    statement.close()
closed_delta = count_prepared() - baseline
actual[key] = {"preparedDelta": prepared_delta, "afterUnnamedDelta": after_unnamed_delta, "closedDelta": closed_delta}
expect_equal(f"{key}/prepared", prepared_delta, params["leak"]["preparedDelta"])
expect_equal(f"{key}/unnamed", after_unnamed_delta, params["leak"]["afterUnnamedDelta"])
expect_equal(f"{key}/closed", closed_delta, params["leak"]["closedDelta"])

params_connection.close()
params_executed = counters["executed"]

# -------------------------------------------------------------------------------
# Command line parsing and rendering.
# -------------------------------------------------------------------------------
psql = load_case("psql.json")
for item in psql["parse"]:
    key = f"psql/{item['name']}"
    options = native.parse_psql_arguments(item["args"])
    record = {
        "host": options.host,
        "port": options.port,
        "user": options.user,
        "database": options.database,
        "sql": options.sql,
        "headers": options.headers,
        "separator": options.separator,
        "nullValue": options.null_value,
    }
    actual[key] = record
    for field in psql["defaults"]:
        expect_equal(f"{key}/{field}", record[field], item["expect"][field])
for item in psql["parseErrors"]:
    key = f"psql-error/{item['name']}"
    expect_error(key, lambda args=item["args"]: native.parse_psql_arguments(args), item["message"])
    actual[key] = item["message"]
for item in psql["format"]:
    key = f"format/{item['name']}"
    options = options_from(**{("null_value" if name == "nullValue" else name): value for name, value in item["options"].items()})
    lines = native.format_psql_results([statement_from(result) for result in item["results"]], options)
    actual[key] = lines
    expect_equal(f"{key}/lines", lines, item["expect"])
    expect_equal(f"{key}/line-count", len(lines), len(item["expect"]))

cli_executed = counters["executed"]

# -------------------------------------------------------------------------------
# Protocol framing and decoding.
# -------------------------------------------------------------------------------
protocol = load_case("protocol.json")
expect_equal("protocol/version", native.protocol_version(), protocol["version"])
expect_equal("protocol/max-message-bytes", native.max_message_bytes(), protocol["maxMessageBytes"])

for item in protocol["encodeStartup"]:
    key = f"protocol/startup/{item['name']}"
    packet = to_bytes(native.encode_startup_packet(item["user"], item["database"]))
    actual[key] = packet.hex()
    expect_equal(f"{key}/bytes", packet.hex(), item["expectHex"])
    expect_equal(f"{key}/length", len(packet), len(item["expectHex"]) // 2)
    expect_equal(f"{key}/version", int.from_bytes(packet[4:8], "big"), protocol["version"])
    expect_equal(f"{key}/terminator", packet[-1], 0)

for item in protocol["encodeQuery"]:
    key = f"protocol/query/{item['name']}"
    packet = to_bytes(native.encode_query_packet(item["sql"]))
    actual[key] = packet.hex()
    if item.get("structural"):
        expect_equal(f"{key}/tag", packet[0], 0x51)
        expect_equal(f"{key}/length", int.from_bytes(packet[1:5], "big"), len(packet) - 1)
        expect_equal(f"{key}/terminator", packet[-1], 0)
        expect_equal(f"{key}/sql", packet[5 : len(packet) - 1].decode("utf-8"), item["sql"])
    else:
        expect_equal(f"{key}/bytes", packet.hex(), item["expectHex"])
        expect_equal(f"{key}/length", len(packet), len(item["expectHex"]) // 2)
        expect_equal(f"{key}/tag", packet[0], 0x51)

for item in protocol["decodeError"]:
    key = f"protocol/error/{item['name']}"
    payload = bytes.fromhex(item["payloadHex"])
    if item.get("expectError"):
        expect_error(key, lambda payload=payload: native.decode_error_response(payload), item["expectError"])
        actual[key] = item["expectError"]
    else:
        code, message = native.decode_error_response(payload)
        decoded = {"code": code, "message": message}
        actual[key] = decoded
        expect_equal(f"{key}/code", decoded["code"], item["expect"]["code"])
        expect_equal(f"{key}/message", decoded["message"], item["expect"]["message"])

for item in protocol["decodeRowDescription"]:
    key = f"protocol/row/{item['name']}"
    payload = bytes.fromhex(item["payloadHex"])
    if item.get("expectError"):
        expect_error(key, lambda payload=payload: native.decode_row_description(payload), item["expectError"])
        actual[key] = item["expectError"]
    else:
        names = native.decode_row_description(payload)
        actual[key] = names
        expect_equal(f"{key}/names", names, item["expect"])

for item in protocol["decodeDataRow"]:
    key = f"protocol/data/{item['name']}"
    payload = bytes.fromhex(item["payloadHex"])
    if item.get("expectError"):
        expect_error(key, lambda payload=payload, columns=item["columns"]: native.decode_data_row(payload, columns), item["expectError"])
        actual[key] = item["expectError"]
    else:
        values = native.decode_data_row(payload, item["columns"])
        actual[key] = values
        expect_equal(f"{key}/values", values, item["expect"])

for item in protocol["decodeCommandTag"]:
    key = f"protocol/tag/{item['name']}"
    payload = bytes.fromhex(item["payloadHex"])
    if item.get("expectError"):
        expect_error(key, lambda payload=payload: native.decode_command_tag(payload), item["expectError"])
        actual[key] = item["expectError"]
    else:
        tag = native.decode_command_tag(payload)
        actual[key] = tag
        expect_equal(f"{key}/tag", tag, item["expect"])

protocol_executed = counters["executed"]

# -------------------------------------------------------------------------------
# `.yyds`/`.yykv` persistence, parsed from the documented byte layout.
# -------------------------------------------------------------------------------


def fnv1a(data):
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def parse_shard(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:5] != b"YYKV\x03":
        raise AssertionError("bad shard magic")
    checksum = struct.unpack_from("<Q", data, 5)[0]
    body = data[13:]
    if fnv1a(body) != checksum:
        raise AssertionError("bad shard checksum")
    offset = 0
    next_revision = struct.unpack_from("<Q", body, offset)[0]
    offset += 8
    count = struct.unpack_from("<I", body, offset)[0]
    offset += 4
    records = []
    for _ in range(count):
        namespace_length = struct.unpack_from("<I", body, offset)[0]
        offset += 4
        namespace = body[offset : offset + namespace_length].decode("utf-8")
        offset += namespace_length
        key_length = struct.unpack_from("<I", body, offset)[0]
        offset += 4
        key = body[offset : offset + key_length].decode("utf-8")
        offset += key_length
        revision = struct.unpack_from("<Q", body, offset)[0]
        offset += 8
        deadline = struct.unpack_from("<Q", body, offset)[0]
        offset += 8
        tag = body[offset]
        offset += 1
        value_length = struct.unpack_from("<I", body, offset)[0]
        offset += 4
        value = body[offset : offset + value_length].decode("utf-8")
        offset += value_length
        records.append(
            {"namespace": namespace, "key": key, "value": value, "revision": revision, "deadline": deadline, "tag": tag}
        )
    if offset != len(body):
        raise AssertionError("trailing shard bytes")
    return {"nextRevision": next_revision, "records": records}


def parse_catalog(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:5] != b"YYDS\x01":
        raise AssertionError("bad catalog magic")
    offset = 5
    version = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    schema_flag = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    schema = None
    if schema_flag == 1:
        schema_version = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        schema = {"version": schema_version, "document": data[offset : offset + length].decode("utf-8")}
        offset += length
    elif schema_flag != 0:
        raise AssertionError("bad schema flag")
    routing_flag = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    routing_epoch = None
    if routing_flag == 1:
        routing_epoch = struct.unpack_from("<Q", data, offset)[0]
        offset += 8
    elif routing_flag != 0:
        raise AssertionError("bad routing flag")
    count = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    shards = []
    for _ in range(count):
        length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        shards.append(data[offset : offset + length].decode("utf-8"))
        offset += length
    contract_flag = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    contract = None
    if contract_flag == 1:
        length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        contract = data[offset : offset + length].decode("utf-8")
        offset += length
    elif contract_flag != 0:
        raise AssertionError("bad contract flag")
    owner_count = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    owners = []
    for _ in range(owner_count):
        shard_length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        shard = data[offset : offset + shard_length].decode("utf-8")
        offset += shard_length
        node_length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        node = data[offset : offset + node_length].decode("utf-8")
        offset += node_length
        term = struct.unpack_from("<Q", data, offset)[0]
        offset += 8
        owners.append({"shard": shard, "node": node, "term": term})
    if offset != len(data):
        raise AssertionError("trailing catalog bytes")
    return {
        "magic": "5959445301",
        "version": version,
        "schema": schema,
        "routingEpoch": routing_epoch,
        "shards": shards,
        "contract": contract,
        "owners": owners,
    }


store_cases = load_case("store.json")

for item in store_cases["cases"]:
    directory = os.path.join(STORE_ROOT, item["name"])
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory, exist_ok=True)
    store = None
    record = {}
    actual[f"store/{item['name']}"] = record
    for op in item["ops"]:
        try:
            kind = op["op"]
            if kind in ("open", "reopen"):
                store = native.Store(directory)
            elif kind == "put":
                key = op["key"].encode("utf-8")
                value = op["value"].encode("utf-8")
                if op.get("expectError"):
                    expect_error(f"store/{item['name']}/put", lambda op=op, key=key, value=value: store.put(op["namespace"], key, value), op["expectError"])
                else:
                    store.put(op["namespace"], key, value)
            elif kind == "get":
                value = store.get(op["namespace"], op["key"].encode("utf-8"))
                resolved = None if value is None else read_text(value)
                record[f"get:{op['namespace']}:{op['key']}"] = resolved
                expect_equal(f"store/{item['name']}/get/{op['key']}", resolved, op["expect"])
            elif kind == "delete":
                deleted = store.delete(op["namespace"], op["key"].encode("utf-8"))
                expect_equal(f"store/{item['name']}/delete", deleted, op["expectDeleted"])
            elif kind == "keys":
                keys = [read_text(key) for key in store.keys(op["namespace"], op.get("prefix", "").encode("utf-8"))]
                expect_equal(f"store/{item['name']}/keys/{op.get('prefix', '')}", keys, op["expectKeys"])
            elif kind == "scan":
                pairs = [
                    [read_text(row.key), read_text(row.value)]
                    for row in store.scan(op["namespace"], op.get("prefix", "").encode("utf-8"))
                ]
                expect_equal(f"store/{item['name']}/scan/{op.get('prefix', '')}", pairs, op["expectPairs"])
            elif kind == "namespaces":
                namespaces = store.namespaces()
                expect_equal(f"store/{item['name']}/namespaces", namespaces, op["expectNamespaces"])
            elif kind == "len":
                length = store.len(op["namespace"])
                expect_equal(f"store/{item['name']}/len", length, op["expectLen"])
            elif kind == "flush":
                removed = store.flush(op["namespace"])
                expect_equal(f"store/{item['name']}/flush", removed, op["expectRemoved"])
            elif kind == "expectFiles":
                expect_equal(
                    f"store/{item['name']}/catalog-name",
                    os.path.basename(store.catalog_path()),
                    op.get("catalogFile", store_cases["catalogFile"]),
                )
                expect_equal(
                    f"store/{item['name']}/shard-name",
                    os.path.basename(store.shard_path()),
                    op.get("shardFile", store_cases["shardFile"]),
                )
                expect_equal(f"store/{item['name']}/catalog-exists", os.path.exists(store.catalog_path()), True)
                expect_equal(f"store/{item['name']}/shard-exists", os.path.exists(store.shard_path()), True)
            elif kind == "verifyCatalog":
                parsed = parse_catalog(store.catalog_path())
                record["verifyCatalog"] = parsed
                expect_equal(f"store/{item['name']}/catalog", parsed, op["expect"])
            elif kind == "verifyShard":
                parsed = parse_shard(store.shard_path())
                record["verifyShard"] = parsed
                projected = {
                    "nextRevision": parsed["nextRevision"],
                    "records": [
                        {"namespace": row["namespace"], "key": row["key"], "value": row["value"], "revision": row["revision"]}
                        for row in parsed["records"]
                    ],
                }
                expect_equal(f"store/{item['name']}/shard/records", projected, {"nextRevision": op["nextRevision"], "records": op["records"]})
            elif kind == "writeSibling":
                with open(os.path.join(directory, op["name"]), "wb") as handle:
                    handle.write(bytes.fromhex(op["hex"]))
            elif kind in ("writeShard", "writeCatalog"):
                target = store.shard_path() if kind == "writeShard" else store.catalog_path()
                with open(target, "wb") as handle:
                    handle.write(bytes.fromhex(op["hex"]))
            elif kind == "removeShard":
                os.remove(store.shard_path())
            elif kind == "removeCatalog":
                os.remove(store.catalog_path())
            elif kind == "openExpectError":
                expect_error(f"store/{item['name']}/open", lambda: native.Store(directory), op["expectError"])
                record["openError"] = op["expectError"]
            else:
                raise AssertionError(f"unknown store op {kind}")
        except Exception as error:  # noqa: BLE001
            counters["failed"] += 1
            counters["executed"] += 1
            failures.append(f"store/{item['name']}/{op['op']}: {error}")

# Store scale ladder: 1000 rows, reopen, scan.
directory = os.path.join(STORE_ROOT, "scale")
shutil.rmtree(directory, ignore_errors=True)
os.makedirs(directory, exist_ok=True)
started = time.monotonic()
store = native.Store(directory)
for index in range(1000):
    store.put("public.scale", f"k{index}".encode("utf-8"), f"v{index}".encode("utf-8"))
inserted = store.len("public.scale")
expect_equal("store-stress/inserted", inserted, 1000)
pairs = store.scan("public.scale", b"k1")
expect_equal("store-stress/prefix-count", len(pairs), 111)
expect_equal("store-stress/last-key", read_text(pairs[-1].key), "k199")
store = native.Store(directory)
expect_equal("store-stress/reopen-len", store.len("public.scale"), 1000)
elapsed = int((time.monotonic() - started) * 1000)
print(f"METRIC store-scale rows=1000 bytes={os.path.getsize(store.shard_path())} ms={elapsed}")


def budget():
    if elapsed > 15_000:
        raise AssertionError(f"1000 rows took {elapsed}ms")


check("store-stress/budget", budget)
actual["store-stress"] = {"inserted": inserted, "prefixCount": len(pairs), "reopened": 1000}

store_executed = counters["executed"]

# -------------------------------------------------------------------------------
# Stress ladder through the client.
# -------------------------------------------------------------------------------
stress = native.connect(CONFIG["host"], CONFIG["port"], CONFIG["user"], CONFIG["database"])
for item in load_case("stress.json"):
    key = f"stress/{item['name']}"
    started = time.monotonic()
    try:
        for statement in item.get("setup", []):
            stress.execute(statement)
        results = normalize(stress.execute(item["sql"]))
        elapsed = int((time.monotonic() - started) * 1000)
        actual[key] = {
            "resultCount": len(results),
            "rowCounts": [len(result["rows"]) for result in results],
            "values": [result["rows"][0] if result["rows"] else [] for result in results],
        }
        final = results[-1]
        if "expectResults" in item:
            expect_equal(f"{key}/result-count", len(results), item["expectResults"])
        if "expectRows" in item:
            expect_equal(f"{key}/row-count", len(final["rows"]), item["expectRows"])
        if "columns" in item:
            expect_equal(f"{key}/columns", final["columns"], item["columns"])
        if "first" in item:
            expect_equal(f"{key}/first", final["rows"][0], [item["first"]])
        if "last" in item:
            expect_equal(f"{key}/last", final["rows"][-1], [item["last"]])
        if "valueLength" in item:
            expect_equal(f"{key}/value-length", len(final["rows"][0][0]), item["valueLength"])
        if "expectedValues" in item:
            expect_equal(f"{key}/values", [result["rows"][0] if result["rows"] else [] for result in results], [[value] for value in item["expectedValues"]])


        def budget():
            if elapsed > item["budgetMs"]:
                raise AssertionError(f"took {elapsed}ms over {item['budgetMs']}ms")


        check(f"{key}/budget", budget)
        print(f"METRIC {item['name']} rows={sum(len(result['rows']) for result in results)} ms={elapsed}")
        for statement in item.get("teardown", []):
            stress.execute(statement)
    except Exception as error:  # noqa: BLE001
        actual[key] = {"error": str(error)}
        check(f"{key}/run", lambda error=error: (_ for _ in ()).throw(AssertionError(str(error))))
stress.close()

# -------------------------------------------------------------------------------
# Result.
# -------------------------------------------------------------------------------
summary = {
    **counters,
    "sections": {
        "sql": sql_executed,
        "errors": errors_executed - sql_executed,
        "params": params_executed - errors_executed,
        "cli": cli_executed - params_executed,
        "protocol": protocol_executed - cli_executed,
        "store": store_executed - protocol_executed,
        "stress": counters["executed"] - store_executed,
    },
    "cases": actual,
    "failures": failures,
}
with open(RESULT_FILE, "w", encoding="utf-8") as handle:
    json.dump(summary, handle, ensure_ascii=False)
print(f"RESULT executed={counters['executed']} skipped={counters['skipped']} failed={counters['failed']}")
if failures:
    print("\n".join(failures[:40]))
sys.exit(0 if counters["failed"] == 0 else 1)
