import assert from "node:assert/strict";

import { openNativeClient } from "../src/native-client.mjs";
import { openPgClient } from "../src/pg-client.mjs";
import { startPgServer } from "../src/pg-server.mjs";

function asText(row) {
  return row.map((cell) => (cell === null ? "<null>" : String(cell)));
}

const server = await startPgServer();
const native = openNativeClient(server);
const pg = await openPgClient(server);

let passed = 0;
function pass(line) {
  passed += 1;
  console.log(`PASS ${line}`);
}

try {
  await pg.createTable();
  pass("create table via pg");

  await pg.insert(1, "pg-one", 10);
  await pg.insert(2, "pg-two", 20);
  await pg.insert(3, "pg-three", 30);
  assert.deepEqual(asText(await native.point(1)), ["pg-one"]);
  assert.deepEqual(asText(await native.point(2)), ["pg-two"]);
  assert.deepEqual(asText(await native.point(3)), ["pg-three"]);
  pass("rows inserted via pg are readable via the native client");

  await native.insert(4, "native-four", 40);
  await native.insert(5, "native-five", 50);
  await native.insert(6, "native-six", 60);
  assert.deepEqual(asText(await pg.point(4)), ["native-four"]);
  assert.deepEqual(asText(await pg.point(5)), ["native-five"]);
  assert.deepEqual(asText(await pg.point(6)), ["native-six"]);
  pass("rows inserted via the native client are readable via pg");

  const nativeName = await native.preparePoint();
  const pgName = await pg.preparePoint();
  assert.deepEqual(asText(await native.preparedPoint(nativeName, 1)), ["pg-one"]);
  assert.deepEqual(asText(await pg.preparedPoint(pgName, 4)), ["native-four"]);
  pass("prepared statement agrees across both clients");

  const nativeRows = await native.scan();
  const pgRows = await pg.scan();
  assert.deepEqual(nativeRows.map(asText), [
    ["1", "pg-one", "10"],
    ["2", "pg-two", "20"],
    ["3", "pg-three", "30"],
    ["4", "native-four", "40"],
    ["5", "native-five", "50"],
    ["6", "native-six", "60"],
  ]);
  assert.deepEqual(nativeRows.map(asText), pgRows.map(asText));
  pass("scan ordering and exact cell values agree");

  console.log(`\n${passed} checks passed`);
} finally {
  await native.close();
  await pg.close();
  await server.close();
}
