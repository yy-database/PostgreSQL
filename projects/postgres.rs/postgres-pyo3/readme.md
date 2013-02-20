PyO3 binding for the PostgreSQL protocol-v3 primitives.

The module exports `connect`, `Connection.execute`, `Connection.close`, the
result shapes, the `PostgresError` exception and the package `version`. It owns
no global state, starts nothing, and leaves command lines to the Python layer.
