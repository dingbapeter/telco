import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createAgent } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { createAdmin, founderOnly, listAdmins } from "../src/auth.ts";
import { naira } from "../src/money.ts";
import { createOrder, getOrderByReference, recordPayment } from "../src/orders.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import { setSetting } from "../src/settings.ts";
import { as, clean, pool } from "./helpers/db.ts";
import { ADMIN, Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

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

const STAFF = { email: "ada@example.com", name: "Ada", password: "a long staff password", role: "staff" as const };
let agentId = 0;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE sellback_events, credit_notes, sellbacks, orders, order_events, payment_events, agent_sessions, admin_sessions, admins RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM ledger_accounts WHERE code LIKE 'agent:%'");
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  await seedAdmin();
  await as("founder", (c) => createAdmin(c, STAFF));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "agent.enabled", true);
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
  });
  agentId = (await as("founder", (c) => createAgent(c, { name: "Mama Nkechi", phone: "08051234567" }))).agent.id;
});

async function staffBrowser(): Promise<Browser> {
  const b = new Browser(base);
  const r = await b.login(STAFF.email, STAFF.password);
  assert.equal(r.status, 303, "staff can log in");
  await b.get("/admin");
  return b;
}

test("everybody who already had a login keeps every power, because taking one away unannounced locks somebody out of their job", async () => {
  const people = await listAdmins(pool);
  assert.equal(people.find((p) => p.email === ADMIN.email)?.role, "founder");
});

test("a staff member does the day's work: holds, money owed, and answering a customer", async () => {
  // An order paid too much is held, and releasing it is ordinary work.
  const order = await as("buyer", (c) => createOrder(c, "buyer", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: naira(500) }));
  await as("founder", (c) => recordPayment(c, "founder", order.id, { method: "bank_transfer", reference: "BNK-OVER", paidKobo: naira(600), feeKobo: 0, cashAccount: "cash:bank" }));
  assert.equal((await getOrderByReference(pool, order.reference))!.state, "held");
  const b = await staffBrowser();
  await b.get(`/admin/orders/${order.id}`);
  const released = await b.post(`/admin/orders/${order.id}/release`, {});
  assert.match(oks(released.text).join(" "), /back in the delivery queue/i);
  assert.equal((await getOrderByReference(pool, order.reference))!.state, "paid");
  // Money an agent paid in by bank transfer.
  await b.get(`/admin/agents/${agentId}`);
  const topped = await b.post(`/admin/agents/${agentId}/topup`, { amount: "2,000", reference: "BNK-1" });
  assert.match(oks(topped.text).join(" "), /added to the wallet/);
  // And finding a customer.
  const found = await b.get("/admin/find?q=08021234567");
  assert.equal(found.status, 200);
  assert.match(found.text, new RegExp(order.reference));
});

test("a staff member is turned away from the founder's things, and told who can do them", async () => {
  const b = await staffBrowser();
  const refused: [string, Record<string, string>, RegExp][] = [
    ["/admin/settings/fee.percent_basis_points", { value: "9" }, /changing fees, rates, limits and switches/i],
    ["/admin/pools/fund", { account: "pool:MTN", amount: "1000", note: "cash", key: "abc" }, /money or airtime put into the business/i],
    ["/admin/pools/loss", { account: "pool:MTN", amount: "1000", note: "lost", key: "abc" }, /writing value off the books/i],
    ["/admin/pools/balance/1/accept", { note: "calls" }, /difference between a SIM and the books/i],
    [`/admin/agents/${agentId}/terms`, { discount: "9", commission: "", credit: "" }, /agent(&#39;|')s rates and credit line/i],
    ["/admin/sellbacks/credit/void", { code: "CR-X", reason: "fraud" }, /stopping credit somebody is holding/i],
    ["/admin/bridge", { label: "A phone", network: "MTN" }, /setting up a phone/i],
    ["/admin/people", { name: "Someone", email: "someone@example.com", role: "founder" }, /adding people/i],
  ];
  for (const [path, fields, why] of refused) {
    const r = await b.post(path, fields);
    assert.equal(r.status, 403, `${path} is refused`);
    assert.match(problems(r.text).join(" "), why, path);
    assert.match(problems(r.text).join(" "), /kept for the founder/i, path);
  }
  // Nothing of theirs was changed by the attempts.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM settings WHERE key = 'fee.percent_basis_points'")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT discount_basis_points FROM agents WHERE id = $1", [agentId])).rows[0].discount_basis_points, null);
  // The People page is not even offered to them.
  const page = await b.get("/admin");
  assert.doesNotMatch(page.text, /href="\/admin\/people"/);
  assert.equal((await b.get("/admin/people")).status, 403);
});

test("a staff member reads every setting and changes none", async () => {
  const b = await staffBrowser();
  const page = await b.get("/admin/settings");
  assert.equal(page.status, 200);
  assert.match(page.text, /Fee percentage/, "the figures are all there");
  assert.match(page.text, /Changing one is kept for the founder/);
  assert.doesNotMatch(page.text, /<button type="submit">Save<\/button>/, "and no way to change one");
});

test("the founder adds somebody, is shown their password once, and can take the keys back", async () => {
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/people");
  assert.match(page.text, /Kept for a founder/);
  const added = await b.post("/admin/people", { name: "Chidi", email: "chidi@example.com", role: "staff" });
  const shown = /<code>([^<]+)<\/code>/.exec(added.text);
  assert.ok(shown, "the first password is shown once");
  const chidi = (await listAdmins(pool)).find((p) => p.email === "chidi@example.com")!;
  assert.equal(chidi.role, "staff");
  const theirs = new Browser(base);
  assert.equal((await theirs.login("chidi@example.com", shown![1]!)).status, 303, "and it works");
  const again = await b.get("/admin/people");
  assert.doesNotMatch(again.text, new RegExp(shown![1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and never again");
  // Made a founder, then paused, which puts them out at once.
  await b.post(`/admin/people/${chidi.id}/role`, { role: "founder" });
  assert.equal((await listAdmins(pool)).find((p) => p.id === chidi.id)?.role, "founder");
  const paused = await b.post(`/admin/people/${chidi.id}/toggle`, {});
  assert.match(oks(paused.text).join(" "), /put out of the command centre/);
  assert.equal((await theirs.get("/admin")).status, 303, "their session is gone, not merely expiring");
});

test("nobody can take away their own powers, and the last founder cannot be made staff", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/people");
  const me = (await listAdmins(pool)).find((p) => p.email === ADMIN.email)!;
  const self = await b.post(`/admin/people/${me.id}/role`, { role: "staff" });
  assert.match(problems(self.text).join(" "), /cannot change what you yourself may do/);
  assert.equal((await listAdmins(pool)).find((p) => p.id === me.id)?.role, "founder");
  const pause = await b.post(`/admin/people/${me.id}/toggle`, {});
  assert.match(problems(pause.text).join(" "), /cannot pause your own login/);
  assert.equal((await listAdmins(pool)).find((p) => p.id === me.id)?.active, true);
});

test("with two founders, neither may take away their own powers or put themselves out", async () => {
  await as("founder", (c) => createAdmin(c, { email: "second@example.com", name: "Second", password: "another long password", role: "founder" }));
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/people");
  const me = (await listAdmins(pool)).find((p) => p.email === ADMIN.email)!;
  const other = (await listAdmins(pool)).find((p) => p.email === "second@example.com")!;
  const self = await b.post(`/admin/people/${me.id}/role`, { role: "staff" });
  assert.match(problems(self.text).join(" "), /cannot change what you yourself may do/);
  assert.equal((await listAdmins(pool)).find((p) => p.id === me.id)?.role, "founder");
  const selfPause = await b.post(`/admin/people/${me.id}/toggle`, {});
  assert.match(problems(selfPause.text).join(" "), /cannot pause your own login/);
  // The other founder, though, may be made staff, because somebody is left.
  const them = await b.post(`/admin/people/${other.id}/role`, { role: "staff" });
  assert.match(oks(them.text).join(" "), /may now do the day(&#39;|')s work/);
  assert.equal((await listAdmins(pool)).find((p) => p.id === other.id)?.role, "staff");
});

test("the rule about what is kept for the founder is one list, and it says what it covers", () => {
  assert.equal(founderOnly("POST", "/admin/settings/fee.flat_kobo"), "changing fees, rates, limits and switches");
  assert.equal(founderOnly("GET", "/admin/settings"), undefined, "reading a setting is not changing one");
  assert.equal(founderOnly("POST", "/admin/pools/balance/3/accept"), "putting a difference between a SIM and the books through the ledger");
  assert.equal(founderOnly("POST", "/admin/pools/balance"), undefined, "asking a SIM its balance is the day's work");
  assert.equal(founderOnly("POST", "/admin/agents/7/terms"), "setting an agent's rates and credit line");
  assert.equal(founderOnly("POST", "/admin/agents/7/topup"), undefined, "recording money an agent paid in is the day's work");
  assert.equal(founderOnly("POST", "/admin/bridge"), "setting up a phone, which hands out a token");
  assert.equal(founderOnly("POST", "/admin/bridge/commands/4/resolve"), undefined, "reading a phone and settling a command is the day's work");
  assert.equal(founderOnly("POST", "/admin/sellbacks/credit/void"), "stopping credit somebody is holding");
  assert.equal(founderOnly("POST", "/admin/sellbacks/credit"), undefined, "looking a credit code up is the day's work");
});
