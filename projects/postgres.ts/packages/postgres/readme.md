`@yydb/postgres` is the TypeScript surface for PostgreSQL protocol-v3 clients,
plus a protocol-v3 server that persists to `.yyds`/`.yykv`.

The client side contains no SQL engine. `query()` sends the statement text to
the server at `host`/`port` and decodes the reply that server produces; in the
client acceptance harness that server is PGlite.

The server side does own a small engine, under `src/server/sql/`: a parser, a
catalog projection, an executor and a storage adapter. `startPostgresServer({
dataDir })` locks `dataDir` with `postmaster.pid`, opens one native
`ServerStore` and answers DDL/DML plus the catalog SQL that `psql` uses for
`\dt` and `\d`. One message runs its statements against one `Database` and then
commits once, so a multi-statement simple query is all-or-nothing.

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
