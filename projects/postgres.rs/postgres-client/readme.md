`postgres-client` holds the small protocol-v3 primitives shared by the bindings.

`Connection::open` performs the startup handshake, `Connection::execute` runs one
simple-query statement, `QueryResult` carries columns, rows and the command tag,
and `PostgresError` keeps the server error code. The crate owns no global state
and starts no server, so callers compose command lines and emulation themselves.
