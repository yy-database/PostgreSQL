# PostgreSQL

Protocol-v3 client primitives, a protocol-v3 server, a `psql`-compatible
command line, and an independent `.yyds`/`.yykv` key-value store, shared by a
Rust crate, a Node-API binding and a PyO3 binding, with TypeScript and Python
surfaces on top.

## What this repository implements

- **Wire layer.** Startup, simple-query and extended-protocol framing plus
  response decoding come from `database-protocol-pgsql`.
- **Socket client.** `Connection::open` connects to a server and
  `Connection::execute` sends one simple-query packet and decodes the replies
  from `database-client`'s `pgsql` client.
- **Wire server.** `startPostgresServer` in
  `projects/postgres.ts/packages/postgres/src/server/` listens on TCP and speaks
  protocol v3 as the backend: startup, trust, cleartext-password or
  SCRAM-SHA-256 authentication, `SET`, `SHOW`, DDL/DML, the catalog subset
  `psql` needs for `\dt`, `\dv` and `\d`, and `ErrorResponse` plus
  `ReadyForQuery` on failure. Rows live
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

Still missing: `ALTER` beyond constraint operations, `EXPLAIN (ANALYZE)` for
grouping and joins, grouping by a primary key's functional dependency, and
ordered-set aggregates. `EXPLAIN` itself covers single-relation scans with
`ANALYZE` counts plus grouping and join plans as plan text, and rejects set
operations, `WITH`, subqueries and `DISTINCT` with `0A000`.
`INNER`/`LEFT`/`RIGHT`/`FULL`/`CROSS`/`NATURAL` joins with `ON` or `USING`, and
`count`/`sum`/`avg`/`min`/`max`/`string_agg`/`array_agg`/`bool_and`/`bool_or`/
`every` with `DISTINCT`, `FILTER` and aggregate `ORDER BY`, are gated against
real `psql` transcripts.
`CREATE INDEX`/`DROP INDEX` cover `btree` and `hash`, expression keys,
`INCLUDE`, `DESC`/`NULLS FIRST`/`NULLS LAST`, partial predicates, the
`IF NOT EXISTS`/`IF EXISTS` notices, and `pg_get_indexdef`/`pg_indexes`
rendering, also gated against real `psql` transcripts.
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
`AuthenticationOk` for trust, `AuthenticationCleartextPassword` for
`--password`, and the `AuthenticationSASL` exchange for `--auth scram`, where
the verifier stored by `CREATE ROLE ... PASSWORD` / `ALTER ROLE ... PASSWORD`
is the only accepted credential. It then serves `SET`, `SHOW`, `SELECT`,
DDL/DML, and closes on `Terminate`. Every
statement failure is `ErrorResponse` followed by `ReadyForQuery`, so the session
survives.

Storage layout under `--data-dir`:

- `postmaster.pid` is the lock. A second server started on the same directory
  fails with `lock file "..." already exists: another server owns this data
  directory` and never starts listening. The first line records the owning
  process id. A hard kill leaves the file behind, exactly like PostgreSQL, but
  the next start reads the recorded pid and checks whether that process is
  still alive: a live holder keeps the refusal, a dead one has its stale lock
  reclaimed automatically and the server takes the directory. A clean shutdown
  — `close()`, `SIGINT` or `SIGTERM` — removes the file.
- `local-0.yyds` holds the catalog documents. `local-0.yykv` holds the primary
  shard: the catalog is `pg_catalog/catalog`, the cluster directory is
  `pg_cluster`, and sequence high-water marks live beside them.
- Every table and its own indexes live together in
  `shards/local-<relOid>-<hex database>/`, a self-contained single-shard
  directory with its own `.yyds`/`.yykv`/`postmaster.pid` files. A DML commit
  therefore re-encodes only the group it touched, and opening a data directory
  sweeps unreferenced shard directories.
- `sql-schema.v0.json` is a `yyds-sql-schema/v0` projection of the same catalogs,
  rewritten atomically after every schema commit so a data directory carries the
  artifact set the yyds gateways expect. It is never read back for recovery, and
  table names are qualified as `<database>.<schema>.<table>` because the registry
  contract has no cluster dimension. `local-0.yyds` remains the only truth.
- One statement message opens one `Database`, runs its statements, then calls
  `ServerStore.commitChanges` once. A multi-statement simple query therefore
  behaves like one implicit transaction: either every statement becomes durable
  or the whole batch is discarded. `RETURNING` rows are emitted only after the
  commit succeeded.
- `pg_catalog.*` is a pure projection of that single catalog document; there is
  no second copy of table metadata.

Two accepted limitations, recorded so the next change does not need a fresh
investigation:

1. **Per-group commits.** Each table group is its own shard, so a statement that
   touches several groups commits them one at a time with the catalog ordered
   last (or first, for a drop). A crash between groups loses at most the
   unacknowledged statement, but it is not one atomic commit across groups.
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

The same `server` stage now replays 68 system-catalog meta commands in one
`psql` session (`fixtures/psql-meta.sql`) against a server seeded from
`fixtures/meta-setup.sql`, and compares the transcript with one captured from a
real PostgreSQL 16 cluster holding that identical schema. Covered families are
`\d`/`\d+`/`\d <relation>`, `\dt`/`\di`/`\dv`/`\dm`/`\ds`/`\dP(i)` and their
`+` variants, `\dn`, `\df`, `\dp`/`\z`, `\dA`, `\dc`, `\dD`, `\dd`, `\ddf`,
`\dT`, `\dL`, `\dO`, `\dX`, `\dE`, `\det`, `\des`/`\dew`/`\deu`, `\dg`,
`\dl`/`\lo_list`, `\db`, `\dRp`, `\drds`, `\ddp`, `\drg`, `\dRs`, `\dx`, `\l`.
`psql` advisories for empty command results are compared as well, and a server
`ERROR` anywhere in the sweep fails the check instead of being swallowed.

`pg_table_size`, `pg_indexes_size`, `pg_database_size` and
`pg_tablespace_size` report this engine's real byte footprint: the sum of
`.yykv` key and value bytes for the relation, and catalog plus all relations for
a database or tablespace. PostgreSQL counts 8 kB pages, so the `Size` cell of
`\d+`, `\dt+`, `\di+`, `\l+` and `\db+` necessarily differs. The harness masks
only that cell (and the alignment it implies) and still compares every other
character; it does not claim the sizes match.

Deliberately not implemented: `\dAc`, `\dAf`, `\dAo`, `\dAp` and `\dC`, which
dump PostgreSQL's own built-in operator, function, aggregate and conversion
catalogs; `\dFd`/`\dFp`/`\dFt` and their `+` variants, which dump built-in text
search dictionaries, parsers and templates; `\dconfig`, which reads
`pg_settings`; and `\sf`/`\sv`, which print function source. These describe the
server's own implementation inventory rather than user objects, and `\sf`/`\sv`
fail identically on an empty schema in a real cluster.

SQLSTATE evidence through the `pg` driver: `22P02` invalid input syntax,
`42703` unknown column, `42P01` unknown relation, `42P07` duplicate relation,
`23502` not-null, `23505` duplicate key with `Key (id)=(2) already exists.`

Transactions are session state in the wire server. Every simple-query message
still runs as one implicit transaction, and `BEGIN`/`START TRANSACTION` opens an
explicit one whose rows are staged until `COMMIT`. `ROLLBACK`, `SAVEPOINT`,
`RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT` and nested `BEGIN` behave like
PostgreSQL 16.9. Isolation is per transaction: `READ COMMITTED` refreshes the
catalog before each statement, `REPEATABLE READ` freezes a commit counter
snapshot at its first statement and rejects a write to a row committed after it
with `40001 could not serialize access due to concurrent update`; `READ
UNCOMMITTED` is accepted and behaves as `READ COMMITTED`. Row locks are held
until commit, rollback or the first error, which aborts the block, hands its
locks to waiting sessions and turns later statements into `25P02` while
`ROLLBACK` still closes it. A wait that closes a cycle fails the requester with
`40P01 deadlock detected`, the two `Process ... waits for ShareLock ...` detail
lines, the hint and the `while updating tuple (0,N) in relation "..."` context.
The implicit and explicit block transcript, savepoints, DDL rollback, nested
`BEGIN`, read-only transactions, `SET`/`SHOW transaction_isolation`, and the
`READ COMMITTED`/`REPEATABLE READ` visibility transcript match real `psql`
byte for byte against PostgreSQL 16.9; the `40001` and `40P01` reports are
compared modulo process, transaction, tuple and source-location ids. A client
that disappears mid-transaction leaves no rows, and a `COMMIT` already on the
wire completes exactly once.

`CREATE VIEW`/`DROP VIEW` store the query text, expand it on read, track
dependencies for `2BP01` and the cascade notices, and project `pg_views`.
`VACUUM`/`ANALYZE` are accepted as no-ops with PostgreSQL's transaction rule and
non-table warning. `ALTER` beyond constraint operations remains `0A000` +
`DETAIL`.

**COPY and notifications.** `COPY ... TO STDOUT` streams `CopyOutResponse`, one
`CopyData`, `CopyDone` and the `COPY n` tag; text and CSV honor `HEADER`,
`DELIMITER`, `NULL`, `QUOTE` and `ESCAPE`, and `COPY (SELECT ...) TO STDOUT`
runs the embedded query. `COPY ... FROM STDIN` answers `CopyInResponse` and
consumes `CopyData`/`CopyDone`/`CopyFail` through the simple-query protocol
only; the extended protocol keeps an explicit `0A000` for it. The text parser
matches PostgreSQL on `\N` versus `NULL`, on `\.` as the end marker, on escaped
delimiters, and on `COPY t, line n: "row"` / `column c: "value"` contexts, while
binary COPY stays `0A000`. `LISTEN`/`UNLISTEN`/`NOTIFY` deliver
`NotificationResponse` after the committing `CommandComplete` and before
`ReadyForQuery`, drop duplicate channel/payload pairs within one transaction,
undo `LISTEN` on `ROLLBACK`, and expose the session's channels through
`SELECT * FROM pg_listening_channels()`.

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
The server side enforces `statement_timeout` on its own: a statement that runs
past its deadline is cancelled at the next row boundary with SQLSTATE `57014`
(`canceling statement due to statement timeout`), and an open transaction block
enters the aborted state until `ROLLBACK`, the way PostgreSQL 16 does. `0`, the
default, disables the deadline. Termination semantics against an external
engine remain recorded as an **oracle limitation**: what is asserted is what
the client owns — the packet bytes, and that a cancel followed by a normal
statement on the same session still returns `SELECT 1`.

**Connection interruption.** A read that ends after a partial result, a frame
that declares more bytes than arrive, and a peer that closes before
`ReadyForQuery` all raise a `PostgresError::Io`. After any transport or
decoding failure the connection is marked unusable, so a later call returns
`connection is unusable after ...` instead of reading the abandoned reply as
if it belonged to the next statement. A server error (`08P01` for a bad `Bind`)
is *not* a desync: the stream is drained to `ReadyForQuery` and the session
stays usable. `database.client/tests/pgsql_robustness.rs` in the `database.rs`
repository drives every path above with fixed byte scripts against a loopback
listener.

**Timeout and idle.** The socket timeout is a per-read limit, not a session
deadline: a six-second idle gap leaves the session usable and the next
statement returns normally. A statement slower than that limit fails the call
and, through the poison rule above, cannot leave half a result behind. The
client socket keeps that 5 s per-read limit and is not a statement deadline;
`statement_timeout` is enforced by the server as described above.

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
`database.client/tests/pgsql_robustness.rs`: success, a mid-copy `22P02`, a
rejection before `CopyInResponse` that must not stream any data, 500 chunks,
and a peer that closes mid-stream.

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

## Disk full and long-running sessions

**A full disk.** The server was pointed at a 64 MB NTFS volume with 8 MB free
and asked to commit rows carrying 1 MB of text. Four commits succeeded, the
fifth returned SQLSTATE `58030` (`could not write to the data directory`) with
the underlying I/O error in the message, and no `CommandComplete` was reported
for it. The failed row never became visible: `SELECT count(*)` still returned
four and the same session answered `SELECT 1`. The failed commit left no
staging file behind, a restart against the still-nearly-full volume read the
four committed rows, and after space was freed the restart read them with their
full 1 MB payloads plus a parseable `sql-schema.v0.json`. Commits stage a
temporary snapshot and rename it only after the bytes are durable, so an I/O
failure before the rename keeps the previous snapshot and no repair step is
needed. No injected error was used; the volume itself ran out of space. A
graceful `SIGTERM` removes `postmaster.pid`; a hard kill leaves it behind, and
the next start reclaims the lock automatically once the recorded process is
gone, so no operator step is needed for stale locks.

**Long-running sessions.** A 90-minute soak held two sessions open while
running a count every five seconds, opening and closing a fresh connection
every nine seconds (598 in total) and, during the second 45 minutes, wrapping a
delete plus an insert in `BEGIN`/`COMMIT`. Open connections were exactly the two
long-lived sessions at every sample and zero after they closed. Heap read after
two forced GCs moved from 8.2 MB to 9.7 MB over the 90 minutes, RSS from
78.3 MB to 61.2 MB after the start-up spike settled. `arrayBuffers` sat at
209147 bytes for the whole read-only half, rose to 274683 bytes during write
churn and returned to exactly 209147 bytes at the 85- and 90-minute samples.
`external` tracked it apart from one 64 KiB bump and was otherwise the same
2581640 bytes every sample, so `external` minus `arrayBuffers` stayed at
2372493 bytes byte for byte. The earlier unattributed 2.6 MB to 4.8 MB reading
does not reproduce once the two counters are split: the only movement is the
temporary `arrayBuffers` allocation, and it is reclaimed. That bounds this
workload over 90 minutes; multi-hour boundedness is still not claimed.

## Testing

```shell
pnpm test
```

The harness starts PGlite, builds the native binding, packs and installs the
TypeScript packages into a throwaway application, builds a wheel, and replays
one shared corpus on both language surfaces. Floors: node 1203, python 1203,
rust 0, consistency 396, native 4, server 117; TS and Python results must match
case by case; `skipped` must stay 0. With `PSQL_BIN` set the `server` stage
additionally opens real `psql` sessions, including the 68-command
system-catalog sweep described above.

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
`commit_many` path on the standalone `Store`. Table groups are sharded per
relation, so a plain DML commit re-encodes only the target group's bytes; the
catalog stays in the primary shard and commits after the data, or before it on
a drop.

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
