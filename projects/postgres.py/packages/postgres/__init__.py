"""Python surface of the PostgreSQL product.

The native primitives live in the `postgres-pyo3` wheel. This module re-exports
them so callers import one name and stay independent of the binding module.
"""

from postgres_pyo3 import (  # noqa: F401
    ColumnInfo,
    Connection,
    PostgresError,
    PreparedStatement,
    PsqlOptions,
    StatementResult,
    Store,
    StoreRow,
    connect,
    decode_command_tag,
    decode_data_row,
    decode_error_response,
    decode_parameter_description,
    decode_row_description,
    encode_bind_message,
    encode_bytea,
    encode_close_message,
    encode_describe_message,
    encode_execute_message,
    encode_parse_message,
    encode_query_packet,
    encode_startup_packet,
    encode_sync_message,
    format_psql_results,
    max_message_bytes,
    parameter_type_oid,
    parse_psql_arguments,
    protocol_version,
    version,
)
