Python surface of the PostgreSQL product.

`import postgres` re-exports the primitives of the `postgres-pyo3` wheel:
`connect`, `Connection.execute`, `Connection.close`, `StatementResult`,
`ColumnInfo`, `PostgresError` and `version`.

Wire framing and decoding are one call each: `encode_startup_packet`,
`encode_query_packet`, `decode_error_response`, `decode_row_description`,
`decode_data_row`, `decode_command_tag`, plus `protocol_version` and
`max_message_bytes`.

Command lines compose `parse_psql_arguments` and `format_psql_results`. Durable
state lives in `.yyds`/`.yykv` files through `Store`: `put`, `get`, `delete`,
`keys`, `scan`, `namespaces`, `len`, `flush`, `shard_path` and `catalog_path`.
