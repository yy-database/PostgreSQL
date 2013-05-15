import express from "express";

const PRODUCT_FIELDS = "id, name, price, stock";

/** Creates the tables and indexes the example needs. Safe to run on every start. */
export async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    price integer NOT NULL,
    stock integer NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id serial PRIMARY KEY,
    product_id integer NOT NULL,
    quantity integer NOT NULL
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS orders_product_id_idx ON orders (product_id)");
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw httpError(400, `${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw httpError(400, `${name} must be a non-negative integer`);
  return number;
}

function requiredName(value) {
  if (typeof value !== "string" || value.trim() === "") throw httpError(400, "name must be a non-empty string");
  return value.trim();
}

function productId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw httpError(404, "product not found");
  return id;
}

function pgStatus(code) {
  switch (code) {
    case "23505": // unique_violation
    case "23503": // foreign_key_violation
      return 409;
    case "23502": // not_null_violation
    case "22001": // string_data_right_truncation
    case "22003": // numeric_value_out_of_range
    case "22P02": // invalid_text_representation
      return 400;
    default:
      return 500;
  }
}

/** Builds the Express app around a `pg.Pool`. */
export function createApp({ pool }) {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_request, response) => {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  });

  app.get("/products", async (request, response) => {
    const limit =
      request.query.limit === undefined
        ? 20
        : (() => {
            const value = positiveInteger(request.query.limit, "limit");
            if (value > 100) throw httpError(400, "limit must be at most 100");
            return value;
          })();
    const offset = request.query.offset === undefined ? 0 : nonNegativeInteger(request.query.offset, "offset");
    // The gated SELECT surface has no OFFSET yet, so the ordered prefix is
    // fetched with LIMIT and the offset is applied to the materialized rows.
    const result = await pool.query(
      `SELECT ${PRODUCT_FIELDS} FROM products ORDER BY id LIMIT ${offset + limit}`,
    );
    response.json(result.rows.slice(offset, offset + limit));
  });

  app.get("/products/:id", async (request, response) => {
    const id = productId(request.params.id);
    const result = await pool.query(`SELECT ${PRODUCT_FIELDS} FROM products WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw httpError(404, "product not found");
    response.json(result.rows[0]);
  });

  app.post("/products", async (request, response) => {
    const body = request.body ?? {};
    const name = requiredName(body.name);
    const price = nonNegativeInteger(body.price, "price");
    const stock = body.stock === undefined ? 0 : nonNegativeInteger(body.stock, "stock");
    await pool.query("INSERT INTO products (name, price, stock) VALUES ($1, $2, $3)", [name, price, stock]);
    const result = await pool.query(`SELECT ${PRODUCT_FIELDS} FROM products WHERE name = $1`, [name]);
    response.status(201).json(result.rows[0]);
  });

  app.patch("/products/:id", async (request, response) => {
    const id = productId(request.params.id);
    const body = request.body ?? {};
    const current = await pool.query(`SELECT ${PRODUCT_FIELDS} FROM products WHERE id = $1`, [id]);
    if (current.rowCount === 0) throw httpError(404, "product not found");
    const next = {
      name: body.name === undefined ? current.rows[0].name : requiredName(body.name),
      price: body.price === undefined ? current.rows[0].price : nonNegativeInteger(body.price, "price"),
      stock: body.stock === undefined ? current.rows[0].stock : nonNegativeInteger(body.stock, "stock"),
    };
    await pool.query("UPDATE products SET name = $1, price = $2, stock = $3 WHERE id = $4", [
      next.name,
      next.price,
      next.stock,
      id,
    ]);
    const result = await pool.query(`SELECT ${PRODUCT_FIELDS} FROM products WHERE id = $1`, [id]);
    response.json(result.rows[0]);
  });

  app.delete("/products/:id", async (request, response) => {
    const id = productId(request.params.id);
    const result = await pool.query("DELETE FROM products WHERE id = $1", [id]);
    if (result.rowCount === 0) throw httpError(404, "product not found");
    response.status(204).end();
  });

  app.post("/orders", async (request, response) => {
    const body = request.body ?? {};
    const productIdValue = positiveInteger(body.productId, "productId");
    const quantity = positiveInteger(body.quantity, "quantity");

    await pool.query("BEGIN");
    try {
      const selected = await pool.query("SELECT stock FROM products WHERE id = $1", [productIdValue]);
      if (selected.rowCount === 0) throw httpError(404, "product not found");
      const stock = Number(selected.rows[0].stock);
      if (stock < quantity) throw httpError(409, "insufficient stock");

      const inserted = await pool.query("INSERT INTO orders (product_id, quantity) VALUES ($1, $2)", [
        productIdValue,
        quantity,
      ]);
      if (inserted.rowCount !== 1) throw httpError(500, "order insert failed");
      await pool.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [quantity, productIdValue]);
      await pool.query("COMMIT");
      response.status(201).json({ productId: productIdValue, quantity, remainingStock: stock - quantity });
    } catch (error) {
      try {
        await pool.query("ROLLBACK");
      } catch {
        // The failed transaction is already rolled back by the server.
      }
      throw error;
    }
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : pgStatus(error.code);
    if (status >= 500) console.error(error);
    response.status(status).json({ error: status >= 500 ? "internal error" : error.message });
  });

  return app;
}
