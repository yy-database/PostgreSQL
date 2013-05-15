import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createApp, ensureSchema } from "../src/app.mjs";

const exampleRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(exampleRoot, "src", "server-process.mjs");

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /PGPORT=(\d+)/.exec(output);
      if (match === null) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server process exited before reporting a port (code=${code}, signal=${signal})`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function startProductServer() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "postgres-express-"));
  const child = spawn(process.execPath, [serverScript], {
    cwd: path.join(exampleRoot, "src"),
    env: { ...process.env, PG_HOST: "127.0.0.1", PG_PORT: "0", PG_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  const port = await waitForPort(child);
  return {
    host: "127.0.0.1",
    port,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("exit", finish);
        if (child.connected) child.send({ type: "close" });
        else child.kill();
        const timer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 3_000);
        timer.unref();
      });
    },
  };
}

function startHttpServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

let passed = 0;
function pass(line) {
  passed += 1;
  console.log(`PASS ${line}`);
}

const productServer = await startProductServer();
const pool = new pg.Pool({
  host: productServer.host,
  port: productServer.port,
  user: "postgres",
  database: "postgres",
  max: 4,
});

let httpServer;
try {
  await ensureSchema(pool);
  const app = createApp({ pool });
  httpServer = await startHttpServer(app);
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  async function request(method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    if (text !== "") json = JSON.parse(text);
    return { status: response.status, body: json, text };
  }

  const health = await request("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok" });
  pass("GET /health returns 200");

  const missingName = await request("POST", "/products", { price: 10 });
  assert.equal(missingName.status, 400);
  const badPrice = await request("POST", "/products", { name: "Bad", price: -1 });
  assert.equal(badPrice.status, 400);
  const fractionalPrice = await request("POST", "/products", { name: "Bad", price: 1.5 });
  assert.equal(fractionalPrice.status, 400);
  pass("POST /products validates name and price");

  const created = await request("POST", "/products", { name: "Widget", price: 100, stock: 10 });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "Widget");
  assert.equal(created.body.price, 100);
  assert.equal(created.body.stock, 10);
  const productId = created.body.id;
  pass("POST /products returns 201 with the new row");

  const duplicate = await request("POST", "/products", { name: "Widget", price: 999, stock: 1 });
  assert.equal(duplicate.status, 409);
  pass("POST /products maps unique violation 23505 to 409");

  const list = await request("GET", "/products?limit=1");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  const badLimit = await request("GET", "/products?limit=abc");
  assert.equal(badLimit.status, 400);
  const tooBig = await request("GET", "/products?limit=101");
  assert.equal(tooBig.status, 400);
  const badOffset = await request("GET", "/products?offset=-1");
  assert.equal(badOffset.status, 400);
  pass("GET /products validates limit and offset");

  const fetched = await request("GET", `/products/${productId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, productId);
  const absent = await request("GET", "/products/999999");
  assert.equal(absent.status, 404);
  pass("GET /products/:id returns 200 and 404");

  const patched = await request("PATCH", `/products/${productId}`, { price: 150, stock: 12 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.price, 150);
  assert.equal(patched.body.stock, 12);
  const patchedAbsent = await request("PATCH", "/products/999999", { price: 1 });
  assert.equal(patchedAbsent.status, 404);
  const patchedInvalid = await request("PATCH", `/products/${productId}`, { price: -5 });
  assert.equal(patchedInvalid.status, 400);
  pass("PATCH /products/:id returns 200, 404, and 400");

  const order = await request("POST", "/orders", { productId, quantity: 3 });
  assert.equal(order.status, 201);
  assert.equal(order.body.quantity, 3);
  const afterOrder = await request("GET", `/products/${productId}`);
  assert.equal(afterOrder.body.stock, 9);
  pass("POST /orders commits and decrements stock");

  const shortOrder = await request("POST", "/orders", { productId, quantity: 20 });
  assert.equal(shortOrder.status, 409);
  const afterShort = await request("GET", `/products/${productId}`);
  assert.equal(afterShort.body.stock, 9);
  const orders = await pool.query("SELECT id FROM orders");
  assert.equal(orders.rowCount, 1);
  pass("insufficient stock returns 409 with no partial write");

  const missingProduct = await request("POST", "/orders", { productId: 999999, quantity: 1 });
  assert.equal(missingProduct.status, 404);
  pass("POST /orders returns 404 for an unknown product");

  const removed = await request("DELETE", `/products/${productId}`);
  assert.equal(removed.status, 204);
  assert.equal(removed.text, "");
  const removedAgain = await request("DELETE", `/products/${productId}`);
  assert.equal(removedAgain.status, 404);
  pass("DELETE /products/:id returns 204 and 404");

  console.log(`\n${passed} checks passed`);
} finally {
  if (httpServer !== undefined) await new Promise((resolve) => httpServer.close(resolve));
  await pool.end();
  await productServer.close();
}
