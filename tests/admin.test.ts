import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { getSetting } from "../src/settings.ts";
import { createAdmin } from "../src/auth.ts";
import { getTransfer, quoteTransfer, recordInbound } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { ADMIN, Browser, oks, problems, seedAdmin, startServer } from "./helpers/web.ts";

let base = "";
let server: Server;
before(async () => ({ base, server } = await startServer()));
after(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE admin_sessions, admins RESTART IDENTITY CASCADE");
  await seedAdmin();
});

const pages = ["/admin", "/admin/transfers", "/admin/inbound", "/admin/pools", "/admin/numbers", "/admin/settings", "/admin/checklist", "/admin/audit"];

test("nobody sees the command centre without logging in", async () => {
  const b = new Browser(base);
  for (const p of pages) {
    const r = await b.get(p);
    assert.equal(r.status, 303, p);
    assert.equal(r.location, `/admin/login?next=${encodeURIComponent(p)}`);
  }
});

test("a wrong password for a real administrator is refused with a message that says what to do, and no session is given", async () => {
  // A second administrator, so the delay after a wrong password does not slow the other tests.
  await as("test", (c) => createAdmin(c, { email: "second@example.com", name: "Second", password: "a different long password" }));
  const b = new Browser(base);
  const r = await b.login("second@example.com", "not the password at all");
  assert.equal(r.status, 401);
  assert.match(problems(r.text)[0] ?? "", /do not match/);
  assert.equal((await b.get("/admin")).status, 303);
  const sessions = await pool.query("SELECT count(*)::int AS n FROM admin_sessions");
  assert.equal(sessions.rows[0].n, 0);
});

test("an email with no account is refused the same way, so the message gives nothing away", async () => {
  const b = new Browser(base);
  const r = await b.login("nobody@example.com", "whatever it might be");
  assert.equal(r.status, 401);
  assert.match(problems(r.text)[0] ?? "", /do not match/);
});

test("the right password opens the overview and the session survives across requests", async () => {
  const b = new Browser(base);
  const r = await b.login();
  assert.equal(r.status, 303);
  assert.equal(r.location, "/admin");
  const page = await b.get("/admin");
  assert.equal(page.status, 200);
  assert.match(page.text, /Log out Founder/);
});

test("logging out ends the session on the server, not just in the browser", async () => {
  const b = new Browser(base);
  await b.login();
  const before = await pool.query("SELECT count(*)::int AS n FROM admin_sessions");
  assert.equal(before.rows[0].n, 1);
  await b.post("/admin/logout", {});
  assert.equal((await b.get("/admin")).status, 303);
  const after = await pool.query("SELECT count(*)::int AS n FROM admin_sessions");
  assert.equal(after.rows[0].n, 0);
});

test("a form posted without the session's token is refused", async () => {
  const b = new Browser(base);
  await b.login();
  const r = await b.post("/admin/settings/fee.percent_basis_points", { value: "3" }, false);
  assert.equal(r.status, 403);
  assert.equal((await getSetting(pool, "fee.percent_basis_points")).source, "fallback");
});

test("a fee outside its range is refused on the page and nothing changes", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/settings");
  const r = await b.post("/admin/settings/fee.percent_basis_points", { value: "99" });
  assert.equal(r.status, 400);
  assert.match(problems(r.text).join(" "), /between 0 percent and 50 percent/);
  assert.equal((await getSetting(pool, "fee.percent_basis_points")).source, "fallback");
});

test("a setting saved from the page is in force and in the audit log under the administrator's email", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/settings");
  const r = await b.post("/admin/settings/fee.floor_kobo", { value: "25" });
  assert.equal(r.status, 200);
  assert.match(oks(r.text).join(" "), /Saved/);
  assert.equal((await getSetting(pool, "fee.floor_kobo")).value, naira(25));
  const audit = await pool.query("SELECT actor FROM audit_log WHERE table_name = 'settings'");
  assert.equal(audit.rows[0].actor, `admin:${ADMIN.email}`);
  const log = await b.get("/admin/audit?table=settings");
  assert.match(log.text, /admin:founder@example.com/);
});

test("per network settings are typed in naira per network and read back", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/settings");
  const r = await b.post("/admin/settings/pool.floor_kobo", { "value.MTN": "1,000", "value.AIRTEL": "2000", "value.GLO": "0", "value.9MOBILE": "0" });
  assert.equal(r.status, 200);
  assert.deepEqual((await getSetting(pool, "pool.floor_kobo")).value, { MTN: naira(1_000), AIRTEL: naira(2_000), GLO: 0, "9MOBILE": 0 });
});

test("a receiving number added on the page takes the next quote, and pausing it stops that", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/numbers");
  const r = await b.post("/admin/numbers", { network: "MTN", number: "0803 999 0001", label: "office phone", cap: "50000" });
  assert.match(oks(r.text).join(" "), /08039990001 on MTN is saved/);
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  assert.equal(transfer.receiving_number, "08039990001");
  await b.post("/admin/numbers/08039990001/toggle", {});
  await assert.rejects(
    as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) })),
    /No MTN number can take this transfer/,
  );
});

test("airtime recorded by hand matches the waiting transfer and the whole payout can be done from the transfer page", async () => {
  await addReceivingNumber("08039990001", "MTN");
  await fundPool("AIRTEL", naira(5_000));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/inbound");
  const recorded = await b.post("/admin/inbound", { network: "MTN", receiving: "08039990001", sender: "08031234567", amount: "500", raw: "You have received N500.00 from 08031234567. Ref 1." });
  assert.match(oks(recorded.text).join(" "), new RegExp(`matched to ${transfer.reference}`));

  const detail = await b.get(`/admin/transfers/${transfer.reference}`);
  assert.match(detail.text, /Start payout by hand/);
  const started = await b.post(`/admin/transfers/${transfer.id}/payout/start`, {});
  assert.match(oks(started.text).join(" "), /send N480 of AIRTEL airtime to 08021234567/);
  const done = await b.post(`/admin/transfers/${transfer.id}/payout/done`, { reference: "AIRTEL-1" });
  assert.match(oks(done.text).join(" "), /is complete/);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "completed");
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(4_520));

  const overview = await b.get("/admin");
  assert.match(overview.text, /Our fees today<\/div><div class="value">N20/);
});

test("a payout recorded as done twice from the page books once and says so the second time", async () => {
  await addReceivingNumber("08039990001", "MTN");
  await fundPool("AIRTEL", naira(5_000));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(500), rawText: "received", source: "bridge" }));
  const b = new Browser(base);
  await b.login();
  await b.get(`/admin/transfers/${transfer.id}`);
  await b.post(`/admin/transfers/${transfer.id}/payout/start`, {});
  await b.post(`/admin/transfers/${transfer.id}/payout/done`, { reference: "A-1" });
  const again = await b.post(`/admin/transfers/${transfer.id}/payout/done`, { reference: "A-1" });
  assert.equal(again.status, 200);
  assert.match(problems(again.text).join(" "), /not paying out, so nothing was recorded/);
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
});

test("airtime that arrived with no quote can be matched to a transfer by its reference", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/inbound");
  const r = await b.post("/admin/inbound", { network: "MTN", receiving: "08039990001", sender: "08031234567", amount: "500", raw: "stray" });
  assert.match(oks(r.text).join(" "), /No transfer was waiting/);
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const n = await pool.query("SELECT id FROM inbound_notifications");
  const wrong = await b.post(`/admin/inbound/${n.rows[0].id}/attach`, { reference: "TX-NOPE" });
  assert.match(problems(wrong.text).join(" "), /no transfer with reference TX-NOPE/);
  const right = await b.post(`/admin/inbound/${n.rows[0].id}/attach`, { reference: transfer.reference.toLowerCase() });
  assert.match(oks(right.text).join(" "), /now inbound confirmed/);
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
});

test("float recorded on the pools page books once even when the form is submitted twice", async () => {
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/pools");
  const key = /name="key" value="([^"]+)"/.exec(page.text)![1]!;
  const first = await b.post("/admin/pools/fund", { account: "pool:GLO", amount: "3,000", note: "bought, receipt 9", key });
  assert.match(oks(first.text).join(" "), /Recorded N3,000 added to the GLO pool/);
  const second = await b.post("/admin/pools/fund", { account: "pool:GLO", amount: "3,000", note: "bought, receipt 9", key });
  assert.match(oks(second.text).join(" "), /not booked twice/);
  assert.equal(await balance(pool, "pool:GLO"), naira(3_000));
  const loss = await b.post("/admin/pools/loss", { account: "pool:GLO", amount: "200", note: "SIM barred", key: key + "x" });
  assert.match(oks(loss.text).join(" "), /Recorded N200 lost from the GLO pool/);
  assert.equal(await balance(pool, "pool:GLO"), naira(2_800));
  assert.equal(await balance(pool, "expense:losses"), naira(200));
});

test("the launch checklist reads live state and says exactly what to do", async () => {
  const b = new Browser(base);
  await b.login();
  const before = await b.get("/admin/checklist");
  assert.match(before.text, /MTN has no receiving number/);
  assert.match(before.text, /Receiving numbers: add the number of our SIM/);
  assert.match(before.text, /MTN transfer code is not set/);
  await addReceivingNumber("08039990001", "MTN");
  await b.get("/admin/settings");
  await b.post("/admin/settings/network.transfer_code", { "value.MTN": "*321*{pin}*{amount}*{number}#", "value.AIRTEL": "", "value.GLO": "", "value.9MOBILE": "" });
  const after = await b.get("/admin/checklist");
  assert.match(after.text, /MTN has a receiving number/);
  assert.match(after.text, /MTN transfer code is set/);
  assert.match(after.text, /AIRTEL transfer code is not set/);
});

test("the health check knocks on the database", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("a transfer waiting for airtime shows the sender what they were told to dial", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/settings");
  await b.post("/admin/settings/network.transfer_code", { "value.MTN": "*321*{pin}*{amount}*{number}#", "value.AIRTEL": "", "value.GLO": "", "value.9MOBILE": "" });
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const detail = await b.get(`/admin/transfers/${transfer.id}`);
  assert.match(detail.text, /\*321\*PIN\*500\*08039990001#/);
});

test("every value written into a page is escaped", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/inbound");
  await b.post("/admin/inbound", { network: "MTN", receiving: "08039990001", sender: "08031234567", amount: "500", raw: "<script>alert(1)</script>" });
  const page = await b.get("/admin/inbound");
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;alert/);
});
