import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { createDevice, parseDataMessage } from "../src/bridge.ts";
import { describeSize, parseSizeMb, sizeFromName, upsertBundle, validityFromName, type Bundle } from "../src/bundles.ts";
import { computeFee, requiredAmountFor, type FeeRule } from "../src/fees.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { createOrder, getOrder, recordPayment } from "../src/orders.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { VtpassRail } from "../src/rails/vtpass.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, getTransfer, quoteTransfer, recordInbound, settleForBundle, startPayout } from "../src/transfers.ts";
import { runDeliveryCycle, runPayoutCycle } from "../src/worker.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { delivered, FakeVtpass } from "./helpers/vtpass.ts";
import { Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

const vt = new FakeVtpass();
let base = "";
let server: Server;
before(async () => {
  await vt.start();
  // The Data bundles page reads the provider from the environment.
  process.env["VTPASS_BASE_URL"] = vt.base;
  process.env["VTPASS_API_KEY"] = vt.keys.api;
  process.env["VTPASS_SECRET_KEY"] = vt.keys.secret;
  process.env["VTPASS_PUBLIC_KEY"] = vt.keys.public;
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  vt.stop();
  for (const k of ["VTPASS_BASE_URL", "VTPASS_API_KEY", "VTPASS_SECRET_KEY", "VTPASS_PUBLIC_KEY"]) delete process.env[k];
  await pool.end();
});

let airtel1gb: Bundle;
let mtn1gb: Bundle;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE orders, order_events, bridge_messages, bridge_devices, data_bundles, admin_sessions, admins RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  vt.calls = [];
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  await addReceivingNumber("08029990001", "AIRTEL");
  airtel1gb = await as("founder", (c) => upsertBundle(c, { network: "AIRTEL", code: "airtel-1gb", name: "Airtel 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: naira(500), providerVariationCode: "airt-1gb" }));
  mtn1gb = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: naira(600), giftable: true }));
  await as("founder", (c) => setSetting(c, "founder", "network.data_gift_code", { MTN: "*131*{number}*{size}#", AIRTEL: "", GLO: "", "9MOBILE": "" }));
});

const rule: FeeRule = { percentBasisPoints: 400, flatKobo: 0, floorKobo: naira(20), ceilingKobo: naira(200), networkShareBasisPoints: 0 };

test("sizes are read the way people and networks write them", () => {
  assert.equal(parseSizeMb("1GB"), 1024);
  assert.equal(parseSizeMb("1.5 gb"), 1536);
  assert.equal(parseSizeMb("500MB"), 500);
  assert.equal(parseSizeMb("lots"), undefined);
  assert.equal(describeSize(1024), "1GB");
  assert.equal(describeSize(1536), "1.5GB");
  assert.equal(describeSize(500), "500MB");
  assert.equal(sizeFromName("MTN 2.5GB - 30 days"), 2560);
  assert.equal(validityFromName("MTN 2.5GB - 30 days"), 30);
  assert.equal(validityFromName("Airtel 1GB (1 Month)"), 30);
});

test("the amount a sender must send for a bundle covers its price after the fee and not a naira more", () => {
  for (const price of [naira(300), naira(500), naira(1_000), naira(4_999), naira(9_500)]) {
    const amount = requiredAmountFor(price, rule);
    assert.equal(amount % 100, 0, "whole naira");
    assert.ok(computeFee(amount, rule).payoutKobo >= price, `${amount} covers ${price}`);
    assert.ok(computeFee(amount - 100, rule).payoutKobo < price, `${amount - 100} would not cover ${price}`);
  }
  const s = settleForBundle(naira(521), naira(500), rule);
  assert.equal(s.payoutKobo, naira(500));
  assert.equal(s.feeKobo, naira(21));
  assert.equal(s.platformShareKobo + s.networkShareKobo, s.feeKobo);
});

test("a sender who wants the other side to get a bundle is told the exact airtime to send, and the exact amount is required", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
  const { transfer, fee } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", outBundleId: airtel1gb.id }));
  assert.equal(transfer.out_kind, "data");
  assert.equal(transfer.requested_kobo, naira(521));
  assert.equal(fee.payoutKobo, naira(500));
  // A different amount is held, not moved.
  const wrong = await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(600), rawText: "r1", source: "bridge" }));
  assert.equal(wrong.outcome, "held");
  assert.equal((await getTransfer(pool, transfer.id))!.hold_reason, "amount_above_required");
  // The exact amount on a fresh quote is matched and the bundle bought from the provider.
  const second = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", outBundleId: airtel1gb.id }));
  const right = await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(521), rawText: "r2", source: "bridge" }));
  assert.equal(right.outcome, "matched");
  const rail = new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
  const report = await runPayoutCycle(pool, rail);
  assert.equal(report.delivered, 1);
  const call = vt.calls.find((c) => c.path === "/pay")!;
  assert.equal((call.body as { serviceID: string }).serviceID, "airtel-data");
  assert.equal((call.body as { variation_code: string }).variation_code, "airt-1gb");
  assert.equal((call.body as { amount: number }).amount, 500);
  const done = (await getTransfer(pool, second.transfer.id))!;
  assert.equal(done.state, "completed");
  assert.equal(done.payout_kobo, naira(500));
  assert.equal(await balance(pool, "revenue:fees"), naira(21));
});

test("a bundle the provider does not know is routed to the sending phone, and waits for a person when there is none", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
  const noCode = await as("founder", (c) => upsertBundle(c, { network: "AIRTEL", code: "airtel-2gb", name: "Airtel 2GB", sizeMb: 2048, priceKobo: naira(1_000) }));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", outBundleId: noCode.id }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: transfer.requested_kobo, rawText: "r", source: "bridge" }));
  const rail = new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
  const report = await runPayoutCycle(pool, rail);
  assert.equal(report.sent, 0);
  assert.equal(vt.calls.filter((c) => c.path === "/pay").length, 0);
  assert.match(report.skipped.join(" "), /the provider does not know this bundle/);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "inbound_confirmed");
});

test("a gifted bundle is valued at its catalogue price, booked in the data pool, and paid out as airtime", async () => {
  await fundPool("AIRTEL", naira(5_000));
  const { transfer, fee } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", inBundleId: mtn1gb.id }));
  assert.equal(transfer.in_kind, "data");
  assert.equal(transfer.requested_kobo, naira(600));
  assert.equal(fee.payoutKobo, naira(576));
  const gift = await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(600), dataMb: 1024, rawText: "You have received 1GB from 08031234567", source: "bridge" }));
  assert.equal(gift.outcome, "matched");
  assert.equal(await balance(pool, "datapool:MTN"), naira(600));
  assert.equal(await balance(pool, "pool:MTN"), 0);
  await as("w", (c) => startPayout(c, "w", transfer.id));
  await as("w", (c) => completePayout(c, "w", transfer.id, "A-1"));
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(5_000 - 576));
  assert.equal(await balance(pool, "revenue:fees"), naira(24));
  assert.equal(await balance(pool, "owed:senders"), 0);
});

test("airtime arriving does not match a transfer waiting for a gifted bundle, and a bundle does not match one waiting for airtime", async () => {
  await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", inBundleId: mtn1gb.id }));
  const airtime = await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(600), rawText: "a", source: "bridge" }));
  assert.equal(airtime.outcome, "unmatched");
  await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08051234567", recipientNumber: "08021234567", amountKobo: naira(600) }));
  const gift = await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08051234567", amountKobo: naira(600), dataMb: 1024, rawText: "g", source: "bridge" }));
  assert.equal(gift.outcome, "unmatched");
});

test("a bundle that is not giftable cannot be offered as the thing sent, and a bundle too small to cover another is refused with the reason", async () => {
  await assert.rejects(
    as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "AIRTEL", toNetwork: "MTN", senderNumber: "08021234567", recipientNumber: "08031234567", inBundleId: airtel1gb.id })),
    /cannot be gifted to us on AIRTEL/,
  );
  const big = await as("founder", (c) => upsertBundle(c, { network: "AIRTEL", code: "airtel-10gb", name: "Airtel 10GB", sizeMb: 10240, priceKobo: naira(3_000), providerVariationCode: "x" }));
  await assert.rejects(
    as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", inBundleId: mtn1gb.id, outBundleId: big.id })),
    /does not cover Airtel 10GB/,
  );
});

test("the phone bridge reads a data gift message and values it from the catalogue", async () => {
  const parsed = parseDataMessage("Dear customer, you have received 1GB data from 08031234567. Enjoy!", "");
  assert.deepEqual(parsed, { sizeMb: 1024, senderNumber: "08031234567" });
  assert.ok("problem" in parseDataMessage("Your balance is N50", ""));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", inBundleId: mtn1gb.id }));
  const { token } = await as("founder", (c) => createDevice(c, "MTN phone", "MTN"));
  const send = (body: string) =>
    fetch(`${base}/bridge/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ from: "MTN", body }] }) });
  const r = (await (await send("Dear customer, you have received 1GB data from 08031234567. Enjoy!")).json()) as { results: { outcome: string; transferReference?: string }[] };
  assert.equal(r.results[0]!.outcome, "matched");
  assert.equal(r.results[0]!.transferReference, transfer.reference);
  assert.equal(await balance(pool, "datapool:MTN"), naira(600));
  const unknown = (await (await send("You have received 3GB data from 08031234567")).json()) as { results: { outcome: string }[] };
  assert.equal(unknown.results[0]!.outcome, "unparsed");
  const m = await pool.query("SELECT note FROM bridge_messages ORDER BY id DESC LIMIT 1");
  assert.match(m.rows[0].note, /no giftable MTN bundle of that size/);
});

test("the catalogue can be filled from the provider's real list, and hand-set prices survive a fetch", async () => {
  vt.variations = { "mtn-data": [{ variation_code: "mtn-1gb-v", name: "MTN 1GB - 30 days", variation_amount: "550.00" }, { variation_code: "mtn-weird", name: "MTN special", variation_amount: "100" }] };
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/bundles");
  const r = await b.post("/admin/bundles/fetch", { network: "MTN" });
  assert.match(oks(r.text).join(" "), /lists 2 MTN bundle\(s\): 1 saved, 1 skipped/);
  const fetched = (await pool.query("SELECT * FROM data_bundles WHERE code = 'mtn-1gb-v'")).rows[0];
  assert.equal(fetched.price_kobo, 55_000);
  assert.equal(fetched.source, "vtpass");
  // A person edits the price; a later fetch does not undo it but fills in the code.
  await b.post("/admin/bundles", { network: "MTN", code: "mtn-1gb-v", name: "MTN 1GB", size: "1GB", validity: "30", price: "520", variation: "", giftable: "yes" });
  await b.post("/admin/bundles/fetch", { network: "MTN" });
  const kept = (await pool.query("SELECT * FROM data_bundles WHERE code = 'mtn-1gb-v'")).rows[0];
  assert.equal(kept.price_kobo, 52_000);
  assert.equal(kept.source, "manual");
  assert.equal(kept.giftable, true);
  assert.equal(kept.provider_variation_code, "mtn-1gb-v");
  delete vt.variations;
});

test("the sender's page offers bundles and shows the gift code for a bundle sent", async () => {
  const b = new Browser(base);
  const home = await b.get("/");
  assert.match(home.text, /Airtel 1GB, 30 days \(1GB, 30 days, N500\)/);
  assert.match(home.text, /What you are sending/);
  const r = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "", send: String(mtn1gb.id), receive: "" }, false);
  assert.equal(r.status, 303);
  const text = (await b.get(r.location!)).text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Now gift the bundle MTN 1GB, 30 days to 08039990001/);
  assert.match(text, /\*131\*08039990001\*MTN 1GB, 30 days#/);
  assert.match(text, /The recipient gets N576 of airtime on Airtel/);
  const out = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "", send: "", receive: String(airtel1gb.id) }, false);
  const text2 = (await b.get(out.location!)).text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text2, /Now send N521 of MTN airtime/);
  assert.match(text2, /The recipient gets the bundle Airtel 1GB, 30 days on Airtel/);
  const wrongNet = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "GLO", amount: "", send: "", receive: String(airtel1gb.id) }, false);
  assert.match(problems(wrongNet.text).join(" "), /for AIRTEL, not GLO/);
});

test("a buyer can order a bundle at its catalogue price and it is delivered through the provider", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "payout.automatic", true);
  });
  const o = await as("buyer", (c) => createOrder(c, "buyer", { network: "AIRTEL", recipientNumber: "08021234567", bundleId: airtel1gb.id }));
  assert.equal(o.price_kobo, naira(500));
  assert.equal(o.bundle_id, airtel1gb.id);
  await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "B", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  const rail = new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
  const report = await runDeliveryCycle(pool, rail);
  assert.equal(report.delivered, 1);
  assert.equal((vt.calls.find((c) => c.path === "/pay")!.body as { variation_code: string }).variation_code, "airt-1gb");
  assert.equal((await getOrder(pool, o.id))!.state, "delivered");
  const b = new Browser(base);
  const page = (await b.get(`/o/${o.reference}`)).text;
  assert.match(page, /The bundle Airtel 1GB, 30 days was sent/);
});

test("the provider's delivered figures for a bundle are booked like airtime", async () => {
  vt.defaultPay = (body) => delivered(body.request_id, body.amount, 5);
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", outBundleId: airtel1gb.id }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: transfer.requested_kobo, rawText: "r", source: "bridge" }));
  const rail = new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
  await runPayoutCycle(pool, rail);
  assert.equal(await balance(pool, "wallet:vtpass"), naira(10_000) - naira(495));
  assert.equal(await balance(pool, "revenue:provider_commission"), naira(5));
  vt.defaultPay = (b) => delivered(b.request_id, b.amount);
});
