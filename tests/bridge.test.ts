import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createDevice, parseNetworkMessage } from "../src/bridge.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { setSetting } from "../src/settings.ts";
import { getTransfer, quoteTransfer } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, pool } from "./helpers/db.ts";
import { Browser, oks, problems, seedAdmin, startServer } from "./helpers/web.ts";

let base = "";
let server: Server;
before(async () => ({ base, server } = await startServer()));
after(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE bridge_messages, bridge_devices, admin_sessions, admins RESTART IDENTITY CASCADE");
  await seedAdmin();
});

const SAMPLES = [
  "You have received N500.00 airtime from 2348031234567. Your new balance is N612.50.",
  "Dear Customer, you have received 1,500 Naira from 08031234567 via Share n Sell.",
  "Airtime transfer received: NGN250 from +234 803 123 4567. Thank you.",
];

test("the built-in pattern reads the amount and the sender from the ways networks word it", () => {
  const expected = [naira(500), naira(1_500), naira(250)];
  SAMPLES.forEach((body, i) => {
    const parsed = parseNetworkMessage(body, "");
    assert.ok(!("problem" in parsed), `${body}: ${"problem" in parsed ? parsed.problem : ""}`);
    if ("problem" in parsed) return;
    assert.equal(parsed.amountKobo, expected[i]);
    assert.equal(parsed.senderNumber, "08031234567");
  });
});

test("a message that is not about airtime is not read as airtime", () => {
  for (const body of ["Your data bundle expires tomorrow.", "You have received a new voicemail from 08031234567.", "Recharge successful. Balance N50."]) {
    const parsed = parseNetworkMessage(body, "");
    assert.ok("problem" in parsed, body);
  }
});

test("a custom pattern replaces the built-in one and a bad pattern says why", () => {
  const custom = "Credited (?<amount>[\\d,.]+) by (?<sender>\\d{11})";
  const parsed = parseNetworkMessage("Credited 750.00 by 08051234567 at 10:00", custom);
  assert.deepEqual(parsed, { amountKobo: naira(750), senderNumber: "08051234567" });
  assert.match((parseNetworkMessage("anything", "(?<amount>[") as { problem: string }).problem, /not valid/);
  assert.match((parseNetworkMessage("Credited 750 by 08051234567", "Credited (?<amount>\\d+)") as { problem: string }).problem, /no \(\?<sender>/);
});

async function phone(network = "MTN", label = "MTN phone") {
  const { device, token } = await as("founder", (c) => createDevice(c, label, network));
  const send = (messages: unknown, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/bridge/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages, appVersion: "1.0", battery: 81, queueSize: 0, ...extra }),
    });
  return { device, token, send };
}

test("a phone with a wrong token is turned away and told what to do, even when other phones exist", async () => {
  await phone();
  const r = await fetch(`${base}/bridge/messages`, { method: "POST", headers: { authorization: "Bearer brg_nope", "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  assert.equal(r.status, 401);
  assert.match(((await r.json()) as { error: string }).error, /Create the phone again/);
});

test("airtime the phone reports is matched to the waiting transfer and booked, and the phone is marked as heard from", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const p = await phone();
  const r = await p.send([{ from: "MTN", body: SAMPLES[0], receivedAt: new Date().toISOString() }]);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { results: { outcome: string; transferReference?: string }[] };
  assert.equal(body.results[0]!.outcome, "matched");
  assert.equal(body.results[0]!.transferReference, transfer.reference);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "inbound_confirmed");
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
  const d = await pool.query("SELECT last_seen_at, battery, app_version FROM bridge_devices WHERE id = $1", [p.device.id]);
  assert.ok(d.rows[0].last_seen_at);
  assert.equal(d.rows[0].battery, 81);
  assert.equal(d.rows[0].app_version, "1.0");
});

test("the same batch sent twice by a phone with a bad connection books nothing twice", async () => {
  await addReceivingNumber("08039990001", "MTN");
  await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const p = await phone();
  const msg = { from: "MTN", body: SAMPLES[0], receivedAt: "2026-09-17T10:00:00Z" };
  await p.send([msg]);
  const again = (await (await p.send([msg])).json()) as { results: { outcome: string }[] };
  assert.equal(again.results[0]!.outcome, "duplicate");
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
  const n = await pool.query("SELECT count(*)::int AS n FROM bridge_messages");
  assert.equal(n.rows[0].n, 1);
});

test("a message that looks like airtime but cannot be read is kept for a person; ordinary messages are kept quietly", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const p = await phone();
  const r = (await (await p.send([
    { from: "MTN", body: "You have received something we cannot read" },
    { from: "Bank", body: "Your statement is ready." },
  ])).json()) as { results: { outcome: string }[] };
  assert.deepEqual(r.results.map((x) => x.outcome), ["unparsed", "ignored"]);
  const b = new Browser(base);
  await b.login();
  const pageText = (await b.get("/admin/bridge")).text;
  assert.match(pageText, /did not understand \(1\)/);
  assert.match(pageText, /cannot read/);
});

test("airtime arriving on a network with no receiving number is kept for a person with the reason", async () => {
  const p = await phone("GLO", "Glo phone");
  const r = (await (await p.send([{ from: "Glo", body: SAMPLES[0] }])).json()) as { results: { outcome: string }[] };
  assert.equal(r.results[0]!.outcome, "unparsed");
  const m = await pool.query("SELECT note FROM bridge_messages");
  assert.match(m.rows[0].note, /No active receiving number on GLO/);
});

test("a paused phone is turned away", async () => {
  const p = await phone();
  await pool.query("UPDATE bridge_devices SET active = false WHERE id = $1", [p.device.id]);
  assert.equal((await p.send([])).status, 401);
});

test("a malformed batch is refused with a plain message and nothing is recorded", async () => {
  const p = await phone();
  const r = await p.send([{ nope: true }]);
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /each message needs from and body/);
  const big = await p.send(Array.from({ length: 101 }, () => ({ from: "x", body: "y" })));
  assert.equal(big.status, 400);
});

test("creating a phone in the command centre shows its token once and never stores it", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/bridge");
  const r = await b.post("/admin/bridge", { network: "AIRTEL", label: "Airtel phone" });
  const token = /<code>(brg_[A-Za-z0-9_-]+)<\/code>/.exec(r.text)?.[1];
  assert.ok(token, "token shown");
  const stored = await pool.query("SELECT token_hash FROM bridge_devices");
  assert.notEqual(stored.rows[0].token_hash, token);
  assert.doesNotMatch(JSON.stringify((await pool.query("SELECT after FROM audit_log WHERE table_name = 'bridge_devices'")).rows), new RegExp(token!));
  const again = await b.get("/admin/bridge");
  assert.doesNotMatch(again.text, /brg_/);
  const ok = await fetch(`${base}/bridge/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  assert.equal(ok.status, 200);
});

test("the pattern tester reads a pasted message with the pattern in force or one being tried", async () => {
  const b = new Browser(base);
  await b.login();
  await b.get("/admin/bridge");
  const builtIn = await b.post("/admin/bridge/try", { network: "MTN", body: SAMPLES[1]!, pattern: "" });
  assert.match(oks(builtIn.text).join(" "), /Read as N1,500 from 08031234567/);
  const custom = await b.post("/admin/bridge/try", { network: "MTN", body: "Credited 750 by 08051234567", pattern: "Credited (?<amount>\\d+) by (?<sender>\\d{11})" });
  assert.match(oks(custom.text).join(" "), /Read as N750 from 08051234567/);
  const bad = await b.post("/admin/bridge/try", { network: "MTN", body: "nothing here", pattern: "" });
  assert.match(problems(bad.text).join(" "), /did not match/);
});

test("a saved custom pattern is what the phone's messages are read with", async () => {
  await addReceivingNumber("08039990001", "MTN");
  await as("founder", (c) => setSetting(c, "founder", "network.inbound_pattern", { MTN: "Credited (?<amount>[\\d,.]+) by (?<sender>\\d{11})", AIRTEL: "", GLO: "", "9MOBILE": "" }));
  await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(500) }));
  const p = await phone();
  const r = (await (await p.send([{ from: "MTN", body: "Credited 500 by 08031234567" }])).json()) as { results: { outcome: string }[] };
  assert.equal(r.results[0]!.outcome, "matched");
});

test("the launch checklist says which network's phone is missing or quiet", async () => {
  await addReceivingNumber("08039990001", "MTN");
  const b = new Browser(base);
  await b.login();
  const before = (await b.get("/admin/checklist")).text;
  assert.match(before, /MTN has no phone forwarding its messages/);
  const p = await phone();
  await p.send([]);
  const after = (await b.get("/admin/checklist")).text;
  assert.match(after, /MTN phone is reporting/);
  await pool.query("UPDATE bridge_devices SET last_seen_at = now() - interval '2 hours'");
  const quiet = (await b.get("/admin/checklist")).text;
  assert.match(quiet, /MTN phone has gone quiet/);
  assert.match(quiet, /battery saving is off/);
});
