import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createAgent } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { runChecklist } from "../src/checklist.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { createOrder, getOrder } from "../src/orders.ts";
import { koboFromMajor, majorUnits } from "../src/payments/gateway.ts";
import { FlutterwaveGateway, flutterwaveConfigFromEnv } from "../src/payments/flutterwave.ts";
import { gatewayFromEnv } from "../src/payments/choose.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { setSetting } from "../src/settings.ts";
import { as, clean, pool } from "./helpers/db.ts";
import { FakeFlutterwave } from "./helpers/flutterwave.ts";
import { Browser, seedAdmin } from "./helpers/web.ts";

// Taking money through Flutterwave, which the founder chose because it accepts
// cards issued outside Nigeria. Everything here is about the three ways it
// differs from the gateway built first, because each of those is a way to book
// the wrong amount.

const fw = new FakeFlutterwave();
let base = "";
let server: Server;
let gateway: FlutterwaveGateway;

before(async () => {
  await fw.start();
  gateway = new FlutterwaveGateway({ baseUrl: `${fw.base}/v3`, secretKey: fw.secret, webhookSecret: fw.webhookSecret });
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example", gateway });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  fw.stop();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE orders, order_events, payment_events, agent_topups, agents, agent_sessions, admin_sessions, admins RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  fw.calls = [];
  fw.verifications.clear();
  await seedAdmin();
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", true));
});

const order = (face = 500) => as("buyer", (c) => createOrder(c, "buyer", { network: "MTN", recipientNumber: "08031234567", faceKobo: naira(face) }));

async function webhook(body: string, hash: string | undefined, header = "verif-hash") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hash !== undefined) headers[header] = hash;
  return fetch(`${base}/payments/flutterwave/webhook`, { method: "POST", headers, body });
}

// --- naira and kobo, the difference that costs a factor of a hundred -------

test("kobo becomes naira with its decimals, both ways", () => {
  assert.equal(majorUnits(naira(500)), "500.00");
  assert.equal(majorUnits(123_456), "1234.56");
  assert.equal(majorUnits(1), "0.01");
  assert.throws(() => majorUnits(0), /whole number of kobo above zero/);
  assert.throws(() => majorUnits(12.5), /whole number of kobo above zero/);
  assert.equal(koboFromMajor("500.00"), naira(500));
  assert.equal(koboFromMajor(1234.56), 123_456);
  assert.equal(koboFromMajor("1,234.56"), 123_456);
  assert.equal(koboFromMajor("7.5"), 750);
  // Not a number at all is nothing, rather than a guess at somebody's money.
  assert.equal(koboFromMajor("about five hundred"), 0);
  assert.equal(koboFromMajor(undefined), 0);
});

test("paying online sends the price in naira, not in kobo, with our own reference", async () => {
  const o = await order(500);
  const b = new Browser(base);
  const r = await b.post(`/o/${o.reference}/pay`, {}, false);
  assert.equal(r.status, 303);
  assert.equal(r.location, `${fw.base}/pay/${o.reference}`);
  const call = fw.calls.find((c) => c.path === "/v3/payments")!;
  assert.equal(call.auth, `Bearer ${fw.secret}`);
  const body = call.body as { amount: string; currency: string; tx_ref: string; redirect_url: string; customer: { email: string } };
  assert.equal(body.amount, "500.00", "five hundred naira, which in kobo would read as fifty thousand");
  assert.equal(body.currency, "NGN");
  assert.equal(body.tx_ref, o.reference);
  assert.equal(body.redirect_url, "https://telco.example/payments/flutterwave/callback");
  assert.match(body.customer.email, /^buyer-08031234567@telco\.example$/);
});

// --- coming back, and what is believed ------------------------------------

test("coming back proves nothing; the payment is read from Flutterwave and booked once", async () => {
  const o = await order(500);
  const b = new Browser(base);
  // Flutterwave sends our reference back as tx_ref.
  const notPaid = await b.get(`/payments/flutterwave/callback?status=successful&tx_ref=${o.reference}&transaction_id=123456`);
  assert.equal(notPaid.location, `/o/${o.reference}`);
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment", "the gateway has not confirmed it yet");
  fw.verifications.set(o.reference, { status: "successful", amount: "500.00", app_fee: "7.50", currency: "NGN", payment_type: "card" });
  await b.get(`/payments/flutterwave/callback?status=successful&tx_ref=${o.reference}&transaction_id=123456`);
  const paid = (await getOrder(pool, o.id))!;
  assert.equal(paid.state, "paid");
  assert.equal(paid.payment_method, "flutterwave");
  assert.equal(paid.payment_fee_kobo, 750, "seven naira fifty, read from naira into kobo");
  assert.equal(await balance(pool, "cash:flutterwave"), naira(500) - 750);
  assert.equal(await balance(pool, "expense:payment_fees"), 750);
  // And again changes nothing.
  await b.get(`/payments/flutterwave/callback?status=successful&tx_ref=${o.reference}`);
  assert.equal(await balance(pool, "cash:flutterwave"), naira(500) - 750);
});

test("a charge Flutterwave calls successful is a success, whatever word it uses", async () => {
  fw.verifications.set("RT-WORD", { status: "SUCCESSFUL", amount: "100.00", app_fee: "0", currency: "NGN", payment_type: "ussd" });
  assert.equal((await gateway.verify("RT-WORD")).status, "success");
  fw.verifications.set("RT-NOPE", { status: "failed", amount: "100.00", app_fee: "0", currency: "NGN", payment_type: "card" });
  assert.equal((await gateway.verify("RT-NOPE")).status, "failed");
  fw.verifications.set("RT-WAIT", { status: "pending", amount: "100.00", app_fee: "0", currency: "NGN", payment_type: "card" });
  assert.equal((await gateway.verify("RT-WAIT")).status, "pending");
  // A reference Flutterwave has never heard of is pending, not paid.
  assert.equal((await gateway.verify("RT-GHOST")).status, "pending");
});

// --- the webhook, whose header is a fixed secret --------------------------

test("a webhook is believed only with the right secret, and the figures come from Flutterwave", async () => {
  const o = await order(500);
  // Flutterwave's header is a secret we chose, not a signature over the body,
  // so a body claiming ten times the price is exactly what a forger would
  // send once they had seen one header. The amount booked is the one
  // Flutterwave confirms.
  const body = JSON.stringify({ event: "charge.completed", data: { tx_ref: o.reference, status: "successful", amount: 5_000, app_fee: 0, currency: "NGN" } });
  assert.equal((await webhook(body, "not-the-secret")).status, 401);
  assert.equal((await webhook(body, undefined)).status, 401);
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment");
  fw.verifications.set(o.reference, { status: "successful", amount: "500.00", app_fee: "7.50", currency: "NGN", payment_type: "card" });
  const real = await webhook(body, fw.verifHash);
  assert.deepEqual(await real.json(), { ok: true, outcome: "paid" });
  assert.equal(await balance(pool, "owed:buyers"), naira(500), "the price, not the figure in the message");
  assert.equal(await balance(pool, "cash:flutterwave"), naira(500) - 750);
  // The same event again does nothing at all.
  assert.deepEqual(await (await webhook(body, fw.verifHash)).json(), { ok: true, outcome: "already seen" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events")).rows[0].n, 1);
});

test("the other gateway's webhook address answers for nobody", async () => {
  // Only the gateway in use has an address. Otherwise a message meant for one
  // could be recorded against the other, and the two hold separate money.
  const r = await fetch(`${base}/payments/paystack/webhook`, { method: "POST", headers: { "content-type": "application/json", "verif-hash": fw.verifHash }, body: JSON.stringify({ event: "charge.completed", data: { tx_ref: "RT-X" } }) });
  assert.equal(r.status, 404);
  const c = await fetch(`${base}/payments/paystack/callback?tx_ref=RT-X`, { redirect: "manual" });
  assert.equal(c.headers.get("location"), "/buy");
});

test("the secret is read whichever spelling of the header it arrives in", async () => {
  // Flutterwave has used more than one spelling. A spelling we did not look at
  // would refuse every webhook for ever, and look like a gateway gone quiet.
  const o = await order(500);
  fw.verifications.set(o.reference, { status: "successful", amount: "500.00", app_fee: "0", currency: "NGN", payment_type: "card" });
  const body = JSON.stringify({ event: "charge.completed", data: { tx_ref: o.reference } });
  const r = await webhook(body, fw.verifHash, "verifHash");
  assert.deepEqual(await r.json(), { ok: true, outcome: "paid" });
});

test("with no webhook secret set, no webhook is believed", async () => {
  const deaf = new FlutterwaveGateway({ baseUrl: `${fw.base}/v3`, secretKey: fw.secret, webhookSecret: "" });
  assert.equal(deaf.verifySignature("{}", ""), false);
  assert.equal(deaf.verifySignature("{}", "anything"), false);
  assert.equal(deaf.webhookSecretSet, false);
});

test("a refund or chargeback message is kept and not acted on", async () => {
  const o = await order(500);
  fw.verifications.set(o.reference, { status: "successful", amount: "500.00", app_fee: "0", currency: "NGN", payment_type: "card" });
  const body = JSON.stringify({ event: "charge.refunded", data: { tx_ref: o.reference, status: "successful", amount: 500 } });
  assert.deepEqual(await (await webhook(body, fw.verifHash)).json(), { ok: true, outcome: "ignored" });
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events")).rows[0].n, 1, "kept, so somebody can see it happened");
});

// --- money that is not naira ---------------------------------------------

test("a charge that came back in another currency is not booked", async () => {
  const o = await order(500);
  // The reason Flutterwave was chosen is that a card from abroad works. The
  // card's currency is the buyer's business and their bank's: what reaches us
  // is naira. A charge that settles in anything else means the figures do not
  // mean what we think, so a person looks at it.
  fw.verifications.set(o.reference, { status: "successful", amount: "0.99", app_fee: "0.02", currency: "USD", payment_type: "card" });
  const body = JSON.stringify({ event: "charge.completed", data: { tx_ref: o.reference, status: "successful", amount: 0.99, currency: "USD" } });
  assert.deepEqual(await (await webhook(body, fw.verifHash)).json(), { ok: true, outcome: "charged in USD, not naira" });
  assert.equal((await getOrder(pool, o.id))!.state, "awaiting_payment");
  assert.equal(await balance(pool, "cash:flutterwave"), 0);
});

// --- an agent topping up -------------------------------------------------

test("an agent's wallet top-up through Flutterwave credits the wallet once", async () => {
  await as("founder", (c) => setSetting(c, "founder", "agent.enabled", true));
  const { agent } = await as("founder", (c) => createAgent(c, { name: "Mama Nkechi shop", phone: "08051234567", password: "a long agent password" }));
  await pool.query("INSERT INTO agent_topups (reference, agent_id, amount_kobo) VALUES ('AT-FW1', $1, $2)", [agent.id, naira(10_000)]);
  fw.verifications.set("AT-FW1", { status: "successful", amount: "10000.00", app_fee: "100.00", currency: "NGN", payment_type: "card" });
  const body = JSON.stringify({ event: "charge.completed", data: { tx_ref: "AT-FW1", status: "successful", amount: 10_000 } });
  assert.deepEqual(await (await webhook(body, fw.verifHash)).json(), { ok: true, outcome: "paid" });
  assert.equal(await balance(pool, `agent:${agent.id}`), naira(10_000));
  assert.equal(await balance(pool, "cash:flutterwave"), naira(10_000) - naira(100));
  assert.equal((await pool.query("SELECT state FROM agent_topups WHERE reference = 'AT-FW1'")).rows[0].state, "paid");
});

// --- what the founder is told -------------------------------------------

test("the checklist knocks on Flutterwave, reads its balance and names a missing webhook secret", async () => {
  const withSecret = await runChecklist(pool, { FLUTTERWAVE_SECRET_KEY: fw.secret, FLUTTERWAVE_BASE_URL: `${fw.base}/v3`, FLUTTERWAVE_WEBHOOK_SECRET: fw.webhookSecret });
  const knock = withSecret.find((c) => c.title === "Flutterwave answers")!;
  assert.ok(knock, "the Flutterwave row is there");
  assert.match(knock.detail, /Balance with Flutterwave N250,000/);
  assert.equal(knock.status, "warn", "test keys are a warning, not an all clear");
  assert.ok(withSecret.some((c) => c.title === "Buyers can pay" && /Flutterwave/.test(c.detail)));
  assert.ok(!withSecret.some((c) => c.title === "Flutterwave webhooks are not believed"));

  const noSecret = await runChecklist(pool, { FLUTTERWAVE_SECRET_KEY: fw.secret, FLUTTERWAVE_BASE_URL: `${fw.base}/v3` });
  const warned = noSecret.find((c) => c.title === "Flutterwave webhooks are not believed")!;
  assert.ok(warned, "a missing webhook secret is said out loud");
  assert.match(warned.fix!, /FLUTTERWAVE_WEBHOOK_SECRET/);

  const wrongKey = await runChecklist(pool, { FLUTTERWAVE_SECRET_KEY: "FLWSECK-wrong", FLUTTERWAVE_BASE_URL: `${fw.base}/v3` });
  assert.ok(wrongKey.some((c) => c.title === "Flutterwave is not working" && /FLUTTERWAVE_SECRET_KEY/.test(c.detail)));
});

test("Flutterwave is used when both gateways have keys, and neither when there are none", () => {
  const both = gatewayFromEnv({ FLUTTERWAVE_SECRET_KEY: "FLWSECK-x", PAYSTACK_SECRET_KEY: "sk_test_y" });
  assert.equal(both?.name, "flutterwave");
  assert.equal(gatewayFromEnv({ PAYSTACK_SECRET_KEY: "sk_test_y" })?.name, "paystack");
  assert.equal(gatewayFromEnv({}), undefined);
  // The money each holds is its own balance, because each settles separately.
  assert.equal(both?.cashAccount, "cash:flutterwave");
  assert.equal(flutterwaveConfigFromEnv({ FLUTTERWAVE_SECRET_KEY: "k" })?.baseUrl, "https://api.flutterwave.com/v3");
});
