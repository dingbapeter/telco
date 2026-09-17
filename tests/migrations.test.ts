import assert from "node:assert/strict";
import { after, test } from "node:test";
import { listMigrations, migrate } from "../src/migrate.ts";
import { pool } from "./helpers/db.ts";

after(() => pool.end());

test("running every migration a second time changes nothing and raises nothing", async () => {
  const client = await pool.connect();
  try {
    const before = await client.query("SELECT count(*)::int AS n FROM networks");
    await client.query("DELETE FROM schema_migrations");
    const ran = await migrate(client);
    assert.deepEqual(ran, await listMigrations());
    const after = await client.query("SELECT count(*)::int AS n FROM networks");
    assert.equal(after.rows[0].n, before.rows[0].n);
  } finally {
    client.release();
  }
});

test("a migration that has already been applied is not run again", async () => {
  const client = await pool.connect();
  try {
    const recorded = await client.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(recorded.rows[0].n, (await listMigrations()).length);
    assert.deepEqual(await migrate(client), []);
  } finally {
    client.release();
  }
});

test("migration names sort in the order they were written", async () => {
  const names = await listMigrations();
  assert.deepEqual(names, [...names].sort());
  for (const n of names) assert.match(n, /^\d{4}_[a-z0-9_]+\.sql$/);
});

test("the four Nigerian networks and their ledger accounts exist after migration", async () => {
  const { rows } = await pool.query("SELECT code FROM networks ORDER BY code");
  assert.deepEqual(rows.map((r) => r.code), ["9MOBILE", "AIRTEL", "GLO", "MTN"]);
  const accounts = await pool.query("SELECT count(*)::int AS n FROM ledger_accounts WHERE code LIKE 'pool:%'");
  assert.equal(accounts.rows[0].n, 4);
});
