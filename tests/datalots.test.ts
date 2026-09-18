import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { upsertBundle, type Bundle } from "../src/bundles.ts";
import { consumeLots, expiringSoon, openLot, openLots, writeOffExpired } from "../src/datalots.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { createOrder, completeDelivery, recordPayment, startDelivery } from "../src/orders.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, completeRefund, quoteTransfer, recordInbound, startPayout, startRefund } from "../src/transfers.ts";
import { runPayoutCycle } from "../src/worker.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";

let mtn1gb: Bundle;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE data_lots, orders, order_events, data_bundles RESTART IDENTITY CASCADE");
  await addReceivingNumber("08039990001", "MTN");
  mtn1gb = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB", sizeMb: 1024, validityDays: 30, priceKobo: naira(600), giftable: true }));
});
after(() => pool.end());

async function giftedTransfer() {
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", inBundleId: mtn1gb.id }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(600), dataMb: 1024, rawText: `g ${Math.random()}`, source: "bridge" }));
  return transfer;
}

test("a gifted bundle becomes a lot worth its catalogue value that expires when the bundle does", async () => {
  const t = await giftedTransfer();
  const lots = await openLots(pool);
  assert.equal(lots.length, 1);
  assert.equal(lots[0]!.remaining_value_kobo, naira(600));
  assert.equal(lots[0]!.source, t.reference);
  const days = (new Date(lots[0]!.expires_at!).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `expires in ${days} days`);
});

test("data going out of a pool spends the lot that expires soonest first", async () => {
  await as("founder", (c) => openLot(c, { network: "MTN", bundleId: mtn1gb.id, sizeMb: 1024, valueKobo: naira(600), validityDays: 20, source: "A" }));
  await as("founder", (c) => openLot(c, { network: "MTN", bundleId: mtn1gb.id, sizeMb: 1024, valueKobo: naira(600), validityDays: 5, source: "B" }));
  const left = await as("founder", (c) => consumeLots(c, "MTN", naira(700)));
  assert.equal(left, 0);
  const lots = (await pool.query("SELECT source, state, remaining_value_kobo FROM data_lots ORDER BY source")).rows;
  assert.deepEqual(lots, [
    { source: "A", state: "open", remaining_value_kobo: naira(500) },
    { source: "B", state: "used", remaining_value_kobo: 0 },
  ]);
  // More than the lots hold: the rest is reported, not invented.
  assert.equal(await as("founder", (c) => consumeLots(c, "MTN", naira(900))), naira(400));
});

test("a bundle order delivered from the data pool by hand spends a lot", async () => {
  await giftedTransfer();
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", true));
  const o = await as("buyer", (c) => createOrder(c, "buyer", { network: "MTN", recipientNumber: "08061234567", bundleId: mtn1gb.id }));
  await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "B", paidKobo: naira(600), feeKobo: 0, cashAccount: "cash:bank" }));
  await as("admin", (c) => startDelivery(c, "admin", o.id));
  await as("admin", (c) => completeDelivery(c, "admin", o.id, "MTN-GIFT-1"));
  assert.equal(await balance(pool, "datapool:MTN"), 0);
  assert.equal((await openLots(pool)).length, 0);
});

test("a refund of gifted data spends the lot too", async () => {
  await fundPool("AIRTEL", naira(100));
  const t = await giftedTransfer();
  const start = await as("w", (c) => startPayout(c, "w", t.id));
  assert.equal(start.started, false);
  await as("founder", (c) => startRefund(c, "founder", t.id));
  await as("w", (c) => completeRefund(c, "w", t.id, "SIM-1"));
  assert.equal(await balance(pool, "datapool:MTN"), 0);
  assert.equal((await openLots(pool)).length, 0);
});

test("data that expires unused is written off as a loss, once, with a line in the ledger", async () => {
  await giftedTransfer();
  await pool.query("UPDATE data_lots SET expires_at = now() - interval '1 day'");
  const first = await as("system", (c) => writeOffExpired(c));
  assert.deepEqual(first, { lots: 1, valueKobo: naira(600) });
  const again = await as("system", (c) => writeOffExpired(c));
  assert.deepEqual(again, { lots: 0, valueKobo: 0 });
  assert.equal(await balance(pool, "datapool:MTN"), 0);
  assert.equal(await balance(pool, "expense:losses"), naira(600));
  const j = await pool.query("SELECT description FROM ledger_journals WHERE idempotency_key LIKE 'lot:%'");
  assert.match(j.rows[0].description, /expired unused, N600 written off/);
});

test("the automatic payout run writes off expired data before anything else", async () => {
  await giftedTransfer();
  await pool.query("UPDATE data_lots SET expires_at = now() - interval '1 day'");
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
  const { PhoneRail } = await import("../src/sendingphone.ts");
  await runPayoutCycle(pool, { provider: undefined, phone: new PhoneRail(pool) });
  assert.equal(await balance(pool, "expense:losses"), naira(600));
});

test("data expiring within a week is reported per network; data with more time is not", async () => {
  await as("founder", (c) => openLot(c, { network: "MTN", bundleId: mtn1gb.id, sizeMb: 1024, valueKobo: naira(600), validityDays: 3, source: "soon" }));
  await as("founder", (c) => openLot(c, { network: "MTN", bundleId: mtn1gb.id, sizeMb: 1024, valueKobo: naira(600), validityDays: 20, source: "later" }));
  const soon = await expiringSoon(pool, 7);
  assert.deepEqual(soon, [{ network_code: "MTN", value: naira(600), lots: 1 }]);
  const { runChecklist } = await import("../src/checklist.ts");
  const checks = await runChecklist(pool, {});
  const row = checks.find((c) => c.title.includes("expires within a week"))!;
  assert.ok(row, "checklist row present");
  assert.match(row.title, /N600 of gifted data expires within a week/);
  assert.match(row.fix ?? "", /discount on that network's bundles/);
});
