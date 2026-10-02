import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { bookCommission, createAgent, topUpWallet } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { upsertBundle, type Bundle } from "../src/bundles.ts";
import { writeOffExpired } from "../src/datalots.ts";
import { naira } from "../src/money.ts";
import { completeDelivery, createOrder, recordPayment, startDelivery } from "../src/orders.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { balanceSheet, booksAddUp, earnedToday, profitAndLoss, startOfMonth, today } from "../src/report.ts";
import { quoteSellback } from "../src/sellbacks.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, quoteTransfer, recordInbound, startPayout } from "../src/transfers.ts";
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

let mtn1gb: Bundle;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE sellback_events, credit_notes, sellbacks, orders, order_events, payment_events, data_lots, data_bundles, agent_batches, agent_topups, agent_withdrawals, agent_sessions, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  mtn1gb = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 1 year", sizeMb: 1024, validityDays: 365, priceKobo: naira(600), giftable: true }));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.data_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: naira(100_000), GLO: naira(100_000), "9MOBILE": naira(100_000) });
  });
});

// Money through every line the business has, so the report has something of
// each kind to add up.
async function aBusyDay(): Promise<void> {
  await fundPool("AIRTEL", naira(20_000));
  await as("founder", (c) => setSetting(c, "founder", "fee.network_share_basis_points", { MTN: 2_500, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  // A transfer: fee earned, the network's share held for them.
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(1_000) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(1_000), rawText: "received N1000 from 08031234567", source: "bridge" }));
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => completePayout(c, "worker", transfer.id, "VT-1"));
  // A sale at a discount, paid by card with a payment fee.
  await as("founder", (c) => setSetting(c, "founder", "retail.discount_basis_points", { MTN: 0, AIRTEL: 500, GLO: 0, "9MOBILE": 0 }));
  const order = await as("buyer", (c) => createOrder(c, "buyer", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: naira(1_000) }));
  await as("founder", (c) => recordPayment(c, "founder", order.id, { method: "paystack", reference: "PS-1", paidKobo: order.price_kobo, feeKobo: naira(15), cashAccount: "cash:paystack" }));
  await as("worker", async (c) => {
    await startDelivery(c, "worker", order.id);
    await completeDelivery(c, "worker", order.id, "VT-2");
  });
  // An agent's commission on a transfer they brought.
  const { agent } = await as("founder", (c) => createAgent(c, { name: "Mama Nkechi", phone: "08051234567" }));
  await as("founder", (c) => topUpWallet(c, agent.id, { reference: "BNK-1", paidKobo: naira(2_000), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
  await as("worker", (c) => bookCommission(c, agent.id, transfer.id, transfer.reference, naira(30)));
  // Airtime bought back below what we sell it for.
  const { sellback } = await as("seller", (c) => quoteSellback(c, "seller", { network: "MTN", sellerNumber: "08037654321", kind: "airtime", amountKobo: naira(2_000), outcome: "credit" }));
  assert.equal(sellback.state, "awaiting_inbound");
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08037654321", amountKobo: naira(2_000), rawText: "received N2000 from 08037654321", source: "bridge" }));
  // Data bought and never sold on, written off as the loss it is.
  const { sellback: data } = await as("seller", (c) => quoteSellback(c, "seller", { network: "MTN", sellerNumber: "08037654322", kind: "data", bundleId: mtn1gb.id, outcome: "credit" }));
  assert.equal(data.kind, "data");
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08037654322", amountKobo: naira(600), dataMb: 1_024, rawText: "1GB gifted by 08037654322", source: "bridge" }));
  await as("worker", (c) => writeOffExpired(c, new Date(Date.now() + 40 * 86_400_000)));
}

test("what we hold less what we owe is what the founder put in plus what the business has earned, after money has moved every way it can", async () => {
  await aBusyDay();
  const sheet = await balanceSheet(pool);
  assert.ok(sheet.addsUp, `held ${sheet.heldKobo} owed ${sheet.owedKobo} put in ${sheet.putInKobo} earned ${sheet.earnedKobo}`);
  assert.equal(sheet.ownKobo, sheet.putInKobo + sheet.earnedKobo);
  // Every line is named, and what is owed to other people is kept apart
  // from what is ours.
  assert.ok(sheet.held.some((l) => l.code === "pool:MTN"));
  assert.ok(sheet.owed.some((l) => l.code === "owed:MTN"), "the network's share of the fee is a debt, not revenue");
  assert.ok(sheet.owed.some((l) => l.code === "owed:sellers"));
  assert.ok(sheet.owed.some((l) => l.code === "agent:*"), "agents' wallets are folded into one line");
});

test("the alarm that says the books do not add up can tell when they do not", () => {
  // The database refuses to post a journal that would break this, so the
  // only way to prove the alarm works is to hand it figures that are wrong.
  assert.equal(booksAddUp({ heldKobo: 100_000, owedKobo: 40_000, putInKobo: 50_000, earnedKobo: 10_000 }), true);
  assert.equal(booksAddUp({ heldKobo: 100_000, owedKobo: 40_000, putInKobo: 50_000, earnedKobo: 9_900 }), false, "a hundred naira adrift is still adrift");
  assert.equal(booksAddUp({ heldKobo: 100_000, owedKobo: 0, putInKobo: 50_000, earnedKobo: 10_000 }), false, "money owed to other people is never ours");
  assert.equal(booksAddUp({ heldKobo: 0, owedKobo: 0, putInKobo: 0, earnedKobo: 0 }), true, "a business that has done nothing adds up too");
});

test("the report names what was earned and what it cost, from the ledger alone", async () => {
  await aBusyDay();
  const p = await profitAndLoss(pool, {});
  assert.equal(p.from, startOfMonth());
  assert.equal(p.to, today());
  const line = (code: string): number => p.earned.concat(p.spent).find((l) => l.code === code)?.kobo ?? 0;
  // Fee of N40 on N1,000, of which the network keeps a quarter.
  assert.equal(line("revenue:fees"), naira(30));
  assert.equal(p.networkShareKobo, naira(10));
  // Bought N2,000 of airtime for N1,600, and a N600 bundle for N420.
  assert.equal(line("revenue:sellback_margin"), naira(400) + naira(180));
  assert.equal(line("expense:retail_discounts"), naira(50));
  assert.equal(line("expense:payment_fees"), naira(15));
  assert.equal(line("expense:agent_commissions"), naira(6));
  assert.equal(line("expense:losses"), naira(600), "data we could not sell on is a loss we can see");
  assert.equal(p.profitKobo, p.earnedKobo - p.spentKobo);
  assert.equal(p.profitKobo, naira(30) + naira(580) - naira(50) - naira(15) - naira(6) - naira(600));
  assert.equal(await earnedToday(pool), p.profitKobo, "today's figure on the overview agrees with the report");
  // And what was done, not only what it earned.
  assert.equal(p.volumes.transfers, 1);
  assert.equal(p.volumes.movedKobo, naira(1_000));
  assert.equal(p.volumes.orders, 1);
  assert.equal(p.volumes.soldKobo, naira(950));
  assert.equal(p.volumes.sales, 2);
  assert.equal(p.volumes.boughtKobo, naira(1_600) + naira(420));
});

test("a period holds its own days and nobody else's, counted in Lagos days", async () => {
  await aBusyDay();
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const from = `${lastMonth.toISOString().slice(0, 7)}-01`;
  const to = `${lastMonth.toISOString().slice(0, 7)}-28`;
  const empty = await profitAndLoss(pool, { from, to });
  assert.equal(empty.profitKobo, 0, "a month with no business earned nothing");
  assert.equal(empty.days.length, 0);
  assert.equal(empty.volumes.transfers, 0);
  const all = await profitAndLoss(pool, { from, to: today() });
  assert.ok(all.profitKobo !== 0, "and the period that holds today has today's business in it");
  assert.equal(all.days.length, 1);
  assert.equal(all.days[0]!.day, today());
  // Yesterday's business is not in a report that starts tomorrow.
  await assert.rejects(profitAndLoss(pool, { from: "last monday" }), /should be a date like/);
  await assert.rejects(profitAndLoss(pool, { from: "2026-13-01" }), /not a real date/);
  await assert.rejects(profitAndLoss(pool, { from: "2026-02-30" }), /not a real date/);
  await assert.rejects(profitAndLoss(pool, { from: today(), to: from }), /start date is after the end date/);
});

test("the money page shows the three numbers a founder needs, and hands the period over as a file", async () => {
  await aBusyDay();
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/money");
  assert.equal(page.status, 200);
  assert.match(page.text, /What we hold<\/div><div class="value">/);
  assert.match(page.text, /What is ours<\/div><div class="value">/);
  assert.match(page.text, /Our share of transfer fees/);
  assert.match(page.text, /MTN airtime/, "a long ledger name is shortened so the amount stays on a phone screen");
  assert.match(page.text, /MTN(&#39;|')s share of fees/);
  // The apostrophe is escaped on the way out, as every value is.
  assert.match(page.text, /Agents(&#39;|') wallets \(1\)/);
  assert.match(page.text, /<svg class="bars"/, "the chart is drawn on the server, with no script");
  assert.doesNotMatch(page.text, /style="/, "and no written style, which the security policy refuses");
  const file = await fetch(`${base}/admin/money?what=csv`, { headers: { cookie: b.cookieHeader() }, redirect: "manual" });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition") ?? "", /attachment; filename="telco-money-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}.csv"/);
  const text = await file.text();
  assert.match(text, /^Telco money report/);
  assert.match(text, /Our share of transfer fees,30\.00/);
  assert.match(text, /Profit,/);
});

test("the money page needs a login like every other page in the command centre", async () => {
  const r = await fetch(`${base}/admin/money`, { redirect: "manual" });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location") ?? "", /\/admin\/login/);
});
