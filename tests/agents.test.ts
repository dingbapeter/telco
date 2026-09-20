import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { agentLogin, bookCommission, chargeWallet, createAgent, requestWithdrawal, resetAgentLoginLimits, settleWithdrawal, topUpWallet, walletBalance } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { createOrder, getOrder, refundOrder } from "../src/orders.ts";
import { PaystackProvider } from "../src/payments/paystack.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, getTransfer, quoteTransfer, recordInbound, startPayout } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { FakePaystack } from "./helpers/paystack.ts";
import { Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

const ps = new FakePaystack();
let base = "";
let server: Server;
before(async () => {
  await ps.start();
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example", paystack: new PaystackProvider({ baseUrl: ps.base, secretKey: ps.secret }) });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  ps.stop();
  await pool.end();
});

const AGENT = { name: "Mama Nkechi's shop", phone: "08051234567", password: "a long agent password" };
let agentId = 0;
let agentCode = "";
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE agent_topups, agent_withdrawals, agent_sessions, orders, order_events, payment_events, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  resetAgentLoginLimits();
  ps.calls = [];
  ps.verifications.clear();
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "retail.enabled", true);
  });
  const { agent } = await as("founder", (c) => createAgent(c, AGENT));
  agentId = agent.id;
  agentCode = agent.code;
});

async function agentBrowser(): Promise<Browser> {
  const b = new Browser(base);
  const r = await b.post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  assert.equal(r.status, 303, "agent logs in");
  await b.get("/agent");
  return b;
}

test("an agent is created with a code that can be said aloud, a wallet account, and a first password that works once given", async () => {
  assert.match(agentCode, /^[2-9A-HJKMNP-Z]{5}$/);
  assert.equal(await walletBalance(pool, agentId), 0);
  const login = await agentLogin(pool, "0805 123 4567", AGENT.password);
  assert.equal(login.agent.code, agentCode);
  await assert.rejects(agentLogin(pool, AGENT.phone, "wrong password here"), /do not match/);
  await assert.rejects(as("founder", (c) => createAgent(c, { name: "Twice", phone: AGENT.phone })), /already exists/);
});

test("a sender who came through the agent's link is the agent's, and the agent earns a share of our fee when the transfer completes", async () => {
  await as("founder", (c) => setSetting(c, "founder", "agent.commission_basis_points", 2_500));
  const b = new Browser(base);
  const link = await b.get(`/a/${agentCode.toLowerCase()}`);
  assert.equal(link.status, 303);
  const r = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "500" }, false);
  const ref = r.location!.slice(3);
  const t = (await pool.query("SELECT id, agent_id FROM transfers WHERE reference = $1", [ref])).rows[0];
  assert.equal(t.agent_id, agentId);
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(500), rawText: "r", source: "bridge" }));
  await as("w", (c) => startPayout(c, "w", t.id));
  await as("w", (c) => completePayout(c, "w", t.id, "A-1"));
  // Fee 20, all ours; the agent gets a quarter.
  assert.equal(await walletBalance(pool, agentId), naira(5));
  assert.equal(await balance(pool, "expense:agent_commissions"), naira(5));
  assert.equal((await getTransfer(pool, t.id))!.agent_commission_kobo, naira(5));
  // Booked once even if asked again.
  await as("w", (c) => bookCommission(c, agentId, t.id, ref, naira(20)));
  assert.equal(await walletBalance(pool, agentId), naira(5));
});

test("an unknown or paused agent's link brings nobody, and with agents off no commission is attached", async () => {
  const b = new Browser(base);
  const r = await b.get("/a/NOPE9");
  assert.equal(r.location, "/");
  const none = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "500" }, false);
  assert.equal((await pool.query("SELECT agent_id FROM transfers WHERE reference = $1", [none.location!.slice(3)])).rows[0].agent_id, null);
  await b.get(`/a/${agentCode}`);
  await as("founder", (c) => setSetting(c, "founder", "agent.enabled", false));
  const q = await b.post("/quote", { sender: "08031234567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "500" }, false);
  const t = (await pool.query("SELECT agent_id FROM transfers WHERE reference = $1", [q.location!.slice(3)])).rows[0];
  assert.equal(t.agent_id, null);
});

test("a bank transfer recorded for an agent goes into their wallet once, and the agent can then buy for a customer at the agent's discount", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get(`/admin/agents/${agentId}`);
  const first = await b.post(`/admin/agents/${agentId}/topup`, { amount: "2,000", reference: "BNK-A1" });
  assert.match(oks(first.text).join(" "), /N2,000 added to the wallet/);
  const again = await b.post(`/admin/agents/${agentId}/topup`, { amount: "2,000", reference: "BNK-A1" });
  assert.match(oks(again.text).join(" "), /nothing was added twice/);
  assert.equal(await walletBalance(pool, agentId), naira(2_000));
  assert.equal(await balance(pool, "cash:bank"), naira(2_000));
  const ab = await agentBrowser();
  const buy = await ab.post("/agent/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "" });
  assert.equal(buy.status, 303);
  const o = (await pool.query("SELECT * FROM orders WHERE reference = $1", [buy.location!.slice(3)])).rows[0];
  assert.equal(o.state, "paid");
  assert.equal(o.payment_method, "wallet");
  assert.equal(o.agent_id, agentId);
  assert.equal(o.price_kobo, naira(490));
  assert.equal(o.discount_kobo, naira(10));
  assert.equal(await walletBalance(pool, agentId), naira(1_510));
  assert.equal(await balance(pool, "owed:buyers"), naira(490));
});

test("an agent cannot buy more than their wallet holds, and the message says what to do", async () => {
  const ab = await agentBrowser();
  const buy = await ab.post("/agent/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "" });
  assert.equal(buy.status, 400);
  assert.match(problems(buy.text).join(" "), /Your wallet holds N0 and this costs N490. Top up first./);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
});

test("a wallet purchase that is refunded goes back to the wallet, not to a bank", async () => {
  await as("admin", (c) => topUpWallet(c, agentId, { reference: "T1", paidKobo: naira(1_000), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
  const o = await as("agent", (c) => createOrder(c, "agent", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: naira(500), agentId, fromWallet: true }));
  await pool.query("UPDATE orders SET state = 'delivery_failed' WHERE id = $1", [o.id]);
  await as("admin", (c) => refundOrder(c, "admin", o.id, "back"));
  assert.equal(await walletBalance(pool, agentId), naira(1_000));
  assert.equal(await balance(pool, "owed:buyers"), 0);
  assert.equal((await getOrder(pool, o.id))!.state, "refunded");
});

test("an online top-up is started with the agent's own reference and credited once when Paystack confirms, by return or by webhook", async () => {
  const ab = await agentBrowser();
  const start = await ab.post("/agent/topup", { amount: "3000" });
  assert.equal(start.status, 303);
  const reference = (ps.calls.find((c) => c.path === "/transaction/initialize")!.body as { reference: string; amount: number }).reference;
  assert.match(reference, new RegExp(`^AT-${agentId}-`));
  ps.verifications.set(reference, { status: "success", amount: naira(3_000), fees: 4_500, channel: "card" });
  const back = await ab.get(`/payments/paystack/callback?reference=${reference}`);
  assert.equal(back.location, "/agent/topup");
  assert.equal(await walletBalance(pool, agentId), naira(3_000));
  assert.equal(await balance(pool, "cash:paystack"), naira(3_000) - 4_500);
  const body = JSON.stringify({ event: "charge.success", data: { reference, amount: naira(3_000), fees: 4_500 } });
  const hook = await fetch(`${base}/payments/paystack/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": ps.sign(body) }, body });
  assert.deepEqual(await hook.json(), { ok: true, outcome: "already" });
  assert.equal(await walletBalance(pool, agentId), naira(3_000));
});

test("a withdrawal cannot exceed the wallet, is paid once by a person, and can be declined leaving the money", async () => {
  await as("admin", (c) => topUpWallet(c, agentId, { reference: "T2", paidKobo: naira(1_000), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
  await assert.rejects(as("agent", (c) => requestWithdrawal(c, agentId, naira(1_500), "GTB 0123456789 Nkechi")), /Your wallet holds N1,000/);
  const w = await as("agent", (c) => requestWithdrawal(c, agentId, naira(600), "GTB 0123456789 Nkechi"));
  await assert.rejects(as("agent", (c) => requestWithdrawal(c, agentId, naira(500), "GTB")), /N600 already requested. Ask for N400 or less/);
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/agents");
  const paid = await b.post(`/admin/agents/withdrawals/${w.id}`, { outcome: "paid", reference: "OUT-1" });
  assert.match(oks(paid.text).join(" "), /Recorded N600 paid to the agent/);
  assert.equal(await walletBalance(pool, agentId), naira(400));
  assert.equal(await balance(pool, "cash:bank"), naira(400));
  await assert.rejects(as("admin", (c) => settleWithdrawal(c, "admin", w.id, "paid", "OUT-1")), /already paid/);
  const w2 = await as("agent", (c) => requestWithdrawal(c, agentId, naira(400), "GTB"));
  await as("admin", (c) => settleWithdrawal(c, "admin", w2.id, "declined", ""));
  assert.equal(await walletBalance(pool, agentId), naira(400));
});

test("the agent's pages need a login, and a paused agent cannot log in", async () => {
  const b = new Browser(base);
  for (const p of ["/agent", "/agent/buy", "/agent/topup", "/agent/withdraw", "/agent/link"]) assert.equal((await b.get(p)).location, "/agent/login", p);
  const ab = await agentBrowser();
  const link = await ab.get("/agent/link");
  assert.match(link.text, new RegExp(`https://telco.example/a/${agentCode}`));
  await pool.query("UPDATE agents SET active = false WHERE id = $1", [agentId]);
  assert.equal((await ab.get("/agent")).location, "/agent/login");
  const again = await new Browser(base).post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  assert.equal(again.status, 401);
});

test("with agents switched off, nobody can log in and the portal says so", async () => {
  await as("founder", (c) => setSetting(c, "founder", "agent.enabled", false));
  const r = await new Browser(base).post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  assert.equal(r.status, 401);
  assert.match(problems(r.text).join(" "), /not open at the moment/);
});

test("the command centre creates an agent and shows their first password once", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/agents");
  const r = await b.post("/admin/agents", { name: "Oga Sam", phone: "08061234567", email: "" });
  const text = oks(r.text).join(" ");
  assert.match(text, /Oga Sam is agent [2-9A-HJKMNP-Z]{5}/);
  const password = /<code>([^<]+)<\/code>/.exec(r.text)![1]!;
  const login = await new Browser(base).post("/agent/login", { phone: "08061234567", password }, false);
  assert.equal(login.status, 303);
  assert.doesNotMatch((await b.get("/admin/agents")).text, new RegExp(password));
});

test("an agent cannot spend money they have already asked to withdraw", async () => {
  const { agent } = await as("founder", (c) => createAgent(c, { name: "Ada", phone: "08031234599" }));
  await as("admin", (c) => topUpWallet(c, agent.id, { method: "bank_transfer", reference: "BNK-W1", paidKobo: naira(1_000), feeKobo: 0, cashAccount: "cash:bank" }));
  await as("agent", (c) => requestWithdrawal(c, agent.id, naira(900), "GTB 0123456789"));
  await assert.rejects(
    as("agent", (c) => chargeWallet(c, agent.id, naira(500), "RT-TEST1")),
    /already asked for as a withdrawal/,
  );
  // What is left over and above the withdrawal can still be spent.
  await as("agent", (c) => chargeWallet(c, agent.id, naira(100), "RT-TEST2"));
  assert.equal(await walletBalance(pool, agent.id), naira(900));
});
