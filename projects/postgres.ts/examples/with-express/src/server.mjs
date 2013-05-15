import pg from "pg";

import { createApp, ensureSchema } from "./app.mjs";

const host = process.env.PGHOST ?? "127.0.0.1";
const port = Number(process.env.PGPORT ?? 5432);
const user = process.env.PGUSER ?? "postgres";
const database = process.env.PGDATABASE ?? "postgres";
const httpPort = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({ host, port, user, database, max: 4 });
await ensureSchema(pool);

const app = createApp({ pool });
const server = app.listen(httpPort, () => {
  console.log(`listening on http://127.0.0.1:${httpPort} (PostgreSQL ${host}:${port})`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`received ${signal}, closing`);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
