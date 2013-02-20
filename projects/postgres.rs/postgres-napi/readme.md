Node-API binding for the PostgreSQL protocol-v3 primitives.

The crate exports `connect`, `Connection::execute`, `Connection::close`, the
result and row shapes and the package `version`. It owns no global state, starts
nothing, and leaves command lines and server emulation to the TypeScript layer.
