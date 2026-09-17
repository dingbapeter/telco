import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { createDevice } from "../src/bridge.ts";
import { upsertBundle, type Bundle } from "../src/bundles.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { createOrder, getOrder, recordPayment } from "../src/orders.ts";
import { expireCommands, PhoneRail, readSentConfirmation } from "../src/sendingphone.ts";
import { setSetting } from "../src/settings.ts";
import { failPayout, getTransfer, quoteTransfer, recordInbound, startPayout, startRefund } from "../src/transfers.ts";
import { chooseRail, runDeliveryCycle, runPayoutCycle } from "../src/worker.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { FakeVtpass } from "./helpers/vtpass.ts";
import { Browser, oks, seedAdmin } from "./helpers/web.ts";

const vt = new FakeVtpass();
let base = "";
let server: Server;
before(async () => {
  await vt.start();
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  vt.stop();
  await pool.end();
});

type Phone = { id: number; token: string; post: (path: string, body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }> };
async function phone(network: string, label = `${network} phone`, options: { canSend?: boolean; pinSet?: boolean } = {}): Promise<Phone> {
  const { device, token } = await as("founder", (c) => createDevice(c, label, network));
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await post("/bridge/messages", { messages: [], canSend: options.canSend ?? true, pinSet: options.pinSet ?? true });
  return { id: device.id, token, post };
}

let airtel1gb: Bundle;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE phone_commands, orders, order_events, bridge_messages, bridge_devices, data_bundles, admin_sessions, admins RESTART IDENTITY CASCADE");
  vt.calls = [];
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  await addReceivingNumber("08029990001", "AIRTEL");
  await as("founder", async (c) => {
    await setSetting(c, "founder", "payout.automatic", true);
    await setSetting(c, "founder", "network.transfer_code", { MTN: "*321*{pin}*{amount}*{number}#", AIRTEL: "*432*{amount}*{number}#", GLO: "", "9MOBILE": "" });
    await setSetting(c, "founder", "network.data_gift_code", { MTN: "", AIRTEL: "*141*{number}*{size}#", GLO: "", "9MOBILE": "" });
  });
  airtel1gb = await as("founder", (c) => upsertBundle(c, { network: "AIRTEL", code: "airtel-1gb", name: "Airtel 1GB", sizeMb: 1024, priceKobo: naira(500), giftable: true }));
});

async function confirmedTransfer(to = "AIRTEL", amount = 500) {
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: to, senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(amount) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(amount), rawText: `r ${Math.random()}`, source: "bridge" }));
  return transfer;
}

const rails = () => ({ provider: undefined, phone: new PhoneRail(pool) });

test("the network's sent confirmation is read for the number it went to", () => {
  assert.deepEqual(readSentConfirmation("You have successfully transferred N480.00 to 2348021234567. Ref 1", ""), { number: "08021234567" });
  assert.deepEqual(readSentConfirmation("Airtime sent to 0802 123 4567", ""), { number: "08021234567" });
  assert.ok("problem" in readSentConfirmation("Your balance is N50", ""));
  assert.deepEqual(readSentConfirmation("Done: 08021234567 got it", "Done: (?<number>\\d{11})"), { number: "08021234567" });
});

test("with the network routed to the phone, a payout is queued as a command with the PIN left for the phone, and completes when the phone reports the network's confirmation", async () => {
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" }));
  const p = await phone("AIRTEL");
  const t = await confirmedTransfer();
  const first = await runPayoutCycle(pool, rails());
  assert.equal(first.sent, 1);
  let now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "paying_out");
  assert.equal(now.payout_rail, "phone");
  const fetched = (await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number; code: string; number: string; amountKobo: number }[] };
  assert.equal(fetched.commands.length, 1);
  const cmd = fetched.commands[0]!;
  assert.equal(cmd.code, "*432*480*08021234567#");
  assert.equal(cmd.amountKobo, naira(480));
  // Handed out once.
  assert.equal(((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: unknown[] }).commands.length, 0);
  const reported = await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "You have successfully transferred N480.00 to 08021234567." });
  assert.deepEqual(await reported.json(), { ok: true, state: "confirmed" });
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const second = await runPayoutCycle(pool, rails());
  assert.equal(second.delivered, 1);
  now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "completed");
  assert.equal(now.payout_reference, `phone:${cmd.id}`);
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(5_000 - 480));
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
});

test("the PIN placeholder stays in the code the server stores and sends; the phone fills it in", async () => {
  await fundPool("MTN", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "phone", AIRTEL: "provider", GLO: "provider", "9MOBILE": "provider" }));
  const p = await phone("MTN");
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "AIRTEL", toNetwork: "MTN", senderNumber: "08021234567", recipientNumber: "08031234567", amountKobo: naira(500) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "AIRTEL", receivingNumber: "08029990001", senderNumber: "08021234567", amountKobo: naira(500), rawText: "r", source: "bridge" }));
  await runPayoutCycle(pool, rails());
  const fetched = (await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { code: string }[] };
  assert.equal(fetched.commands[0]!.code, "*321*{pin}*480*08031234567#");
  const stored = await pool.query("SELECT code FROM phone_commands");
  assert.equal(stored.rows[0].code, "*321*{pin}*480*08031234567#");
  void transfer;
});

test("a reply that is not a confirmation waits for the network's text message, which settles it", async () => {
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" }));
  const p = await phone("AIRTEL");
  const t = await confirmedTransfer();
  await runPayoutCycle(pool, rails());
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number }[] }).commands[0]!;
  const r = await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "Your request is being processed." });
  assert.deepEqual(await r.json(), { ok: true, state: "dialled" });
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const still = await runPayoutCycle(pool, rails());
  assert.equal(still.delivered, 0);
  assert.equal((await getTransfer(pool, t.id))!.state, "paying_out");
  const sms = (await (await p.post("/bridge/messages", { messages: [{ from: "Airtel", body: "You have transferred N480 to 08021234567 successfully." }] })).json()) as { results: { outcome: string }[] };
  assert.equal(sms.results[0]!.outcome, "ignored");
  assert.equal((await pool.query("SELECT state FROM phone_commands WHERE id = $1", [cmd.id])).rows[0].state, "confirmed");
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const done = await runPayoutCycle(pool, rails());
  assert.equal(done.delivered, 1);
});

test("a confirmation naming a different number does not settle the command", async () => {
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" }));
  const p = await phone("AIRTEL");
  await confirmedTransfer();
  await runPayoutCycle(pool, rails());
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number }[] }).commands[0]!;
  const r = await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "You have successfully transferred N480.00 to 08099999999." });
  assert.deepEqual(await r.json(), { ok: true, state: "dialled" });
  const sms = (await (await p.post("/bridge/messages", { messages: [{ from: "Airtel", body: "Transferred N480 to 08099999999 successfully." }] })).json()) as { results: { outcome: string }[] };
  assert.notEqual(sms.results[0]!.outcome, "ignored");
  assert.equal((await pool.query("SELECT state FROM phone_commands WHERE id = $1", [cmd.id])).rows[0].state, "dialled");
});

test("a final refusal from the network fails the payout for a person; a busy network is retried", async () => {
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" }));
  const p = await phone("AIRTEL");
  const t = await confirmedTransfer();
  await runPayoutCycle(pool, rails());
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number }[] }).commands[0]!;
  await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "Invalid PIN. Transaction not allowed." });
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const r = await runPayoutCycle(pool, rails());
  assert.equal(r.failed, 1);
  let now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "payout_failed");
  assert.equal(now.payout_next_attempt_at, null);
  assert.match(now.payout_last_error!, /Invalid PIN/);
  // A busy network: retried after a wait.
  const t2 = await confirmedTransfer();
  await runPayoutCycle(pool, rails());
  const cmd2 = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number }[] }).commands[0]!;
  await p.post(`/bridge/commands/${cmd2.id}/result`, { ok: false, failure: "USSD service unavailable, try again later" });
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const r2 = await runPayoutCycle(pool, rails());
  assert.equal(r2.retried, 1);
  now = (await getTransfer(pool, t2.id))!;
  assert.equal(now.state, "payout_failed");
  assert.ok(now.payout_next_attempt_at);
});

test("a command with no confirmation in time is never dialled again: it is left for a person, who settles it from the command centre", async () => {
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" });
    await setSetting(c, "founder", "phone.command_timeout_minutes", 5);
  });
  const p = await phone("AIRTEL");
  const t = await confirmedTransfer();
  await runPayoutCycle(pool, rails());
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number }[] }).commands[0]!;
  await pool.query("UPDATE phone_commands SET fetched_at = now() - interval '6 minutes'");
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const r = await runPayoutCycle(pool, rails());
  assert.equal(r.failed, 1);
  assert.equal((await pool.query("SELECT state FROM phone_commands WHERE id = $1", [cmd.id])).rows[0].state, "unknown");
  const now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "payout_failed");
  assert.match(now.payout_last_error!, /read the phone and settle it by hand/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM phone_commands")).rows[0].n, 1);
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin/bridge");
  assert.match(page.text, /It went through/);
  const settled = await b.post(`/admin/bridge/commands/${cmd.id}/resolve`, { outcome: "confirmed" });
  assert.match(oks(settled.text).join(" "), /marked as gone through/);
  assert.equal((await pool.query("SELECT state, resolved_by FROM phone_commands WHERE id = $1", [cmd.id])).rows[0].resolved_by, "admin:founder@example.com");
});

test("a refund goes back through the phone on the sender's network and is booked once the network confirms", async () => {
  await fundPool("AIRTEL", naira(5_000));
  const p = await phone("MTN");
  const t = await confirmedTransfer();
  await as("w", (c) => startPayout(c, "w", t.id));
  await as("w", (c) => failPayout(c, "w", t.id, "recipient barred"));
  await as("founder", (c) => startRefund(c, "founder", t.id));
  const r = await runPayoutCycle(pool, rails());
  assert.equal(r.sent, 1);
  let now = (await getTransfer(pool, t.id))!;
  assert.equal(now.refund_rail, "phone");
  assert.ok(now.refund_request_id);
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number; code: string; number: string }[] }).commands[0]!;
  assert.equal(cmd.number, "08031234567");
  assert.equal(cmd.code, "*321*{pin}*500*08031234567#");
  await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "Transferred N500 to 08031234567" });
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const r2 = await runPayoutCycle(pool, rails());
  assert.equal(r2.delivered, 1);
  now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "refunded");
  assert.equal(await balance(pool, "owed:senders"), 0);
  assert.equal(await balance(pool, "pool:MTN"), 0);
});

test("without a sending phone, a refund waits for a person and nothing is queued", async () => {
  await fundPool("AIRTEL", naira(5_000));
  const t = await confirmedTransfer();
  await as("w", (c) => startPayout(c, "w", t.id));
  await as("w", (c) => failPayout(c, "w", t.id, "x"));
  await as("founder", (c) => startRefund(c, "founder", t.id));
  const r = await runPayoutCycle(pool, rails());
  assert.match(r.skipped.join(" "), /refund waits for a person; no phone on MTN can send/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM phone_commands")).rows[0].n, 0);
});

test("a phone that cannot send, has no PIN, or has gone quiet is not used", async () => {
  await as("founder", (c) => setSetting(c, "founder", "payout.route", { MTN: "provider", AIRTEL: "phone", GLO: "provider", "9MOBILE": "provider" }));
  await phone("AIRTEL", "no permission", { canSend: false });
  assert.equal((await chooseRail(pool, rails(), "AIRTEL")).rail, undefined);
  await phone("AIRTEL", "no pin", { canSend: true, pinSet: false });
  assert.equal((await chooseRail(pool, rails(), "AIRTEL")).rail, undefined);
  const p = await phone("AIRTEL", "good");
  assert.equal((await chooseRail(pool, rails(), "AIRTEL")).rail?.name, "phone");
  await pool.query("UPDATE bridge_devices SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [p.id]);
  const choice = await chooseRail(pool, rails(), "AIRTEL");
  assert.equal(choice.rail, undefined);
  assert.match((choice as { reason: string }).reason, /routed to the phone and no phone on AIRTEL can send/);
});

test("a bundle the provider does not know is gifted from the phone, from the data pool", async () => {
  await fundPool("datapool:AIRTEL", naira(2_000));
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", true));
  const p = await phone("AIRTEL");
  const o = await as("buyer", (c) => createOrder(c, "buyer", { network: "AIRTEL", recipientNumber: "08021234567", bundleId: airtel1gb.id }));
  await as("admin", (c) => recordPayment(c, "admin", o.id, { method: "bank_transfer", reference: "B", paidKobo: naira(500), feeKobo: 0, cashAccount: "cash:bank" }));
  const r = await runDeliveryCycle(pool, rails());
  assert.equal(r.sent, 1);
  const cmd = ((await (await p.post("/bridge/commands/fetch", {})).json()) as { commands: { id: number; kind: string; code: string }[] }).commands[0]!;
  assert.equal(cmd.kind, "gift_data");
  assert.equal(cmd.code, "*141*08021234567*Airtel 1GB#");
  await p.post(`/bridge/commands/${cmd.id}/result`, { ok: true, response: "You have shared Airtel 1GB with 08021234567" });
  await pool.query("UPDATE order_events SET at = at - interval '2 minutes'");
  const r2 = await runDeliveryCycle(pool, rails());
  assert.equal(r2.delivered, 1);
  assert.equal((await getOrder(pool, o.id))!.state, "delivered");
  assert.equal(await balance(pool, "datapool:AIRTEL"), naira(1_500));
});

test("expiring commands touches only those still waiting", async () => {
  const p = await phone("AIRTEL");
  await pool.query("INSERT INTO phone_commands (device_id, network_code, kind, number, amount_kobo, code, purpose, state, fetched_at) VALUES ($1, 'AIRTEL', 'send_airtime', '08021234567', 100, 'x', 'a', 'fetched', now() - interval '20 minutes'), ($1, 'AIRTEL', 'send_airtime', '08021234567', 100, 'x', 'b', 'confirmed', now() - interval '20 minutes'), ($1, 'AIRTEL', 'send_airtime', '08021234567', 100, 'x', 'c', 'queued', NULL)", [p.id]);
  assert.equal(await expireCommands(pool, 10), 1);
  const states = (await pool.query("SELECT purpose, state FROM phone_commands ORDER BY purpose")).rows.map((r) => `${r.purpose}:${r.state}`);
  assert.deepEqual(states, ["a:unknown", "b:confirmed", "c:queued"]);
});
