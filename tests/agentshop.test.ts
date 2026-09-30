import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { agentTerms, createAgent, resetAgentLoginLimits, setAgentTerms, spendable, topUpWallet, walletBalance, type Agent } from "../src/agents.ts";
import { buildStatement, kindOf, movementsCsv, purchasesCsv, startOfLagosMonth, lagosToday } from "../src/agentstatement.ts";
import { buildApp } from "../src/app.ts";
import { batchReferenceFor, buyInBulk, parseBulkText } from "../src/bulkorders.ts";
import { upsertBundle } from "../src/bundles.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { setSetting } from "../src/settings.ts";
import { as, clean, pool } from "./helpers/db.ts";
import { Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

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
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE agent_api_keys, agent_batches, agent_topups, agent_withdrawals, agent_sessions, orders, order_events, payment_events, data_bundles, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetAgentLoginLimits();
  await seedAdmin();
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "retail.enabled", true);
  });
  await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: naira(600) }));
  await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb-week", name: "MTN 1GB, 7 days", sizeMb: 1024, validityDays: 7, priceKobo: naira(500) }));
  await as("founder", (c) => upsertBundle(c, { network: "AIRTEL", code: "airtel-2gb", name: "Airtel 2GB, 30 days", sizeMb: 2048, validityDays: 30, priceKobo: naira(1_000) }));
  agent = (await as("founder", (c) => createAgent(c, AGENT))).agent;
});

async function fund(kobo: number, reference = `BNK-${Math.random()}`): Promise<void> {
  await as("founder", (c) => topUpWallet(c, agent.id, { reference, paidKobo: kobo, feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
}

async function agentBrowser(): Promise<Browser> {
  const b = new Browser(base);
  const r = await b.post("/agent/login", { phone: AGENT.phone, password: AGENT.password }, false);
  assert.equal(r.status, 303, "agent logs in");
  await b.get("/agent");
  return b;
}

async function buy(text: string, reference = "BK-ABCD2345"): Promise<{ lines: number; total: number; states: string[] }> {
  const r = await as("test", (c) => buyInBulk(c, agent, "test", { reference, text }));
  return { lines: r.batch.lines, total: r.batch.total_kobo, states: r.orders.map((o) => o.state) };
}

// --- a rate of this agent's own -------------------------------------------

test("an agent with a rate of their own buys at that rate, and one without buys at the rate in Settings", async () => {
  await fund(naira(10_000));
  const onDefault = await agentTerms(pool, agent.id);
  assert.equal(onDefault.discountBasisPoints, 200, "the fallback in Settings is two percent");
  assert.equal(onDefault.ownDiscount, false);
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: 700, commissionBasisPoints: null, creditLimitKobo: 0 }));
  const own = await agentTerms(pool, agent.id);
  assert.equal(own.discountBasisPoints, 700);
  assert.equal(own.ownDiscount, true);
  assert.equal(own.commissionBasisPoints, 2_000, "the share of our fee still comes from Settings");
  const b = await agentBrowser();
  const bought = await b.post("/agent/buy", { number: "08031234567", network: "MTN", amount: "1000", bundle: "" });
  assert.equal(bought.status, 303);
  const o = (await pool.query("SELECT * FROM orders WHERE reference = $1", [bought.location!.slice(3)])).rows[0];
  assert.equal(o.price_kobo, naira(930), "seven percent off a thousand naira");
  assert.equal(o.discount_kobo, naira(70));
});

test("a rate above what is allowed is refused and the agent's terms are left alone", async () => {
  await assert.rejects(as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: 2_500, commissionBasisPoints: null, creditLimitKobo: 0 })), /between 0 and 2000/);
  assert.equal((await agentTerms(pool, agent.id)).ownDiscount, false);
  const b = new Browser(base);
  await b.login();
  await b.get(`/admin/agents/${agent.id}`);
  const r = await b.post(`/admin/agents/${agent.id}/terms`, { discount: "not a number", commission: "", credit: "" });
  assert.equal(r.status, 400);
  assert.match(problems(r.text).join(" "), /should be a percentage/);
});

test("the command centre writes an agent's own terms, and empty boxes put them back on the rate in Settings", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get(`/admin/agents/${agent.id}`);
  const saved = await b.post(`/admin/agents/${agent.id}/terms`, { discount: "3.5", commission: "25", credit: "" });
  assert.match(oks(saved.text).join(" "), /buys at 3.5% below face value/);
  assert.match(oks(saved.text).join(" "), /earns 25% of our fee/);
  const terms = await agentTerms(pool, agent.id);
  assert.equal(terms.discountBasisPoints, 350);
  assert.equal(terms.commissionBasisPoints, 2_500);
  // The audit log holds the change, without anybody remembering to write it.
  const audit = (await pool.query("SELECT actor, after FROM audit_log WHERE table_name = 'agents' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(audit.actor, "admin:founder@example.com");
  assert.equal(audit.after.discount_basis_points, 350);
  const back = await b.post(`/admin/agents/${agent.id}/terms`, { discount: "", commission: "", credit: "" });
  assert.match(oks(back.text).join(" "), /buys at the rate in Settings/);
  assert.equal((await agentTerms(pool, agent.id)).ownDiscount, false);
});

// --- many customers in one go ---------------------------------------------

test("a list is read the way a shopkeeper writes it", () => {
  const { requests, problems: bad } = parseBulkText(
    ["08031234567 500", "0803 123 4567, 1,000", "# my note", "", "08161234567 airtel 200", "08031234567 1GB"].join("\n"),
  );
  assert.equal(bad.length, 0);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((r) => r.number), ["08031234567", "08031234567", "08161234567", "08031234567"]);
  assert.equal(requests[1]!.amountKobo, naira(1_000));
  assert.equal(requests[2]!.network, "AIRTEL");
  assert.equal(requests[3]!.bundleText, "1GB");
});

test("a list that cannot be read says which line and buys nothing", async () => {
  const { problems: bad } = parseBulkText(["0803123 500", "08031234567", "08031234567 500 1GB", "08031234567 mtn airtel 500"].join("\n"));
  assert.equal(bad.length, 4);
  assert.match(bad[0]!, /Line 1: "0803123 500" does not start with a Nigerian mobile number/);
  assert.match(bad[1]!, /Line 2: .* says a number but not what to buy/);
  assert.match(bad[2]!, /Line 3: say either an amount of airtime or one data bundle/);
  assert.match(bad[3]!, /Line 4: two networks named/);
  await fund(naira(10_000));
  await assert.rejects(buy("0803123 500\n08031234567 500"), /does not start with a Nigerian mobile number.*Nothing was bought/s);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
});

test("a shop buys for many customers in one go, charged from the wallet at the agent's rate", async () => {
  await fund(naira(10_000));
  const r = await buy(["08031234567 500", "08161234567 airtel 2GB", "08031234567 mtn-1gb", "08031234567 mtn-1gb-week"].join("\n"));
  assert.equal(r.lines, 4);
  assert.deepEqual(r.states, ["paid", "paid", "paid", "paid"]);
  // 500 + 1000 + 600 + 500 at face value, two percent off each.
  assert.equal(r.total, naira(490) + naira(980) + naira(588) + naira(490));
  assert.equal(await walletBalance(pool, agent.id), naira(10_000) - r.total);
  assert.equal(await balance(pool, "owed:buyers"), r.total);
  const orders = (await pool.query("SELECT network_code, recipient_number, bundle_id, batch_id FROM orders ORDER BY id")).rows;
  assert.deepEqual(orders.map((o) => o.network_code), ["MTN", "AIRTEL", "MTN", "MTN"], "the network comes from the number unless the line says otherwise");
  assert.ok(orders.every((o) => o.batch_id === 1), "every order belongs to the list");
  assert.deepEqual(orders.map((o) => o.bundle_id), [null, 3, 1, 2], "a size names the one bundle that size on that network, and a code names it outright");
});

test("a list larger than the wallet buys nothing at all and names the line that stopped it", async () => {
  await fund(naira(1_000));
  await assert.rejects(buy(["08031234567 500", "08031234567 500", "08031234567 500"].join("\n")), /Line 3 \(08031234567 N500\).*Nothing in this list was bought/s);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_batches")).rows[0].n, 0);
  assert.equal(await walletBalance(pool, agent.id), naira(1_000), "nothing left the wallet");
});

test("the same list sent twice buys once", async () => {
  await fund(naira(5_000));
  const first = await buy("08031234567 500\n08031234567 500");
  assert.equal(first.total, naira(980));
  const again = await as("test", (c) => buyInBulk(c, agent, "test", { reference: "BK-ABCD2345", text: "08031234567 500\n08031234567 500" }));
  assert.equal(again.created, false);
  assert.equal(again.orders.length, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 2);
  assert.equal(await walletBalance(pool, agent.id), naira(5_000) - naira(980));
});

test("a list needs the network when the number does not say it, and refuses a bundle size that means two things", async () => {
  await fund(naira(5_000));
  await assert.rejects(buy("07001234567 500"), /Line 1: we do not know which network 07001234567 is on/);
  await assert.rejects(buy("08031234567 2GB"), /MTN has no bundle called 2GB/);
  await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb-night", name: "MTN 1GB night", sizeMb: 1024, priceKobo: naira(300) }));
  await assert.rejects(buy("08031234567 1GB"), /more than one 1GB bundle \(mtn-1gb-night, mtn-1gb-week, mtn-1gb\). Put the code you want/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 0);
});

test("the shop's pages buy a list, keep the list when a line is wrong, and show how the list is going", async () => {
  await fund(naira(5_000));
  const b = await agentBrowser();
  const form = await b.get("/agent/bulk");
  assert.match(form.text, /name="reference" value="BK-[A-Z0-9]{8}"/);
  const reference = /name="reference" value="(BK-[A-Z0-9]{8})"/.exec(form.text)![1]!;
  const typed = "08031234567 500\n0816123456 200";
  const wrong = await b.post("/agent/bulk", { reference, list: typed });
  assert.equal(wrong.status, 400);
  assert.match(problems(wrong.text).join(" "), /Line 2/);
  assert.match(wrong.text, /08031234567 500/, "the list they typed comes back with the problem");
  const good = await b.post("/agent/bulk", { reference, list: "08031234567 500\n08161234567 200" });
  assert.equal(good.status, 303);
  const page = await b.get(good.location!);
  assert.match(page.text, /Delivered<\/div><div class="value">0 of 2/);
  assert.match(page.text, /2 still on the way/);
  assert.match(page.text, /http-equiv="refresh"/);
  // Another agent's list is not theirs to read.
  const other = (await as("founder", (c) => createAgent(c, { name: "Someone else", phone: "08059998877", password: "another long password" }))).agent;
  assert.equal(other.id > 0, true);
  const mine = await pool.query("SELECT reference FROM agent_batches WHERE agent_id = $1", [agent.id]);
  const nosy = new Browser(base);
  await nosy.post("/agent/login", { phone: "08059998877", password: "another long password" }, false);
  const refused = await nosy.get(`/agent/list/${mine.rows[0]!.reference}`);
  assert.equal(refused.status, 404);
});

// --- the statement --------------------------------------------------------

test("a statement holds the opening balance, every movement and the closing balance, and its file opens in a spreadsheet", async () => {
  await fund(naira(2_000), "BNK-OPEN");
  await buy("08031234567 500");
  const st = await buildStatement(pool, agent, {});
  assert.equal(st.from, startOfLagosMonth());
  assert.equal(st.to, lagosToday());
  assert.equal(st.openingKobo, 0);
  assert.equal(st.closingKobo, naira(2_000) - naira(490));
  assert.deepEqual(st.lines.map((l) => l.kind), ["top_up", "purchase"]);
  assert.equal(st.lines[0]!.changeKobo, naira(2_000));
  assert.equal(st.lines[1]!.changeKobo, -naira(490));
  assert.equal(st.lines[1]!.balanceKobo, naira(1_510));
  assert.equal(st.totals.purchase.count, 1);
  assert.equal(st.purchasedFaceKobo, naira(500));
  assert.equal(st.savedKobo, naira(10));
  const csv = movementsCsv(st);
  assert.match(csv, /^Date,Kind,Entry,Reference,Money in,Money out,Balance\r\n/);
  assert.match(csv, /Opening balance on \d{4}-\d{2}-\d{2},,,,0\.00/);
  assert.match(csv, /Top-up,.*,2000\.00,,2000\.00/);
  assert.match(csv, /,490\.00,1510\.00/);
  assert.match(purchasesCsv(st), /MTN,08031234567,500\.00,10\.00,490\.00,wallet,paid/);
});

test("what each movement was is read from our own keys, not from words a person can change", () => {
  assert.equal(kindOf("agent:7:topup:BNK-1"), "top_up");
  assert.equal(kindOf("order:RT-ABCD2345:wallet"), "purchase");
  assert.equal(kindOf("transfer:12:commission"), "commission");
  assert.equal(kindOf("withdrawal:3:paid"), "withdrawal");
  assert.equal(kindOf("order:9:refund"), "refund");
  assert.equal(kindOf("admin:pool:MTN"), "adjustment");
});

test("a cell that a spreadsheet would run as a formula is written so it cannot", async () => {
  await as("founder", (c) => topUpWallet(c, agent.id, { reference: "=cmd|' /c calc'!A1", paidKobo: naira(100), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }));
  const csv = movementsCsv(await buildStatement(pool, agent, {}));
  assert.match(csv, /,'=cmd\|' \/c calc'!A1,/, "the cell is written with an apostrophe in front of it");
  assert.ok(!/,=cmd/.test(csv), "no cell starts with an equals sign");
});

test("a statement asks for real dates and refuses a period that runs backwards", async () => {
  await assert.rejects(buildStatement(pool, agent, { from: "last monday" }), /should be a date like/);
  await assert.rejects(buildStatement(pool, agent, { from: "2026-02-30" }), /not a real date/);
  await assert.rejects(buildStatement(pool, agent, { from: "2026-03-01", to: "2026-02-01" }), /start date is after the end date/);
});

test("the shop downloads its statement as a file, and the command centre can pull the same one", async () => {
  await fund(naira(1_000));
  await buy("08031234567 500");
  const b = await agentBrowser();
  const page = await b.get("/agent/statement");
  assert.match(page.text, /Closing on/);
  assert.match(page.text, /Your margin on it/);
  const file = await fetch(`${base}/agent/statement/download?what=movements`, { redirect: "manual" });
  assert.equal(file.status, 303, "a file is not handed out without a login");
  const mine = await fetch(`${base}/agent/statement/download?what=movements`, { headers: { cookie: b.cookieHeader() }, redirect: "manual" });
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get("content-disposition") ?? "", /attachment; filename="telco-[2-9A-HJKMNP-Z]{5}-movements-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}.csv"/);
  assert.match(await mine.text(), /Top-up,.*,1000\.00,,1000\.00/);
  const a = new Browser(base);
  await a.login();
  const admin = await a.get(`/admin/agents/${agent.id}/statement?what=purchases`);
  assert.equal(admin.status, 200);
  assert.match(admin.text, /^Date,Reference,Batch,Network/);
});

// --- the credit line -----------------------------------------------------

test("an agent with a credit line buys past an empty wallet, and the wallet shows what they owe", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(100_000));
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(2_000) }));
  const room = await spendable(pool, agent.id);
  assert.equal(room.freeKobo, naira(2_000));
  assert.equal(room.creditFreeKobo, naira(2_000));
  const b = await agentBrowser();
  const bought = await b.post("/agent/buy", { number: "08031234567", network: "MTN", amount: "1000", bundle: "" });
  assert.equal(bought.status, 303);
  assert.equal(await walletBalance(pool, agent.id), -naira(980));
  const after = await spendable(pool, agent.id);
  assert.equal(after.owedKobo, naira(980));
  assert.equal(after.creditFreeKobo, naira(1_020));
  assert.ok(after.owingSince !== null, "we know when they started owing");
  const wallet = await b.get("/agent");
  assert.match(wallet.text, /You owe N980 on your credit line/);
  assert.match(wallet.text, /Your credit line is N2,000, of which N1,020 is left/);
  // Past the limit is refused with the figures.
  const tooMuch = await b.post("/agent/buy", { number: "08031234567", network: "MTN", amount: "2000", bundle: "" });
  assert.equal(tooMuch.status, 400);
  assert.match(problems(tooMuch.text).join(" "), /credit line of N2,000 has N1,020 left. That leaves N1,020 to spend and this costs N1,960/);
});

test("a credit line cannot be given above the ceiling, nor at all until the ceiling is set", async () => {
  await assert.rejects(as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(1_000) })), /No credit line can be given until you set the largest/);
  await as("founder", (c) => setSetting(c, "founder", "agent.credit_max_kobo", naira(5_000)));
  await assert.rejects(as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(6_000) })), /largest credit line one agent may have is N5,000/);
  assert.equal((await agentTerms(pool, agent.id)).creditLimitKobo, 0);
});

test("with credit switched off the line cannot be drawn on, and what is owed still stands", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(10_000));
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(2_000) }));
  await buy("08031234567 500");
  await as("founder", (c) => setSetting(c, "founder", "agent.credit_enabled", false));
  const room = await spendable(pool, agent.id);
  assert.match(room.creditClosed!, /Credit lines are paused/);
  assert.equal(room.freeKobo, -naira(490), "nothing is free to spend while they owe");
  assert.equal(room.owedKobo, naira(490), "what they owe is untouched");
  await assert.rejects(buy("08031234567 500", "BK-SECOND22"), /Credit lines are paused/);
});

test("an agent who has owed for longer than allowed cannot draw on the line until they clear it", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(10_000));
    await setSetting(c, "founder", "agent.credit_days", 7);
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(2_000) }));
  await buy("08031234567 500");
  // Eight days later, the line has closed itself.
  const later = new Date(Date.now() + 8 * 86_400_000);
  const room = await spendable(pool, agent.id, later);
  assert.match(room.creditClosed!, /longer than the 7 days allowed/);
  assert.equal(room.freeKobo, -naira(490));
  // Topping up enough to clear it opens the line again.
  await fund(naira(500));
  const cleared = await spendable(pool, agent.id, later);
  assert.equal(cleared.owedKobo, 0);
  assert.equal(cleared.owingSince, null);
  assert.equal(cleared.creditClosed, null);
  assert.equal(cleared.freeKobo, naira(10) + naira(2_000));
});

test("a credit line is never money to take out in cash", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(10_000));
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(5_000) }));
  const b = await agentBrowser();
  await b.get("/agent/withdraw");
  const empty = await b.post("/agent/withdraw", { amount: "1000", bank: "GTB 0123456789 Nkechi" });
  assert.equal(empty.status, 400);
  assert.match(problems(empty.text).join(" "), /Your wallet is empty, so there is nothing to withdraw/);
  await buy("08031234567 500");
  await b.get("/agent/withdraw");
  const owing = await b.post("/agent/withdraw", { amount: "100", bank: "GTB 0123456789 Nkechi" });
  assert.equal(owing.status, 400);
  assert.match(problems(owing.text).join(" "), /you owe N490 and there is nothing to withdraw/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_withdrawals")).rows[0].n, 0);
});

test("the command centre shows what agents owe us and warns when credit is on with no ceiling", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "agent.credit_enabled", true);
    await setSetting(c, "founder", "agent.credit_max_kobo", naira(10_000));
  });
  await as("founder", (c) => setAgentTerms(c, agent.id, { discountBasisPoints: null, commissionBasisPoints: null, creditLimitKobo: naira(2_000) }));
  await buy("08031234567 500");
  const b = new Browser(base);
  await b.login();
  const list = await b.get("/admin/agents");
  assert.match(list.text, /Owed to us on credit<\/div><div class="value">N490/);
  assert.match(list.text, /Credit lines given<\/div><div class="value">N2,000/);
  await as("founder", (c) => setSetting(c, "founder", "agent.credit_max_kobo", 0));
  const warned = await b.get("/admin/agents");
  assert.match(oks(warned.text).join(" "), /largest one an agent may have is still zero/);
  const one = await b.get(`/admin/agents/${agent.id}`);
  assert.match(one.text, /Owed to us<\/dt><dd><strong>N490/);
});

test("a reference made from the agent's own is the same every time, and different for another agent", () => {
  assert.equal(batchReferenceFor(1, "till-42"), batchReferenceFor(1, "till-42"));
  assert.notEqual(batchReferenceFor(1, "till-42"), batchReferenceFor(2, "till-42"));
  assert.match(batchReferenceFor(1, "till-42"), /^BK-[2-9A-HJKMNP-Z]{12}$/);
});
