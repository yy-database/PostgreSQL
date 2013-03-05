`@yydb/postgres` is the TypeScript surface for PostgreSQL protocol-v3 clients.

This package contains no SQL engine. `query()` sends the statement text to the
server at `host`/`port` and decodes the reply that server produces; in the test
harness that server is PGlite. `.yyds`/`.yykv` (`Store`) is a separate key/value
primitive and is not used by the SQL path.

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
