# with-express

Express 5 REST API backed by `@yydb/postgres` through the [`pg`](https://node-postgres.com/)
driver. The app talks PostgreSQL wire protocol to the product server exactly as it
would to a stock PostgreSQL instance.

## What this demonstrates

- `pg.Pool` wired to non-default host and port settings
- REST CRUD with validation, 404, 409, and 204 responses
- PostgreSQL error mapping by `err.code` (`23505` unique violation to 409)
- a real `BEGIN` / `COMMIT` / `ROLLBACK` transaction that inserts an order and
  decrements stock, with no partial write when stock is insufficient

## Prerequisites

Run `pnpm install` once at the repository root. The example imports the product
through `packages/postgres/dist` and resolves `pg` and `express` from the root
`node_modules`. Run `pnpm build` only when `packages/postgres/dist` or the
platform binding is missing.

## Run

Start the product server from the repository root:

```shell
node projects/postgres.ts/packages/postgres/bin/postgres-server.mjs --port 5432
```

Then start the API in another terminal:

```shell
pnpm --dir projects/postgres.ts/examples/with-express start
```

The API listens on `http://127.0.0.1:3000` by default and connects to the product
server on `127.0.0.1:5432`.

## Test

```shell
pnpm --dir projects/postgres.ts/examples/with-express test
```

The test spawns its own product server in a child process on an ephemeral port
with a temporary data directory, creates the schema, listens on port `0`, and
drives every endpoint with `fetch`. No external server is required.

## Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/health` | runs `SELECT 1`, returns `{ "status": "ok" }` |
| `GET` | `/products` | ordered list with validated `limit` (1-100) and `offset` (>= 0) |
| `GET` | `/products/:id` | 200 with the row, 404 when absent |
| `POST` | `/products` | 201 with the new row, 400 on validation, 409 on duplicate name |
| `PATCH` | `/products/:id` | 200 with the updated row, 404 when absent |
| `DELETE` | `/products/:id` | 204, 404 when absent |
| `POST` | `/orders` | transactional order insert plus stock decrement, 201 or 409 when stock is insufficient |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PGHOST` | `127.0.0.1` | product server host |
| `PGPORT` | `5432` | product server port |
| `PGUSER` | `postgres` | startup user |
| `PGDATABASE` | `postgres` | startup database |
| `PORT` | `3000` | HTTP port |

## Key files

- `src/app.mjs` — `createApp({ pool })`, schema/index creation, routes, error mapping
- `src/server.mjs` — environment configuration, `pg.Pool({ max: 4 })`, graceful shutdown
- `src/server-process.mjs` — child product server used by the test
- `tests/api.mjs` — end-to-end endpoint assertions against a spawned server

## Limits

The checked-in SQL surface does not parse `INSERT ... RETURNING` or `OFFSET` yet.
`POST /products` and `PATCH /products/:id` read the row back with a follow-up
`SELECT`, and pagination applies `offset` after an ordered `LIMIT`. Transactions
themselves run on the server as real `BEGIN` / `COMMIT` / `ROLLBACK`.
