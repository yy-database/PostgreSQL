# PostgreSQL

Protocol-v3 client primitives, a `psql`-compatible command line, and an
independent `.yyds`/`.yykv` key-value store, shared by a Rust crate, a Node-API
binding and a PyO3 binding, with TypeScript and Python surfaces on top.

## What this repository implements

- **Wire layer.** Startup, simple-query and extended-protocol framing plus
  response decoding in
  `projects/postgres.rs/postgres-client/src/protocol.rs`.
- **Socket client.** `Connection::open` connects to a server and
  `Connection::execute` sends one simple-query packet and decodes the replies
  (`projects/postgres.rs/postgres-client/src/client.rs`).
- **Bindings and surfaces.** `postgres-napi`, `postgres-pyo3`, and the
  TypeScript and Python packages composed on top of them.
- **`psql` surface.** Argument parsing and result rendering.
- **Key/value store.** `Store` reads and writes the shared `.yyds` catalog and
  `.yykv` shard contract from `yyds-formats`.

## What this repository does NOT implement

There is no SQL parser, planner, executor or storage engine here.
`Connection.execute(sql)` serialises the statement text and reads the reply.
Types, casts, operators, command tags, error codes, transactions, `RETURNING`
and catalog tables are all decided by the server on the other end of the socket.

The acceptance harness runs **PGlite 0.5.15** as that server:

- `projects/postgres.ts/packages/postgres-harness/server.mjs` imports PGlite and
  `PGLiteSocketServer` (lines 2-3) and constructs `new PGlite()` **without a data
  directory** (line 22), i.e. an in-memory database, behind a socket server on
  line 24.
- `cli.mjs` starts it (line 72) and then runs the Rust, Node and Python stages
  against `127.0.0.1:<port>` (`cli.mjs` lines 84-87).

Consequently the SQL cases in
`projects/postgres.ts/packages/postgres-harness/cases/` measure **PGlite's
behaviour observed through this repository's wire layer**, not a SQL engine
implemented here:

- `params.json` was generated from PGlite by
  `projects/postgres.ts/packages/postgres-harness/scripts/params-corpus.mjs`
  (PGlite import at line 16, instance at line 179).
- `sql.json` (66 cases) and `errors.json` (13 cases) replay frozen expectations
  that reproduce against PGlite through an independent client (`pg`): all 13
  error SQLSTATEs match; 62/66 SQL cases are byte-identical and the remaining 4
  differ only in DDL command tags, which `pg` truncates to the verb
  (`CREATE` vs `CREATE TABLE`) while our client decodes the full
  `CommandComplete` payload.

SQL data never lands in `.yyds`/`.yykv`. PGlite keeps it in its in-memory
database, or in its own PostgreSQL data directory when one is configured
(`base/`, `global/`, `pg_wal/`, `PG_VERSION`, `postgresql.conf`). `Store` is an
unrelated KV primitive: `local-0.yyds` and `local-0.yykv` are written only when
a caller uses `Store` directly. `postgres-client` neither imports nor calls
`Store`, so **SQL and the `.yyds`/`.yykv` store are not wired together**.

## SQL compatibility gaps

[`docs/sql-compatibility-gaps.md`](./docs/sql-compatibility-gaps.md) is the
current gap list. It is regenerated from a seeded corpus by

```shell
node projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed 20261106
```

118 statements (ddl 20, dml 22, expr 34, agg 22, cast 20) run serially on the
`sqldiff` staging schema, never on `public`. Every expected value comes from
PGlite 0.5.15 through `execProtocolRaw` and an independent protocol decoder, so
this repository is never its own reference. The same seed rewrites
byte-identical report files; `--only <case>` reruns one statement.

The client-surface gaps found by that run are fixed: `Connection::execute_report`
returns `{ results, error, notices }`, so `NoticeResponse` reaches the caller,
`ErrorResponse` keeps every ordered field (`S`, `V`, `C`, `M`, `D`, `H`, `P`,
`F`, `L`, `R` and the object-name fields), and a failing later statement no
longer discards results already completed in the same batch. `execute` keeps its
throw-on-error signature and leaves notices buffered for `take_notices`. The
three fixed rows carry the PGlite `execProtocolRaw` payload bytes in
`cases/sql-diff.json`, and both acceptance suites re-serialize the decoded
fields back to those bytes.

## Testing

```shell
pnpm test
```

The harness starts PGlite, builds the native binding, packs and installs the
TypeScript packages into a throwaway application, builds a wheel, and replays
one shared corpus on both language surfaces. Floors: node 1066, python 1066,
rust 35; TS and Python results must match case by case; `skipped` must stay 0.

## Wiring SQL onto this repository's storage (not started)

Two routes, neither implemented in this round:

1. **Reuse the `database.rs` yydb/yyds gateway.** Run a protocol-v3 server in
   front of the gateway and persist relations through `.yyds`/`.yykv`. Cost: the
   gateway is a KV contract today, so relational semantics (catalog, visibility,
   transaction boundaries, crash recovery) still have to be supplied; storage
   format unchanged.
2. **Build a minimal SQL engine here.** Parse, plan and execute into `.yykv`,
   with catalog metadata in `.yyds`. Cost: type system, expression evaluation,
   joins/aggregates, error catalogue and a durability story; higher up-front
   cost, no external service.

Either route must first change write granularity: `Store::put` rewrites the whole
shard on every mutation (`store.rs` lines 317-327), which is not viable for
per-statement SQL writes.

## Commit messages

| Emoji  | Meaning                      |
|--------|------------------------------|
| 🎂     | Project initialized!         |
| 🎉     | Release new version          |
| 🧪🔮   | Experimental code            |
| 🔧🐛🐞 | Bug fix                      |
| 🔒     | Security fix                 |
| 🐣🐤🐥 | Add feature                  |
| 📝🎀   | Documentation                |
| 🚀     | Performance improve!         |
| 🚧     | Work in progress             |
| 🚨     | Test coverage improve!       |
| 🚥     | CI improve!                  |
| 🔥🧨   | Remove code or files         |
| 🧹     | Code refactor                |
| 📈     | Add analytics or branch code |
| 🤖     | Automation fix               |
| 📦     | Update dependencies          |
