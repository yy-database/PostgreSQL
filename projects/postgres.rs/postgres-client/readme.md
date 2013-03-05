`postgres-client` holds the small protocol-v3 primitives shared by the bindings.
It contains no SQL engine: SQL text is forwarded to the server, which produces
the results, tags and errors. `Store` is an independent `.yyds`/`.yykv` key/value
primitive and is not called by `Connection`.

`Connection::open` performs the startup handshake, `Connection::execute` runs one
simple-query statement, `QueryResult` carries columns, rows and the command tag,
and `PostgresError` keeps the server error code. The crate owns no global state
and starts no server, so callers compose command lines and emulation themselves.
