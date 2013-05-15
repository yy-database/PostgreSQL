# Conformance report

Command: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries test`

One product server, one `pg` connection, and one native connection. Table creation
runs through `pg`. Reads cross both directions, a prepared statement runs on both
sides, and the final scan compares ordering and exact cell values.

Captured output:

```text
PASS create table via pg
PASS rows inserted via pg are readable via the native client
PASS rows inserted via the native client are readable via pg
PASS prepared statement agrees across both clients
PASS scan ordering and exact cell values agree

5 checks passed
```

Regenerate: `pnpm --dir projects/postgres.ts/examples/vs-js-libraries test`
