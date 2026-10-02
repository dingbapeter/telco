import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createAgent, resetAgentLoginLimits, setAgentTerms, topUpWallet, walletBalance, type Agent } from "../src/agents.ts";
import { createApiKey, hashToken, listApiKeys } from "../src/agentkeys.ts";
import { buildApp } from "../src/app.ts";
import { upsertBundle } from "../src/bundles.ts";
import { naira } from "../src/money.ts";
import { setSetting } from "../src/settings.ts";
import { resetRateLimits } from "../src/throttle.ts";
import { as, clean, pool } from "./helpers/db.ts";
import { Browser, seedAdmin } from "./helpers/web.ts";

let base = "";
let server: Server;
before(async () => {
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  await pool.end();
});

const AGENT = { name: "Mama Nkechi's shop", phone: "08051234567", password: "a long agent password" };
let agent: Agent;
let token = "";
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE agent_api_keys, agent_batches, agent_topups, agent_withdrawals, agent_sessions, orders, order_events, payment_events, data_bundles, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetAgentLoginLimits();
  resetRateLimits();
  await seedAdmin();
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "agent.api_enabled", true);
    await setSetting(c, "founder", "retail.enabled", true);
  });
  await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 1 year", sizeMb: 1024, validityDays: 30, priceKobo: naira(600) }));
  agent = (await as("founder", (c) => createAgent(c, AGENT))).agent;
  token = (await as("founder", (c) => createApiKey(c, agent.id, "Till at the front counter", "founder"))).token;
});

type Answer = { status: number; body: any };

async function ask(path: string, options: { method?: string; body?: unknown; key?: string | undefined } = {}): Promise<Answer> {
  const key = options.key === undefined ? token : options.key;
  const res = await fetch(base + path, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function fund(kobo: number): Promise<void> {
  await as("founder", (c) => topUpWallet(c, agent.id, { reference: `BNK-${Math.random()}`, paidKobo: kobo, feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
}

test("no key, a made up key and a revoked key are all refused the same way, and the message says what to check", async () => {
  const none = await ask("/api/v1/ping", { key: "" });
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, "bad_key");
  assert.match(none.body.error.message, /Authorization header reads Bearer/);
  assert.equal((await ask("/api/v1/ping", { key: "tk_madeup_nonsense" })).status, 401);
  const key = (await listApiKeys(pool, agent.id))[0]!;
  await as("founder", (c) => c.query("UPDATE agent_api_keys SET active = false WHERE id = $1", [key.id]));
  assert.equal((await ask("/api/v1/ping")).status, 401);
});

test("only the fingerprint of a key is kept, and the audit log never holds even that", async () => {
  const row = (await pool.query("SELECT token_hash, key_id FROM agent_api_keys WHERE agent_id = $1", [agent.id])).rows[0];
  assert.equal(row.token_hash, hashToken(token));
  assert.ok(!token.includes(row.token_hash));
  assert.match(token, new RegExp(`^tk_${row.key_id}_[A-Za-z0-9_-]{20,}$`));
  const audit = (await pool.query("SELECT after FROM audit_log WHERE table_name = 'agent_api_keys' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(audit.after.token_hash, "[hidden]");
});

test("with the interface switched off a key is refused with words the shop can act on, and the portal still works", async () => {
  await as("founder", (c) => setSetting(c, "founder", "agent.api_enabled", false));
  const r = await ask("/api/v1/ping");
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "api_off");
  assert.match(r.body.error.message, /Your keys still exist and the portal pages still work/);
  const b = new Browser(base);
  await b.post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  const keys = await b.get("/agent/keys");
  assert.equal(keys.status, 200);
  assert.match(keys.text, /not open at the moment/);
});

test("a paused agent's key stops working and their balance is untouched", async () => {
  await fund(naira(1_000));
  await as("founder", (c) => c.query("UPDATE agents SET active = false WHERE id = $1", [agent.id]));
  assert.equal((await ask("/api/v1/balance")).status, 401);
  assert.equal(await walletBalance(pool, agent.id), naira(1_000));
});

test("the interface says who is calling, what can be spent, and what is on offer at this agent's own price", async () => {
  await fund(naira(3_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(10_000));
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: 500, commissionBasisPoints: null, creditLimitKobo: naira(2_000) }));
  const ping = await ask("/api/v1/ping");
  assert.equal(ping.body.agent.code, agent.code);
  const money = await ask("/api/v1/balance");
  assert.equal(money.body.wallet.kobo, naira(3_000));
  assert.equal(money.body.wallet.shown, "N3,000");
  assert.equal(money.body.credit_line.kobo, naira(2_000));
  assert.equal(money.body.free_to_spend.kobo, naira(5_000));
  assert.equal(money.body.discount_percent, 5);
  const catalogue = await ask("/api/v1/catalogue");
  assert.equal(catalogue.body.selling, true);
  assert.equal(catalogue.body.bundles[0].code, "mtn-1gb");
  assert.equal(catalogue.body.bundles[0].face_value.kobo, naira(600));
  assert.equal(catalogue.body.bundles[0].you_pay.kobo, naira(570));
});

test("a quote says what a purchase would cost without buying it", async () => {
  await fund(naira(100));
  const airtime = await ask("/api/v1/quote", { body: { number: "0803 123 4567", amount: 500 } });
  assert.equal(airtime.body.network, "MTN", "the network comes from the number");
  assert.equal(airtime.body.you_pay.kobo, naira(490));
  assert.equal(airtime.body.affordable, false);
  const bundle = await ask("/api/v1/quote", { body: { number: "08031234567", bundle: "mtn-1gb" } });
  assert.equal(bundle.body.face_value.kobo, naira(600));
  assert.equal(bundle.body.bundle, "MTN 1GB, 1 year");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0, "a quote buys nothing");
  const nothing = await ask("/api/v1/quote", { body: { number: "08031234567" } });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error.message, /Send an amount of airtime in naira, or a bundle code/);
});

test("a purchase is paid from the wallet at once, and the same reference of the shop's own never buys twice", async () => {
  await fund(naira(2_000));
  const first = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0009", number: "08031234567", amount: 500 } });
  assert.equal(first.status, 201);
  assert.equal(first.body.repeated, false);
  assert.equal(first.body.purchase.state, "paid");
  assert.equal(first.body.purchase.paid.kobo, naira(490));
  assert.equal(await walletBalance(pool, agent.id), naira(1_510));
  const again = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0009", number: "08031234567", amount: 500 } });
  assert.equal(again.status, 200);
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.purchase.reference, first.body.purchase.reference);
  assert.equal(await walletBalance(pool, agent.id), naira(1_510), "the wallet was charged once");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 1);
  // A purchase with no reference of its own is refused, because a retry
  // would otherwise sell the customer twice.
  const bare = await ask("/api/v1/purchase", { body: { number: "08031234567", amount: 500 } });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error.message, /Send a client_reference of your own/);
});

test("an amount sent in kobo is refused rather than quietly selling a hundredth of it", async () => {
  await fund(naira(2_000));
  const r = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0010", number: "08031234567", amount_kobo: 50_000 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "amount_in_naira");
  assert.match(r.body.error.message, /takes amounts in naira, in a field called amount/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
});

test("a wallet that cannot cover the purchase is refused with the figures, and the shop can read a purchase back by either reference", async () => {
  await fund(naira(100));
  const poor = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0011", number: "08031234567", amount: 500 } });
  assert.equal(poor.status, 400);
  assert.match(poor.body.error.message, /Your wallet holds N100 and this costs N490/);
  await fund(naira(1_000));
  const bought = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0012", number: "08031234567", amount: 500 } });
  const ours = await ask(`/api/v1/purchase/${bought.body.purchase.reference}`);
  assert.equal(ours.body.purchase.state, "paid");
  const theirs = await ask("/api/v1/purchase/till-1-0012");
  assert.equal(theirs.body.purchase.reference, bought.body.purchase.reference);
  const missing = await ask("/api/v1/purchase/RT-NOTHING");
  assert.equal(missing.status, 404);
});

test("one shop cannot read another shop's purchase", async () => {
  await fund(naira(1_000));
  const mine = await ask("/api/v1/purchase", { body: { client_reference: "till-1-0013", number: "08031234567", amount: 500 } });
  const other = (await as("founder", (c) => createAgent(c, { name: "Another shop", phone: "08059998877" }))).agent;
  const otherKey = (await as("founder", (c) => createApiKey(c, other.id, "Their till", "founder"))).token;
  const nosy = await ask(`/api/v1/purchase/${mine.body.purchase.reference}`, { key: otherKey });
  assert.equal(nosy.status, 404);
  assert.equal(nosy.body.error.code, "no_such_purchase");
});

test("a whole list of customers is bought in one request, all of them or none, and sending it again returns the same list", async () => {
  await fund(naira(5_000));
  const body = { client_reference: "batch-mon-1", lines: [{ number: "08031234567", amount: 500 }, { number: "08161234567", network: "AIRTEL", amount: 200 }, { number: "08031234567", bundle: "mtn-1gb" }] };
  const first = await ask("/api/v1/purchases", { body });
  assert.equal(first.status, 201);
  assert.equal(first.body.batch.lines, 3);
  assert.equal(first.body.batch.total.kobo, naira(490) + naira(196) + naira(588));
  assert.equal(first.body.purchases.length, 3);
  const again = await ask("/api/v1/purchases", { body });
  assert.equal(again.status, 200);
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.batch.reference, first.body.batch.reference);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 3);
  // One bad line stops the whole list.
  const bad = await ask("/api/v1/purchases", { body: { client_reference: "batch-mon-2", lines: [{ number: "08031234567", amount: 500 }, { number: "0803", amount: 500 }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Line 2/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 3);
});

test("the statement comes back as figures between two dates", async () => {
  await fund(naira(1_000));
  await ask("/api/v1/purchase", { body: { client_reference: "till-1-0014", number: "08031234567", amount: 500 } });
  const s = await ask("/api/v1/statement");
  assert.equal(s.body.closing.kobo, naira(510));
  assert.equal(s.body.totals.purchase.count, 1);
  assert.equal(s.body.movements.length, 2);
  assert.equal(s.body.bought_face_value.kobo, naira(500));
  const bad = await ask("/api/v1/statement?from=yesterday");
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /should be a date like/);
});

test("a key that asks far too often is asked to wait, and told for how long", async () => {
  await as("founder", (c) => setSetting(c, "founder", "agent.api_rate_per_minute", 3));
  for (let i = 0; i < 3; i++) assert.equal((await ask("/api/v1/ping")).status, 200);
  const stopped = await ask("/api/v1/ping");
  assert.equal(stopped.status, 429);
  assert.equal(stopped.body.error.code, "too_many_requests");
  assert.ok(stopped.body.error.wait_seconds >= 1 && stopped.body.error.wait_seconds <= 60);
  assert.match(stopped.body.error.message, /more requests this minute than the 3 allowed/);
});

test("a shop makes and revokes its own keys, and is never shown a key twice", async () => {
  const b = new Browser(base);
  await b.post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  await b.get("/agent/keys");
  const made = await b.post("/agent/keys", { label: "Second till" });
  const shown = /class="dial">(tk_[^<]+)</.exec(made.text);
  assert.ok(shown, "the key is shown once");
  const fresh = shown![1]!;
  assert.equal((await ask("/api/v1/ping", { key: fresh })).status, 200);
  const later = await b.get("/agent/keys");
  assert.ok(!later.text.includes(fresh), "and never again");
  const keys = await listApiKeys(pool, agent.id);
  const second = keys.find((k) => k.label === "Second till")!;
  await b.get("/agent/keys");
  const revoked = await b.post(`/agent/keys/${second.id}/revoke`, {});
  assert.match(revoked.text, /The key for Second till is revoked/);
  assert.equal((await ask("/api/v1/ping", { key: fresh })).status, 401);
  // And not somebody else's key.
  const other = (await as("founder", (c) => createAgent(c, { name: "Another shop", phone: "08059998877", password: "another long password" }))).agent;
  const theirs = (await as("founder", (c) => createApiKey(c, other.id, "Their till", "founder"))).key;
  await b.get("/agent/keys");
  const refused = await b.post(`/agent/keys/${theirs.id}/revoke`, {});
  assert.equal(refused.status, 400);
  assert.equal((await listApiKeys(pool, other.id))[0]!.active, true);
});
