import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createAgent, topUpWallet } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { upsertBundle } from "../src/bundles.ts";
import { find } from "../src/find.ts";
import { naira } from "../src/money.ts";
import { createOrder } from "../src/orders.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { getSellbackByReference, quoteSellback } from "../src/sellbacks.ts";
import { setSetting } from "../src/settings.ts";
import { quoteTransfer, recordInbound } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
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

const SENDER = "08031234567";
let transferRef = "";
let orderRef = "";
let saleRef = "";
let creditCode = "";
let agentCode = "";
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE balance_checks, phone_commands, bridge_messages, bridge_devices, sellback_events, credit_notes, sellbacks, orders, order_events, payment_events, data_bundles, agent_batches, agent_topups, agent_sessions, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  await fundPool("AIRTEL", naira(20_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: naira(100_000), GLO: naira(100_000), "9MOBILE": naira(100_000) });
  });
  await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB", sizeMb: 1024, validityDays: 365, priceKobo: naira(600), giftable: true }));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: SENDER, recipientNumber: "08021234567", amountKobo: naira(1_000) }));
  transferRef = transfer.reference;
  orderRef = (await as("buyer", (c) => createOrder(c, "buyer", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: naira(500) }))).reference;
  const { sellback } = await as("seller", (c) => quoteSellback(c, "seller", { network: "MTN", sellerNumber: "08037654321", kind: "airtime", amountKobo: naira(2_000), outcome: "credit" }));
  saleRef = sellback.reference;
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08037654321", amountKobo: naira(2_000), rawText: "You have received N2000 from 08037654321", source: "bridge" }));
  creditCode = (await getSellbackByReference(pool, saleRef))!.credit_code!;
  const { agent } = await as("founder", (c) => createAgent(c, { name: "Mama Nkechi", phone: "08051234567", email: "nkechi@example.com" }));
  agentCode = agent.code;
  await as("founder", (c) => topUpWallet(c, agent.id, { reference: "BNK-1", paidKobo: naira(2_000), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
});

test("one number finds everything that number ever did, however it is typed", async () => {
  for (const typed of ["08037654321", "0803 765 4321", "+2348037654321", "2348037654321"]) {
    const found = await find(pool, typed);
    const kinds = found.hits.map((h) => h.kind);
    assert.ok(kinds.includes("sale"), `${typed} finds the sale`);
    assert.ok(kinds.includes("message"), `${typed} finds the network's own message`);
    assert.equal(found.hits.filter((h) => h.kind === "sale").length, 1, `${typed} finds it once, not twice`);
  }
  const partial = await find(pool, "7654321");
  assert.ok(partial.hits.some((h) => h.title === saleRef), "the last digits are enough");
  // Part of a number with a space in it, as it is written on a scrap of
  // paper: the separators are taken out before anything is looked up.
  const spaced = await find(pool, "0803 765");
  assert.ok(spaced.hits.some((h) => h.title === saleRef), "part of a number written with a space is still a number");
  // The same line written without its leading zero is looked up twice, once
  // as typed and once as we store it, and must still come back once.
  const short = await find(pool, "8037654321");
  assert.equal(short.hits.filter((h) => h.title === saleRef).length, 1, "found once, not once for each way of writing it");
});

test("a reference of any kind goes straight to the thing it names", async () => {
  for (const [reference, kind] of [[transferRef, "transfer"], [orderRef, "order"], [saleRef, "sale"], [creditCode, "credit"], [agentCode, "agent"]] as const) {
    const found = await find(pool, reference);
    assert.ok(found.hits.some((h) => h.kind === kind), `${reference} finds the ${kind}`);
  }
  // Lower case, as a person types it in a hurry.
  assert.ok((await find(pool, transferRef.toLowerCase())).hits.some((h) => h.title === transferRef));
});

test("a credit code finds the sale it came from and the purchase it paid for", async () => {
  const b = new Browser(base);
  const order = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  await b.post(`${order.location}/credit`, { code: creditCode }, false);
  const found = await find(pool, creditCode);
  assert.ok(found.hits.some((h) => h.kind === "credit"));
  assert.ok(found.hits.some((h) => h.kind === "sale" && h.title === saleRef));
  assert.ok(found.hits.some((h) => h.kind === "order"), "and the purchase that was paid with it");
});

test("an agent is found by name, code, phone or email", async () => {
  for (const q of ["Mama", agentCode, "08051234567", "nkechi@example.com"]) {
    assert.ok((await find(pool, q)).hits.some((h) => h.kind === "agent"), q);
  }
});

test("nothing matching says so plainly rather than showing an empty table", async () => {
  const found = await find(pool, "TX-NOTHING");
  assert.equal(found.hits.length, 0);
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/find?q=TX-NOTHING");
  assert.match(page.text, /Nothing anywhere matches/);
  const blank = await b.get("/admin/find");
  assert.match(blank.text, /Everything a customer can read out over the phone/);
});

test("the box is on every page in the command centre, and needs a login like everything else", async () => {
  const b = new Browser(base);
  await b.login();
  for (const path of ["/admin", "/admin/pools", "/admin/money"]) {
    const page = await b.get(path);
    assert.match(page.text, /action="\/admin\/find"/, `${path} carries the box`);
  }
  const page = await b.get(`/admin/find?q=${encodeURIComponent(SENDER)}`);
  assert.match(page.text, new RegExp(transferRef));
  assert.match(page.text, /Transfer/);
  const out = await fetch(`${base}/admin/find?q=x`, { redirect: "manual" });
  assert.equal(out.status, 303);
});
