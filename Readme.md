# PostgreSQL

Protocol-v3 client primitives, a protocol-v3 server, a `psql`-compatible
command line, and an independent `.yyds`/`.yykv` key-value store, shared by a
Rust crate, a Node-API binding and a PyO3 binding, with TypeScript and Python
surfaces on top.

## What this repository implements

- **Wire layer.** Startup, simple-query and extended-protocol framing plus
  response decoding in
  `projects/postgres.rs/postgres-client/src/protocol.rs`.
- **Socket client.** `Connection::open` connects to a server and
  `Connection::execute` sends one simple-query packet and decodes the replies
  (`projects/postgres.rs/postgres-client/src/client.rs`).
- **Wire server.** `startPostgresServer` in
  `projects/postgres.ts/packages/postgres/src/server/` listens on TCP and speaks
  protocol v3 as the backend: startup, trust or cleartext-password
  authentication, `SET`, `SHOW`, DDL/DML, the catalog subset `psql` needs for
  `\dt` and `\d`, and `ErrorResponse` plus `ReadyForQuery` on failure. Rows live
  in `.yyds`/`.yykv` through the native `ServerStore` primitive; the SQL parser,
  catalog projection and executor are TypeScript under `server/sql/`, so the
  Rust side keeps no server main loop. `postgres-server --port 5432 --data-dir DIR`
  runs it.
- **Bindings and surfaces.** `postgres-napi`, `postgres-pyo3`, and the
  TypeScript and Python packages composed on top of them.
- **`psql` surface.** Argument parsing and result rendering.
- **Key/value store.** `Store` is a thin adapter over
  `database-storage`'s `FileShard` and reads/writes the shared `.yyds` catalog
  and `.yykv` shard contract from `database-formats`. It keeps the PostgreSQL
  catalog file, shard-id selection, namespace validation and the user-facing
  error wording; the snapshot write path is the shared one.

## What this repository does NOT implement

There is no planner and no general-purpose server engine. Batch 2 implements a
parser, a catalog projection and an executor for the batch-2 surface only:
`CREATE TABLE`/`DROP TABLE`, `INSERT`/`UPDATE`/`DELETE` with `RETURNING`, and the
catalog SQL `psql` sends for `\dt` and `\d`. Types are `int2`/`int4`/`int8`/
`float4`/`float8`/`bool`/`text`/`varchar(n)`/`char(n)`/`date`/`timestamp`/
`timestamptz`/`uuid`; constraints are `NOT NULL`, literal `DEFAULT`,
`PRIMARY KEY` and `UNIQUE`.

Still missing: `numeric`, transactions, cursors, `ALTER`, views and indexes
outside `PRIMARY KEY`/`UNIQUE`, and user-table `JOIN`/aggregate acceptance (they
work incidentally where the catalog queries exercise them but are not gated).
`Connection.execute(sql)` still serialises the statement text and reads the
reply; the acceptance suites for the client surfaces keep talking to PGlite as
their independent reference.

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

The client-surface suites keep PGlite's SQL data in its own in-memory database;
that is the oracle, not this repository's server. Inside `postgres-server` the
SQL path does land in `.yyds`/`.yykv`: the catalog document lives under
`pg_catalog/catalog` and every user relation under `pg_data.<relOid>`, written
through `ServerStore.commitChanges`. The standalone `Store` primitive is
unchanged and remains unrelated to the client suites.

## Wire server (batch 2)

`postgres-server --port 5432 --data-dir DIR` (or `startPostgresServer`) listens
on TCP and speaks protocol v3 as the backend. It answers startup,
`AuthenticationOk` for trust and `AuthenticationCleartextPassword` for
`--password`, `SET`, `SHOW`, `SELECT`, DDL/DML, and closes on `Terminate`. Every
statement failure is `ErrorResponse` followed by `ReadyForQuery`, so the session
survives.

Storage layout under `--data-dir`:

- `postmaster.pid` is the lock. A second server started on the same directory
  fails with `lock file "..." already exists: another server owns this data
  directory` and never starts listening. A hard kill leaves the file behind,
  exactly like PostgreSQL, so the operator removes it once the old process is
  gone.
- `local-0.yyds` holds the catalog document. `local-0.yykv` holds shards; the
  catalog is `pg_catalog/catalog`, and each user relation is `pg_data.<relOid>`
  with zero-padded row ids as keys.
- One statement message opens one `Database`, runs its statements, then calls
  `ServerStore.commitChanges` once. A multi-statement simple query therefore
  behaves like one implicit transaction: either every statement becomes durable
  or the whole batch is discarded. `RETURNING` rows are emitted only after the
  commit succeeded.
- `pg_catalog.*` is a pure projection of that single catalog document; there is
  no second copy of table metadata.

Two accepted limitations, recorded so the next change does not need a fresh
investigation:

1. **Whole-shard re-encode.** `FileShard::commit_changes` re-encodes the entire
   shard on every commit. Splitting one shard per table is the planned fix.
2. **One handle.** One `ServerStore` handle per process owns one data directory.
   Concurrent writers are serialised by the native mutex instead of having a
   shared page cache.

Evidence from real `psql` 16.9 (`LC_MESSAGES=C`) against this server, compared
byte for byte with a real PostgreSQL 16.9 instance holding the same schema
(`CREATE TABLE t (id int PRIMARY KEY, name text DEFAULT 'x', code varchar(20))`):

```text
$ psql ... -c "\dt"
 List of relations
 Schema | Name | Type  |  Owner
--------+------+-------+----------
 public | t    | table | postgres
(1 row)

$ psql ... -c "\d t"
                         Table "public.t"
 Column |         Type          | Collation | Nullable |  Default  
--------+-----------------------+-----------+----------+-----------
 id     | integer               |           | not null | 
 name   | text                  |           |          | 'x'::text
 code   | character varying(20) |           |          | 
Indexes:
    "t_pkey" PRIMARY KEY, btree (id)
```

`Buffer.compare` on the two captured outputs returned `0` for `\dt`, `\d t`,
`\d types` (13 types plus literal defaults) and `\d u` (`PRIMARY KEY` +
`UNIQUE`). The 10 catalog statements `psql` emits are frozen in
`packages/postgres-harness/fixtures/catalog-queries.json`; the `server` stage
asserts each one parses, executes and returns the real row count, and compares
the two `psql` transcripts with the captured real ones.

SQLSTATE evidence through the `pg` driver: `22P02` invalid input syntax,
`42703` unknown column, `42P01` unknown relation, `42P07` duplicate relation,
`23502` not-null, `23505` duplicate key with `Key (id)=(2) already exists.`

`numeric`, transactions, cursors and `ALTER` remain `0A000` + `DETAIL`.

Build cost of bringing `database-storage` (and `vos`) into the native graph,
measured once on this machine with clean release target directories:

```text
cargo build -p postgres-napi --release     43.4 s, 111 crates compiled
cargo build -p database-storage --release  38.2 s,  86 crates compiled
```

So the storage dependency accounts for 86 of the 111 crates and about 38 of the
43 seconds; the napi crate plus everything it had before is roughly the
remaining 5 seconds and 25 crates.

## SQL compatibility gaps

[`projects/postgres.ts/packages/postgres-harness/gaps`](projects/postgres.ts/packages/postgres-harness/gaps/sql-compatibility-gaps.md) is the
current gap list. It is regenerated from a seeded corpus by

```shell
node projects/postgres.ts/packages/postgres-harness/scripts/sql-diff.mjs --seed 20261106
```

295 statements (ddl 20, dml 22, expr 34, agg 22, cast 20, transaction 20, cursor 14,
cast-matrix 24, constraint 20, join 20, window 24, agg-boundary 17, json 22,
extended 16) run serially on the `sqldiff` staging schema, never on `public`. Every
expected value comes from PGlite 0.5.15 through `execProtocolRaw` and an independent
protocol decoder, so this repository is never its own reference. The `extended`
cluster covers parameterized execution, prepared-statement reuse and portal rebinding,
and is answered by the `pg` driver over a real Parse/Bind/Execute/Sync session against
a separate PGlite socket, because `execProtocolRaw` accepts one simple-query message
per call. The same seed rewrites byte-identical report files; `--only <case>` reruns
one statement and does not rewrite the checked-in report.

The `differential corpus` CI job gates the same run:

```shell
pnpm corpus -- --seed 20261106 --count 295 --check
```

`corpus/sql-differential-baseline.json` pins the seed, the count, the corpus digest
`425917a64504d0650f710bcb69fcfd40c2a9aa30fbc4b3e84799f7dc3a5d31f3`
and the only allowed differences, each classified as a structured
rejection, a not-implemented feature, an out-of-scope wire feature, an oracle
disagreement or an oracle limitation. The gate verifies the identity before any
engine starts, rejects an unlisted difference with the statement, this repository's
output and the raw PGlite reply, rejects a changed signal, and rejects a baseline
entry that no longer differs. `pnpm corpus -- --seed 20261106 --count 295
--update-baseline` regenerates the baseline and drops fixed entries.

The one recorded difference is an oracle limitation: `extended/params-missing`
binds zero values to a one-parameter statement. `pg` routes an empty `values`
array to a simple query, so the oracle never sends `Bind` and PGlite answers
`42P02 there is no parameter $1`. Real PostgreSQL rejects that `Bind` with
`08P01 bind message supplies 0 parameters`, which is the reply this repository
receives, so the case is not an engine disagreement.

The client-surface gaps found by that run are fixed: `Connection::execute_report`
returns `{ results, error, notices }`, so `NoticeResponse` reaches the caller,
`ErrorResponse` keeps every ordered field (`S`, `V`, `C`, `M`, `D`, `H`, `P`,
`F`, `L`, `R` and the object-name fields), and a failing later statement no
longer discards results already completed in the same batch. `execute` keeps its
throw-on-error signature and leaves notices buffered for `take_notices`. The
three fixed rows carry the PGlite `execProtocolRaw` payload bytes in
`cases/sql-diff.json`, and both acceptance suites re-serialize the decoded
fields back to those bytes.

## Connection and protocol robustness

The wire layer is measured on its own axis, separate from SQL semantics.
`Connection` now keeps the `BackendKeyData` (`K`) the server sends during
startup instead of discarding it.

**CancelRequest.** `Connection::cancel()` opens a second socket, writes the
exact 16-byte startup-position packet (length `16`, code `80877102`, the `pid`
and `secret key` verbatim), shuts it down and returns. The main socket is not
touched and stays usable. `protocol::cancel_request_packet` is checked byte
for byte (`0000001004d2162e...`) in `cargo test` and in both acceptance suites
through `encodeCancelRequest`, including a zero and a negative key pair.

PGlite is not an oracle for cancellation: its socket server consumes the
packet and closes silently because there is no backend process to signal.
`statement_timeout` is accepted and reported by `SHOW`, but not enforced: a
query that ran 5.6 s with `statement_timeout = '100ms'` still completed.
Therefore `57014 query canceled` cannot be produced by the only engine
available here; termination semantics are recorded as an **oracle limitation**
and are not asserted. What is asserted is what the client owns: the packet
bytes, and that a cancel followed by a normal statement on the same session
still returns `SELECT 1`.

**Connection interruption.** A read that ends after a partial result, a frame
that declares more bytes than arrive, and a peer that closes before
`ReadyForQuery` all raise a `PostgresError::Io`. After any transport or
decoding failure the connection is marked unusable, so a later call returns
`connection is unusable after ...` instead of reading the abandoned reply as
if it belonged to the next statement. A server error (`08P01` for a bad `Bind`)
is *not* a desync: the stream is drained to `ReadyForQuery` and the session
stays usable. `postgres-client/tests/robustness.rs` drives every path above
with fixed byte scripts against a loopback listener.

**Timeout and idle.** The socket timeout is a per-read limit, not a session
deadline: a six-second idle gap leaves the session usable and the next
statement returns normally. A statement slower than that limit fails the call
and, through the poison rule above, cannot leave half a result behind. This
repository has no `statement_timeout` GUC of its own; the boundary it owns is
the 5 s socket read limit.

**COPY subprotocol.** `Connection::copy_in(sql, chunks)` writes the chunks as
`CopyData` only after the server answered `CopyInResponse`, then sends
`CopyDone` and drains `CommandComplete`/`ErrorResponse` through
`ReadyForQuery`. The returned report keeps the tag and the server error instead
of throwing, so a copy that failed on a later row still reports what the server
accepted and leaves the session usable; a transport loss poisons the socket.
`Connection::copy_out(sql)` concatenates every `CopyData` payload in wire order,
keeps the prefix on error and reports the `COPY n` tag. `encodeCopyData` /
`encodeCopyDone` / `encodeCopyFail` / `decodeCopyResponse` expose the frames
byte for byte in both bindings.

`COPY ... TO STDOUT` is compared against PGlite for text and CSV, with `HEADER`
and `DELIMITER` options, covering a NULL, a delimiter inside a value, an
embedded quote, a doubled backslash and a 504-row output. `COPY ... FROM STDIN`
cannot be exercised against PGlite: its socket server answers `CopyInResponse`
(`format 0`, two columns) and then fails with `08006 unexpected EOF on client
connection with an open transaction` (`copyfromparse.c`, `CopyGetData`),
followed by `08P01 terminating connection because protocol synchronization was
lost` (`postgres.c`, `PostgresMainLongJmp`), which tears the whole server down.
The harness records those bytes as an **oracle limitation** from a throwaway
server before the suites start, and both suites assert them. The direction
itself is verified against fixed byte scripts in
`postgres-client/tests/robustness.rs`: success, a mid-copy `22P02`, a rejection
before `CopyInResponse` that must not stream any data, 500 chunks, and a peer
that closes mid-stream.

**Extended query boundary.** `bind_packet_with_formats` carries text and binary
parameters plus per-column result formats. It refuses a parameter-format count
that is not `0`, `1` or the parameter count, and any format code other than
`0`/`1`; more than 65535 parameters are refused with `at most 65535 parameters
can be bound`. `execute_packet` accepts a row limit, so a portal drains in
batches: `PortalSuspended` (`s`) is reported as `suspended` with an empty
command tag, and the next `Execute` on the same portal continues instead of
restarting. Four fixed Bind vectors (empty, text with a NULL, binary `int4`,
mixed formats) are asserted byte for byte in both bindings.

Binary result values are decoded per OID for `int2`, `int4`, `int8`, `bool`,
`text`, `bytea`, `numeric`, `date`, `time`, `timestamp`, `uuid`, `json`,
`jsonb`, `varchar` and `bpchar`, and the suites require every one of the 15
types to decode to exactly the same text PGlite produces for the text format.
`float4`, `float8` and `timestamptz` stay `unsupported:
binary-result-type-<oid>` because PostgreSQL float output and timestamptz
rendering depend on the session, not on the wire bytes. A decode failure is
drained through `ReadyForQuery`, so the statement fails while the session
survives. An unknown parameter type OID surfaces as `XX000 cache lookup failed
for type 999999`.

Named portals live only inside the transaction that bound them: binding a
portal and letting `Sync` end the implicit transaction destroys it, so a later
execute reports `34000 portal "..." does not exist`. That loss is asserted
rather than hidden. Inside `BEGIN`, a ten-row portal drained with row limits
`4/4/4` returns `4`, `4` and `2` rows with the tags `""`, `""` and `SELECT 2`, and
`close_portal` removes it for good (`34000` afterwards). Prepared statements
are independent of portals: the same statement executes repeatedly with
different parameters and a NULL, two names can hold the same SQL text, closing
one leaves the other usable, `DEALLOCATE <name>` removes the server-side
statement (`26000` on reuse), and a failed bind (`22P02`) leaves both the
statement and the connection usable.

## Testing

```shell
pnpm test
```

The harness starts PGlite, builds the native binding, packs and installs the
TypeScript packages into a throwaway application, builds a wheel, and replays
one shared corpus on both language surfaces. Floors: node 1203, python 1203,
rust 58, consistency 396, native 4, server 20; TS and Python results must match
case by case; `skipped` must stay 0. With `PSQL_BIN` set the `server` stage
executes 25 cases because the five `psql` cases join the run.

## Wiring SQL onto this repository's storage (batch 2 landed)

Route 2 was taken. Relation data and catalog metadata live in `.yyds`/`.yykv`,
and the TypeScript server supplies the relational semantics:

- `server/sql/parser.ts` turns statement text into AST nodes.
- `server/sql/catalog.ts` treats one JSON catalog document as the single truth
  and projects every `pg_catalog` relation from it.
- `server/sql/engine.ts` executes SELECT, DDL and DML over that projection.
- `server/sql/database.ts` reads and stages rows per relation and hands one
  change batch to `ServerStore.commitChanges`.

Atomicity comes from `FileShard::commit_changes`, not from a second
`commit_many` path on the standalone `Store`. The remaining write-granularity
cost is that every commit re-encodes the whole shard; per-table shards are the
planned fix.

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
