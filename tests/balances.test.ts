import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { acceptDifference, askForBalance, dueForCheck, queueDueChecks, readBalance, recordBalanceAnswer, latestChecks } from "../src/balances.ts";
import { buildApp } from "../src/app.ts";
import { createDevice } from "../src/bridge.ts";
import { runChecklist } from "../src/checklist.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { fetchCommands, getCommand, reportResult } from "../src/sendingphone.ts";
import { setSetting } from "../src/settings.ts";
import { quoteTransfer, recordInbound, startPayout } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
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

let deviceId = 0;
let token = "";
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE balance_checks, phone_commands, bridge_messages, bridge_devices, admin_sessions, admins RESTART IDENTITY CASCADE");
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  await as("founder", async (c) => {
    await setSetting(c, "founder", "network.balance_code", { MTN: "*310#", AIRTEL: "", GLO: "", "9MOBILE": "" });
    await setSetting(c, "founder", "network.transfer_code", { MTN: "*600*{pin}*{amount}*{number}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  });
  const made = await as("founder", (c) => createDevice(c, "MTN phone", "MTN"));
  deviceId = made.device.id;
  token = made.token;
  // A phone that can send: allowed to call, PIN entered, seen just now.
  await pool.query("UPDATE bridge_devices SET can_send = true, pin_set = true, last_seen_at = now() WHERE id = $1", [deviceId]);
});

// The phone's half of a check: it fetches the command, dials, and posts
// back what the network said.
const answer = (id: number, response: string, ok = true) =>
  as("bridge", async (c) => {
    await fetchCommands(c, deviceId);
    const command = await reportResult(c, deviceId, id, ok ? { ok, response } : { ok, failure: response });
    return recordBalanceAnswer(c, command!);
  });

// --- reading what the network says ---------------------------------------

test("the balance in a network's own words is read, whatever way they word it", () => {
  const cases: [string, number][] = [
    ["Your balance is N1,234.56. Thank you for using MTN.", naira(1_234) + 56],
    ["Bal: N50.00 valid till 31/12/2026", naira(50)],
    ["Airtime balance NGN 0.00", 0],
    ["Your main account balance is 2,500 naira", naira(2_500)],
  ];
  for (const [text, kobo] of cases) {
    const read = readBalance(text, "");
    assert.deepEqual(read, { kobo }, text);
  }
  assert.match((readBalance("Thanks for calling.", "") as { problem: string }).problem, /does not say a balance/);
  assert.deepEqual(readBalance("You now have 900 units", "have (?<amount>[\\d,.]+) units"), { kobo: naira(900) });
  assert.match((readBalance("anything", "(?<amount>[") as { problem: string }).problem, /not valid/);
});

// --- asking ---------------------------------------------------------------

test("asking for a balance queues the network's own code for the phone, and nothing is sent", async () => {
  const { check, command } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  assert.equal(check.state, "asked");
  assert.equal(check.network_code, "MTN");
  assert.equal(command.kind, "check_balance");
  assert.equal(command.code, "*310#");
  assert.equal(command.amount_kobo, 0, "a balance check moves no money");
  assert.equal(command.number, "");
  assert.equal(command.state, "queued");
});

test("a network with no balance code, and a network with no phone, each say so rather than failing quietly", async () => {
  await assert.rejects(as("founder", (c) => askForBalance(c, "founder", "AIRTEL")), /No phone on AIRTEL can dial/);
  await pool.query("UPDATE bridge_devices SET network_code = 'AIRTEL' WHERE id = $1", [deviceId]);
  await assert.rejects(as("founder", (c) => askForBalance(c, "founder", "AIRTEL")), /No balance code is set for AIRTEL/);
  await assert.rejects(as("founder", (c) => askForBalance(c, "founder", "SOMETHING")), /Choose a network/);
  // A phone nobody has heard from is not asked to dial anything, however
  // the asking started.
  await pool.query("UPDATE bridge_devices SET network_code = 'MTN', last_seen_at = now() - interval '2 hours' WHERE id = $1", [deviceId]);
  await assert.rejects(as("founder", (c) => askForBalance(c, "founder", "MTN")), /No phone on MTN can dial right now/);
});

test("a result posted for a command the phone never dialled writes nothing down", async () => {
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  // No fetch, so the command is still queued: the phone cannot have dialled
  // it, whatever a client claims.
  const after = await as("bridge", async (c) => {
    const command = await reportResult(c, deviceId, check.command_id, { ok: true, response: "Your balance is N99,000.00" });
    return recordBalanceAnswer(c, command!);
  });
  assert.equal(after!.state, "asked", "the check is still waiting for a real answer");
  assert.equal(after!.reported_kobo, null);
  assert.equal(after!.raw_text, null);
});

test("a balance code that is not a code a SIM may dial is refused, like every other code", async () => {
  await as("founder", (c) => setSetting(c, "founder", "network.balance_code", { MTN: "**123#", AIRTEL: "", GLO: "", "9MOBILE": "" }));
  await assert.rejects(as("founder", (c) => askForBalance(c, "founder", "MTN")), /does not read as a code a SIM may dial/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM phone_commands")).rows[0].n, 0);
});

// --- the answer -----------------------------------------------------------

test("the answer is put beside the books, with what is already on its way out taken off", async () => {
  await fundPool("MTN", naira(10_000));
  // A payout that has left the SIM and not yet left the ledger.
  await addReceivingNumber("08029990001", "AIRTEL");
  await fundPool("AIRTEL", naira(5_000));
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "AIRTEL", toNetwork: "MTN", senderNumber: "08021234567", recipientNumber: "08031234567", amountKobo: naira(1_000) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "AIRTEL", receivingNumber: "08029990001", senderNumber: "08021234567", amountKobo: naira(1_000), rawText: "received N1000 from 08021234567", source: "bridge" }));
  await as("worker", (c) => startPayout(c, "worker", transfer.id, { fundingAccount: "pool:MTN", rail: "phone", requestId: "r-1" }));

  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  const after = (await answer(check.command_id, "Your balance is N9,000.00 valid till 31/12/2026"))!;
  assert.equal(after.state, "answered");
  assert.equal(after.reported_kobo, naira(9_000));
  assert.equal(after.ledger_kobo, naira(10_000));
  assert.equal(after.committed_kobo, naira(960), "the payout has left the SIM but not the ledger");
  assert.equal(after.difference_kobo, naira(9_000) - (naira(10_000) - naira(960)));
  assert.equal((await getCommand(pool, check.command_id))!.state, "confirmed");
});

test("an answer we cannot read is kept word for word rather than guessed at", async () => {
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  const after = (await answer(check.command_id, "Welcome to MTN. 1. Buy data 2. Call me back"))!;
  assert.equal(after.state, "unreadable");
  assert.equal(after.raw_text, "Welcome to MTN. 1. Buy data 2. Call me back");
  assert.equal(after.reported_kobo, null);
  assert.equal(after.difference_kobo, null, "nothing is put through the books on a guess");
  // A pattern for this network's words makes the next one readable.
  await as("founder", (c) => setSetting(c, "founder", "network.balance_pattern", { MTN: "you have (?<amount>[\\d,.]+)", AIRTEL: "", GLO: "", "9MOBILE": "" }));
  const second = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  const read = (await answer(second.check.command_id, "Hello, you have 2,500.00 on this line"))!;
  assert.equal(read.state, "answered");
  assert.equal(read.reported_kobo, naira(2_500));
});

test("a phone that could not dial leaves the check failed, not answered", async () => {
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  const after = (await answer(check.command_id, "USSD service unavailable, try again later", false))!;
  assert.equal(after.state, "failed");
  assert.match(after.raw_text!, /USSD service unavailable/);
});

test("a network text message never settles a balance check by accident", async () => {
  await as("founder", (c) => setSetting(c, "founder", "network.sender_ids", { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" }));
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  await pool.query("UPDATE phone_commands SET state = 'fetched' WHERE id = $1", [check.command_id]);
  const r = await fetch(`${base}/bridge/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ from: "MTN", body: "Transfer successful. N500.00 sent to 08031234567.", receivedAt: new Date().toISOString() }], appVersion: "1.0", battery: 70, queueSize: 0 }),
  });
  assert.equal(r.status, 200);
  assert.equal((await getCommand(pool, check.command_id))!.state, "fetched", "the balance check is still waiting for its own answer");
  assert.equal((await latestChecks(pool))["MTN"]!.state, "asked");
});

// --- putting a difference through the books ------------------------------

test("a difference the founder accepts moves the ledger to where the network says we are, once", async () => {
  await fundPool("MTN", naira(10_000));
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  await answer(check.command_id, "Your balance is N9,400.00");
  const accepted = await as("founder", (c) => acceptDifference(c, "founder", check.id, "airtime used for calls from this SIM"));
  assert.ok(accepted.accepted_at);
  assert.equal(await balance(pool, "pool:MTN"), naira(9_400), "the pool now says what the network says");
  assert.equal(await balance(pool, "expense:losses"), naira(600));
  await assert.rejects(as("founder", (c) => acceptDifference(c, "founder", check.id, "again")), /already been put through/);
  assert.equal(await balance(pool, "pool:MTN"), naira(9_400));
});

test("a SIM holding more than the books knew about is found money, not the founder's float", async () => {
  await fundPool("MTN", naira(1_000));
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  await answer(check.command_id, "Bal: N1,250.00");
  await as("founder", (c) => acceptDifference(c, "founder", check.id, "a promotion from MTN"));
  assert.equal(await balance(pool, "pool:MTN"), naira(1_250));
  assert.equal(await balance(pool, "revenue:adjustments"), naira(250));
  assert.equal(await balance(pool, "equity:float"), naira(1_000), "the founder did not put that in");
});

test("nothing can be accepted that was never answered, and a reason is always required", async () => {
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  await assert.rejects(as("founder", (c) => acceptDifference(c, "founder", check.id, "a reason")), /no readable balance/);
  await answer(check.command_id, "Your balance is N0.00");
  await assert.rejects(as("founder", (c) => acceptDifference(c, "founder", check.id, "")), /Say what the difference was/);
  await assert.rejects(as("founder", (c) => acceptDifference(c, "founder", 9_999, "a reason")), /no balance check with that id/);
});

test("a check where the SIM and the books agree has nothing to put through", async () => {
  await fundPool("MTN", naira(2_000));
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  const after = (await answer(check.command_id, "Your balance is N2,000.00"))!;
  assert.equal(after.difference_kobo, 0);
  await assert.rejects(as("founder", (c) => acceptDifference(c, "founder", check.id, "nothing")), /no difference to put through/);
});

// --- asking without being asked ------------------------------------------

test("the server asks each SIM on its own, as often as the founder set, and not before", async () => {
  assert.deepEqual(await dueForCheck(pool), [], "switched off to start with");
  await as("founder", (c) => setSetting(c, "founder", "phone.balance_check_minutes", 60));
  assert.deepEqual(await dueForCheck(pool), ["MTN"]);
  assert.deepEqual(await queueDueChecks(pool), ["MTN"]);
  assert.deepEqual(await dueForCheck(pool), [], "and not again within the hour");
  const later = new Date(Date.now() + 61 * 60_000);
  assert.deepEqual(await dueForCheck(pool, later), ["MTN"]);
  // A phone that has not reported in is not asked at all.
  await pool.query("UPDATE bridge_devices SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [deviceId]);
  assert.deepEqual(await dueForCheck(pool, later), []);
});

// --- the pages ------------------------------------------------------------

test("the Pools page asks, shows the answer beside the books, and puts the difference through", async () => {
  await fundPool("MTN", naira(5_000));
  const b = new Browser(base);
  await b.login();
  const empty = await b.get("/admin/pools");
  assert.match(empty.text, /never asked/);
  const asked = await b.post("/admin/pools/balance", { network: "MTN" });
  assert.match(oks(asked.text).join(" "), /Asked the MTN phone for its balance/);
  const check = (await latestChecks(pool))["MTN"]!;
  await answer(check.command_id, "Your balance is N4,500.00");
  const shown = await b.get("/admin/pools");
  assert.match(shown.text, /The SIM is N500 short of what the books expect/);
  assert.match(shown.text, /Your balance is N4,500.00/, "the network's own words are on the page");
  const accepted = await b.post(`/admin/pools/balance/${check.id}/accept`, { note: "calls made from this SIM" });
  assert.match(oks(accepted.text).join(" "), /The MTN pool now agrees with the SIM/);
  assert.equal(await balance(pool, "pool:MTN"), naira(4_500));
  const noNote = await b.post("/admin/pools/balance", { network: "GLO" });
  assert.match(problems(noNote.text).join(" "), /No phone on GLO can dial/);
});

test("the launch checklist says when the books and a network have drifted, and what to do", async () => {
  await fundPool("MTN", naira(10_000));
  const never = (await runChecklist(pool)).find((c) => c.title.includes("never been asked"));
  assert.equal(never?.status, "warn");
  assert.match(never!.fix!, /press Ask now/);
  const { check } = await as("founder", (c) => askForBalance(c, "founder", "MTN"));
  await answer(check.command_id, "Your balance is N9,000.00");
  const apart = (await runChecklist(pool)).find((c) => c.title.includes("apart"));
  assert.equal(apart?.status, "bad");
  assert.match(apart!.title, /N1,000 apart/);
  assert.match(apart!.fix!, /put the difference through the books/);
  await as("founder", (c) => acceptDifference(c, "founder", check.id, "calls"));
  const after = await runChecklist(pool);
  assert.equal(after.find((c) => c.title.includes("apart")), undefined, "accepted differences stop nagging");
  assert.equal(after.find((c) => c.title.includes("agrees with the ledger"))?.status, "ok");
});
