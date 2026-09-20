import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { completeDelivery, createOrder, expireOrders, getOrder, getOrderByReference, priceFor, recordPayment, refundOrder, startDelivery } from "../src/orders.ts";
import { PaystackProvider } from "../src/payments/paystack.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { VtpassRail } from "../src/rails/vtpass.ts";
import { setSetting } from "../src/settings.ts";
import { runDeliveryCycle } from "../src/worker.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { FakePaystack } from "./helpers/paystack.ts";
import { FakeVtpass } from "./helpers/vtpass.ts";
import { Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

const ps = new FakePaystack();
const vt = new FakeVtpass();
let base = "";
let server: Server;
let paystack: PaystackProvider;

before(async () => {
  await ps.start();
  await vt.start();
  paystack = new PaystackProvider({ baseUrl: ps.base, secretKey: ps.secret });
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example", paystack });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  ps.stop();
  vt.stop();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE orders, order_events, payment_events, admin_sessions, admins RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  ps.calls = [];
  ps.verifications.clear();
  vt.calls = [];
  await seedAdmin();
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "retail.bank_name", "Example Bank");
    await setSetting(c, "founder", "retail.bank_account_number", "0123456789");
    await setSetting(c, "founder", "retail.bank_account_name", "Telco Ltd");
  });
});

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function order(face = 500, network = "MTN") {
  return as("buyer", (c) => createOrder(c, "buyer", { network, recipientNumber: "08031234567", faceKobo: naira(face) }));
}

test("a discount on a network to drain its pool comes off the price, and face value is what the buyer receives", async () => {
  assert.deepEqual(priceFor(naira(500), 0), { faceKobo: naira(500), discountKobo: 0, priceKobo: naira(500) });
  assert.deepEqual(priceFor(naira(500), 300), { faceKobo: naira(500), discountKobo: naira(15), priceKobo: naira(485) });
  await as("founder", (c) => setSetting(c, "founder", "retail.discount_basis_points", { MTN: 300, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const o = await order(500, "MTN");
  assert.equal(o.price_kobo, naira(485));
  assert.equal(o.face_kobo, naira(500));
  assert.match(o.reference, /^RT-[2-9A-HJKMNP-Z]{8}$/);
});

test("nobody can buy while selling is off, below the minimum, above the maximum, or in kobo", async () => {
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", false));
  await assert.rejects(order(500), /not open right now/);
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", true));
  await assert.rejects(order(50), /smallest purchase is N100/);
  await assert.rejects(order(50_000), /largest purchase is N20,000/);
  await assert.rejects(as("buyer", (c) => createOrder(c, "buyer", { network: "MTN", recipientNumber: "08031234567", faceKobo: 50_050 })), /whole number of naira/);
});

test("a bank transfer recorded by hand books the cash and the debt to the buyer, and the same payment recorded twice books once", async () => {
  const o = await order();
  const first = await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-1", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal(first.outcome, "paid");
  const again = await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-1", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal(again.outcome, "already");
  assert.equal(await balance(pool, "cash:bank"), naira(500));
  assert.equal(await balance(pool, "owed:buyers"), naira(500));
});

test("an underpayment is held for a person and can only be refunded", async () => {
  const o = await order();
  const r = await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-2", paidKobo: naira(300), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal(r.outcome, "held");
  assert.equal(r.order.hold_reason, "underpaid");
  const start = await as("admin", (c) => startDelivery(c, "admin", o.id));
  assert.equal(start.started, false);
  const { releaseOrderHold } = await import("../src/orders.ts");
  await assert.rejects(as("admin", (c) => releaseOrderHold(c, "admin", o.id)), /can only be refunded/);
  const refunded = await as("admin", (c) => refundOrder(c, "admin", o.id, "BNK-R2"));
  assert.equal(refunded.state, "refunded");
  assert.equal(await balance(pool, "owed:buyers"), 0);
  assert.equal(await balance(pool, "cash:bank"), 0);
});

test("delivery from our own SIM books the sale against the pool with the discount as its own line", async () => {
  await fundPool("MTN", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "retail.discount_basis_points", { MTN: 300, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const o = await order(500);
  await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-3", paidKobo: naira(485), feeKobo: 0, cashAccount: "cash:bank" }));
  const start = await as("admin", (c) => startDelivery(c, "admin", o.id));
  assert.equal(start.started, true);
  await as("admin", (c) => completeDelivery(c, "admin", o.id, "MTN-REF"));
  assert.equal((await getOrder(pool, o.id))!.state, "delivered");
  assert.equal(await balance(pool, "pool:MTN"), naira(4_500));
  assert.equal(await balance(pool, "owed:buyers"), 0);
  assert.equal(await balance(pool, "expense:retail_discounts"), naira(15));
  assert.equal(await balance(pool, "cash:bank"), naira(485));
});

test("a paid order is delivered through the provider without a person, with commission booked and the pool untouched", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
  const o = await order(500);
  await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-4", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  const rail = new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
  const report = await runDeliveryCycle(pool, rail);
  assert.equal(report.delivered, 1);
  const done = (await getOrder(pool, o.id))!;
  assert.equal(done.state, "delivered");
  assert.equal(done.delivery_rail, "vtpass");
  assert.equal(await balance(pool, "wallet:vtpass"), naira(10_000) - 48_500);
  assert.equal(await balance(pool, "revenue:provider_commission"), 1_500);
  assert.equal(await balance(pool, "pool:MTN"), 0);
  assert.equal(await balance(pool, "owed:buyers"), 0);
});

test("the buyer's page shows the price, the bank details with the reference, and a way to pay online", async () => {
  const b = new Browser(base);
  const r = await b.post("/buy", { network: "AIRTEL", number: "0802 123 4567", amount: "1,000", email: "" }, false);
  assert.equal(r.status, 303);
  assert.match(r.location!, /^\/o\/RT-/);
  const text = strip((await b.get(r.location!)).text);
  assert.match(text, /Pay N1,000 for N1,000 of Airtel airtime/);
  assert.match(text, /Example Bank/);
  assert.match(text, /0123456789/);
  assert.match(text, /Narration or remark RT-/);
  assert.match(text, /Pay N1,000 by card, bank or USSD/);
  assert.doesNotMatch(text, /08021234567/);
});

test("a buyer's mistake is shown on the form and creates nothing", async () => {
  const b = new Browser(base);
  const r = await b.post("/buy", { network: "MTN", number: "0803", amount: "500", email: "" }, false);
  assert.equal(r.status, 400);
  assert.match(problems(r.text).join(" "), /Nigerian mobile number/);
  const bad = await b.post("/buy", { network: "MTN", number: "08031234567", amount: "500", email: "not-an-email" }, false);
  assert.match(problems(bad.text).join(" "), /does not look like an email/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
});

test("when selling is off, the buy page says so plainly", async () => {
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", false));
  const b = new Browser(base);
  const r = await b.get("/buy");
  assert.equal(r.status, 404);
  assert.match(strip(r.text), /not open yet/);
});

test("paying online sends the buyer to Paystack with our reference and the price in kobo", async () => {
  const o = await order(500);
  const b = new Browser(base);
  const r = await b.post(`/o/${o.reference}/pay`, {}, false);
  assert.equal(r.status, 303);
  assert.equal(r.location, `${ps.base}/checkout/${o.reference}`);
  const call = ps.calls.find((c) => c.path === "/transaction/initialize")!;
  assert.equal(call.auth, `Bearer ${ps.secret}`);
  assert.equal((call.body as { amount: number }).amount, naira(500));
  assert.equal((call.body as { reference: string }).reference, o.reference);
  assert.equal((call.body as { callback_url: string }).callback_url, "https://telco.example/payments/paystack/callback");
  assert.match((call.body as { email: string }).email, /^buyer-08031234567@telco\.example$/);
});

test("coming back from Paystack proves nothing; the payment is read from Paystack, then recorded once", async () => {
  const o = await order(500);
  const b = new Browser(base);
  const notPaid = await b.get(`/payments/paystack/callback?reference=${o.reference}`);
  assert.equal(notPaid.location, `/o/${o.reference}`);
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment");
  ps.verifications.set(o.reference, { status: "success", amount: naira(500), fees: 750, channel: "ussd" });
  await b.get(`/payments/paystack/callback?reference=${o.reference}`);
  const paid = (await getOrder(pool, o.id))!;
  assert.equal(paid.state, "paid");
  assert.equal(paid.payment_method, "paystack");
  assert.equal(paid.payment_fee_kobo, 750);
  assert.equal(await balance(pool, "cash:paystack"), naira(500) - 750);
  assert.equal(await balance(pool, "expense:payment_fees"), 750);
  await b.get(`/payments/paystack/callback?reference=${o.reference}`);
  assert.equal(await balance(pool, "cash:paystack"), naira(500) - 750);
});

async function webhook(body: string, signature: string) {
  return fetch(`${base}/payments/paystack/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": signature }, body });
}

test("a webhook is believed only with a valid signature, and the same event twice books once", async () => {
  const o = await order(500);
  const body = JSON.stringify({ event: "charge.success", data: { reference: o.reference, amount: naira(500), fees: 750, status: "success" } });
  const forged = await webhook(body, ps.sign(body, "sk_test_wrong"));
  assert.equal(forged.status, 401);
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment");
  const real = await webhook(body, ps.sign(body));
  assert.equal(real.status, 200);
  assert.deepEqual(await real.json(), { ok: true, outcome: "paid" });
  const again = await webhook(body, ps.sign(body));
  assert.deepEqual(await again.json(), { ok: true, outcome: "already seen" });
  assert.equal(await balance(pool, "owed:buyers"), naira(500));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events")).rows[0].n, 1);
});

test("a webhook for an order nobody placed is recorded and ignored", async () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "RT-NOPE", amount: 100, fees: 0 } });
  const r = await webhook(body, ps.sign(body));
  assert.deepEqual(await r.json(), { ok: true, outcome: "no such order" });
});

test("an administrator can confirm a bank transfer, deliver by hand, and refund, from the order page", async () => {
  await fundPool("GLO", naira(2_000));
  const o = await order(500, "GLO");
  const b = new Browser(base);
  await b.login();
  await b.get(`/admin/orders/${o.id}`);
  const paid = await b.post(`/admin/orders/${o.id}/payment`, { amount: "500", reference: "BNK-9" });
  assert.match(oks(paid.text).join(" "), /N500 recorded/);
  const started = await b.post(`/admin/orders/${o.id}/delivery/start`, {});
  assert.match(oks(started.text).join(" "), /send N500 of GLO airtime to 08031234567/);
  const done = await b.post(`/admin/orders/${o.id}/delivery/done`, { reference: "GLO-1" });
  assert.match(oks(done.text).join(" "), /delivered and the sale is booked/);
  assert.equal(await balance(pool, "pool:GLO"), naira(1_500));
  const list = await b.get("/admin/orders?state=delivered");
  assert.match(list.text, new RegExp(o.reference));
});

test("an unpaid order expires and its page says so; an expired order can still be paid when the transfer lands late", async () => {
  const o = await order(500);
  await pool.query("UPDATE orders SET expires_at = now() - interval '1 minute'");
  assert.equal(await expireOrders(pool), 1);
  const b = new Browser(base);
  assert.match(strip((await b.get(`/o/${o.reference}`)).text), /time to pay has passed/);
  const r = await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "LATE", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal(r.outcome, "paid");
});

test("the settlement page shows each network's accrued share, what was paid, and refuses to record more than is owed", async () => {
  await addReceivingNumber("08039990001", "MTN");
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "fee.network_share_basis_points", { MTN: 2_500, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const { quoteTransfer, recordInbound, startPayout, completePayout } = await import("../src/transfers.ts");
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(500), rawText: "r", source: "bridge" }));
  await as("w", (c) => startPayout(c, "w", transfer.id));
  await as("w", (c) => completePayout(c, "w", transfer.id, "A-1"));
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/settlement");
  const text = strip(page.text);
  assert.match(text, /MTN Share of fee 25.00 percent/);
  assert.match(text, /Owed now N5/);
  const key = /name="key" value="([^"]+)"/.exec(page.text)![1]!;
  const tooMuch = await b.post("/admin/settlement/pay", { network: "MTN", amount: "10", reference: "X", key });
  assert.match(problems(tooMuch.text).join(" "), /more than the N5 owed to MTN/);
  const ok = await b.post("/admin/settlement/pay", { network: "MTN", amount: "5", reference: "X", key });
  assert.match(oks(ok.text).join(" "), /Recorded N5 paid to MTN/);
  assert.equal(await balance(pool, "owed:MTN"), 0);
  assert.equal(await balance(pool, "cash:bank"), -naira(5));
});

test("the checklist says when airtime is for sale with no way to pay, and knocks on Paystack", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.bank_name", "");
    await setSetting(c, "founder", "retail.bank_account_number", "");
    await setSetting(c, "founder", "retail.bank_account_name", "");
  });
  const { runChecklist } = await import("../src/checklist.ts");
  const noPay = await runChecklist(pool, {});
  assert.ok(noPay.some((c) => c.title === "Airtime is for sale but nobody can pay" && c.status === "bad"));
  const withKeys = await runChecklist(pool, { PAYSTACK_SECRET_KEY: ps.secret, PAYSTACK_BASE_URL: ps.base });
  const knock = withKeys.find((c) => c.title === "Paystack answers")!;
  assert.ok(knock, "Paystack row present");
  assert.match(knock.detail, /Balance with Paystack N250,000/);
  assert.equal(knock.status, "warn");
  assert.match(knock.fix ?? "", /live secret key/);
  const wrongKey = await runChecklist(pool, { PAYSTACK_SECRET_KEY: "sk_live_wrong", PAYSTACK_BASE_URL: ps.base });
  assert.ok(wrongKey.some((c) => c.title === "Paystack is not working" && /PAYSTACK_SECRET_KEY/.test(c.detail)));
});

test("the buyer's pages stay small", async () => {
  const o = await order(500);
  const b = new Browser(base);
  for (const [name, path, limit] of [["buy", "/buy", 7_000], ["order", `/o/${o.reference}`, 6_000]] as const) {
    const r = await b.get(path);
    assert.ok(Buffer.byteLength(r.text) < limit, `${name} is ${Buffer.byteLength(r.text)} bytes, over ${limit}`);
  }
  void getOrderByReference;
});

test("paying more than the price waits for a person instead of leaving money with nowhere to go", async () => {
  const o = await order();
  const r = await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "BNK-OVER", paidKobo: naira(700), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal(r.outcome, "held");
  const held = await getOrder(pool, o.id);
  assert.equal(held!.state, "held");
  assert.equal(held!.hold_reason, "overpaid");
});

test("one bank narration cannot pay two orders", async () => {
  const first = await order();
  const second = await order();
  await as("admin", (c) => recordPayment(c, "admin", first.id, { method: "bank_transfer", reference: "BNK-SAME", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  await assert.rejects(
    as("admin", (c) => recordPayment(c, "admin", second.id, { method: "bank_transfer", reference: "BNK-SAME", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" })),
  );
  assert.equal(await balance(pool, "cash:bank"), naira(500));
});
