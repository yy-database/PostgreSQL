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

`startPostgresServer` accepts `auth` as `'trust'` or a password method
(`'password'`, `'md5'`, `'scram-sha-256'`) with a password and an optional role.
Remote binds stay unimplemented: a non-loopback `host` fails with
`native_capability_missing` carrying `postgres.server.remote_bind`.

Row data is durable in `.yykv` and the schema is durable in `schema.json`. The
facade keeps the registry on disk, so a reopened data directory starts with the
tables it had. `PostgreSQL#execute()` runs parameterless statements as simple
queries, which is the path `CREATE`/`ALTER`/`BEGIN` take.

The gateway implements prepared statements, cursors, `EXPLAIN`, `COPY ... FROM
STDIN`, `LISTEN`/`NOTIFY`, `GENERATED ... AS IDENTITY`, `GENERATED ... AS
(expression) STORED`, `ALTER TABLE ... ADD CONSTRAINT`, `CREATE TEMP TABLE`,
`CREATE DATABASE`/`CREATE ROLE`/`GRANT`/`REVOKE`, `statement_timeout`, `E'...'`
literals and the `::` cast operator.

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
