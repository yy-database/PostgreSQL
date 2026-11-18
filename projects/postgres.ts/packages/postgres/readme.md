`@yydb/postgres` is the TypeScript surface for PostgreSQL protocol-v3 clients,
plus a protocol-v3 server that persists to `.yyds`/`.yykv`.

The client side contains no SQL engine. `query()` sends the statement text to
the server at `host`/`port` and decodes the reply that server produces; in the
client acceptance harness that server is PGlite.

The server side owns no SQL engine either. `startPostgresServer({ dataDir })`
opens the native `LocalEngine`, which is the `postgres` facade: it locks
`dataDir` with `postmaster.pid`, parses, plans and executes statements, and
serves protocol-v3 clients. This package only validates options and maps the
resulting failures into the family envelope.

Server authentication and remote binds are not implemented natively yet.
`startPostgresServer` rejects them with a `native_capability_missing` failure
carrying `postgres.server.authentication` or `postgres.server.remote_bind`
instead of falling back to a local verifier.

Row data is durable in `.yykv`; the schema is not. The facade keeps DDL in an
in-memory registry, so a reopened data directory starts with an empty catalog.
Replay your DDL after `open()` and the rows written by the previous run become
visible again; `PostgreSQL#execute()` runs parameterless statements as simple
queries, which is the path `CREATE`/`ALTER`/`BEGIN` take.

The gateway's SQL surface is the DDL/DML/metadata subset it implements: no
`CREATE DATABASE`/`CREATE ROLE`/`GRANT`, no `COPY ... FROM STDIN`, cursors,
SQL-level `PREPARE`, `LISTEN`/`NOTIFY`, `EXPLAIN` plans, `GENERATED` columns,
`CREATE TEMP` or `ALTER TABLE ... ADD CONSTRAINT`, and the `::` cast operator is
refused in favour of `CAST(x AS type)`.

The package owns no wire code of its own. `loadNative()` resolves the platform
binding, `query()` opens and closes one connection around a single statement,
`columnNames()` / `cell()` / `firstValue()` read results, and the `psql` command
line composes those primitives into console output.

Protocol framing and decoding are exposed one call at a time:
`encodeStartupPacket`, `encodeQueryPacket`, `decodeErrorResponse`,
`decodeRowDescription`, `decodeDataRow`, `decodeCommandTag`, plus
`protocolVersion` and `maxMessageBytes`. `parsePsqlArguments` and
`formatPsqlResults` are the command-line primitives. `.yyds`/`.yykv` state is
opened through `new (loadNative()).Store(dataDir)` with `put`, `get`, `delete`,
`keys`, `scan`, `namespaces`, `len`, `flush`, `shardPath` and `catalogPath`.

```js
import { query, cell } from '@yydb/postgres';

const [result] = query({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres', sql: 'SELECT 1 AS one' });
console.log(result.tag, cell(result, 0, 0));
```

```
psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -t -c "SELECT 1"
```
