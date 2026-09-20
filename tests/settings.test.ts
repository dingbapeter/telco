import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { naira } from "../src/money.ts";
import { getAllSettings, getSetting, setSetting, SETTINGS } from "../src/settings.ts";
import { as, clean, pool } from "./helpers/db.ts";

beforeEach(clean);
after(() => pool.end());

test("a setting nobody has set reads as its fallback and says so", async () => {
  const s = await getSetting(pool, "fee.percent_basis_points");
  assert.equal(s.value, 400);
  assert.equal(s.source, "fallback");
});

test("a setting the founder changes is read back from the database", async () => {
  await as("founder", (c) => setSetting(c, "founder", "fee.percent_basis_points", 250));
  const s = await getSetting(pool, "fee.percent_basis_points");
  assert.equal(s.value, 250);
  assert.equal(s.source, "database");
});

test("a value outside its range is refused with the range in the message and nothing changes", async () => {
  await assert.rejects(
    as("founder", (c) => setSetting(c, "founder", "fee.percent_basis_points", 9_999)),
    /Fee percentage must be between 0 percent and 50 percent. Nothing was changed./,
  );
  await assert.rejects(as("founder", (c) => setSetting(c, "founder", "transfer.min_kobo", "abc")), /whole number of kobo/);
  assert.equal((await getSetting(pool, "fee.percent_basis_points")).source, "fallback");
});

test("a stored value that has become invalid falls back and reports the problem", async () => {
  await pool.query("INSERT INTO settings (key, value, updated_by) VALUES ('fee.floor_kobo', '\"not a number\"', 'migration')");
  const s = await getSetting(pool, "fee.floor_kobo");
  assert.equal(s.value, naira(20));
  assert.equal(s.source, "fallback");
  assert.match(s.problem ?? "", /stored value must be a whole number/);
});

test("every change to a setting is in the audit log with who made it and the old and new values", async () => {
  await as("founder", (c) => setSetting(c, "founder", "fee.floor_kobo", naira(30)));
  await as("ops@example", (c) => setSetting(c, "ops@example", "fee.floor_kobo", naira(40)));
  const { rows } = await pool.query("SELECT actor, action, before, after FROM audit_log WHERE table_name = 'settings' ORDER BY id");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, "founder");
  assert.equal(rows[0].action, "insert");
  assert.equal(rows[0].after.value, naira(30));
  assert.equal(rows[1].actor, "ops@example");
  assert.equal(rows[1].action, "update");
  assert.equal(rows[1].before.value, naira(30));
  assert.equal(rows[1].after.value, naira(40));
});

test("per network settings need every network and refuse a stray one", async () => {
  await assert.rejects(
    as("founder", (c) => setSetting(c, "founder", "fee.network_share_basis_points", { MTN: 100 })),
    /AIRTEL must be a whole number of basis points/,
  );
  const set = await as("founder", (c) =>
    setSetting(c, "founder", "fee.network_share_basis_points", { MTN: 100, AIRTEL: 0, GLO: 0, "9MOBILE": 0, EXTRA: 5 }),
  );
  assert.deepEqual(set, { MTN: 100, AIRTEL: 0, GLO: 0, "9MOBILE": 0 });
});

test("a pair override must name two different real networks and known fields", async () => {
  await assert.rejects(as("founder", (c) => setSetting(c, "founder", "fee.pair_overrides", { "MTN>MTN": {} })), /two different networks/);
  await assert.rejects(as("founder", (c) => setSetting(c, "founder", "fee.pair_overrides", { "MTN>AIRTEL": { bogus: 1 } })), /unknown field/);
  const ok = await as("founder", (c) => setSetting(c, "founder", "fee.pair_overrides", { "MTN>AIRTEL": { percent_basis_points: 300 } }));
  assert.deepEqual(ok, { "MTN>AIRTEL": { percent_basis_points: 300 } });
});

test("every setting in the registry has a label, a description and a fallback that passes its own validation", async () => {
  for (const spec of Object.values(SETTINGS)) {
    assert.ok(spec.label.length > 0, spec.key);
    assert.ok(spec.description.length > 0, spec.key);
    assert.ok((spec.validate as (v: unknown) => { ok: boolean })(spec.fallback).ok, `${spec.key} fallback fails its own validation`);
  }
  const all = await getAllSettings(pool);
  assert.equal(all.length, Object.keys(SETTINGS).length);
});

test("a network code with a PIN typed into it instead of the placeholder is refused", async () => {
  await assert.rejects(
    as("founder", (c) => setSetting(c, "founder", "network.transfer_code", { MTN: "*321*4829*{amount}*{number}#", AIRTEL: "", GLO: "", "9MOBILE": "" })),
    /must use \{pin\} where the PIN goes/,
  );
  // The same code with the placeholder is fine.
  await as("founder", (c) => setSetting(c, "founder", "network.transfer_code", { MTN: "*321*{pin}*{amount}*{number}#", AIRTEL: "", GLO: "", "9MOBILE": "" }));
});
