// Runs the product server in its own process. The native client is synchronous,
// so it cannot share an event loop with a server written in JavaScript.
import { startPostgresServer } from "../../../packages/postgres/dist/index.js";

const dataDir = process.env.PG_DATA_DIR;
if (dataDir === undefined || dataDir === "") throw new Error("PG_DATA_DIR is required");

const server = await startPostgresServer({
  host: process.env.PG_HOST ?? "127.0.0.1",
  port: Number(process.env.PG_PORT ?? 0),
  dataDir,
});

console.log(`PGPORT=${server.port}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("disconnect", shutdown);
process.on("message", (message) => {
  if (message !== null && typeof message === "object" && message.type === "close") shutdown();
});
