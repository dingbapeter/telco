import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { getOrderByReference } from "../src/orders.ts";
import { getSellbackByReference } from "../src/sellbacks.ts";
import { setSetting } from "../src/settings.ts";
import { getTransferByReference, recordInbound, startPayout, completePayout } from "../src/transfers.ts";
import { advance, fitScreen, MENU, SCREEN_LIMIT, spaced, stateWord, type Session } from "../src/ussd.ts";
import { closeIdleUssdSessions, ussdConfigFromEnv } from "../src/web/ussd.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { Dialler } from "./helpers/ussd.ts";
import { Browser, seedAdmin } from "./helpers/web.ts";

// The dialled service, driven the way the aggregator will drive it: one
// keypress at a time over HTTP, with no browser anywhere.

const SECRET = "a-long-shared-secret-from-the-aggregator";
const CALLER = "08031234567";
const RECIPIENT = "08021234567";
const OUR_MTN = "08039990001";
let base = "";
let server: Server;

before(async () => {
  const app = buildApp(pool, {
    secureCookies: false,
    publicBaseUrl: "https://telco.example",
    ussd: { secret: SECRET, inputStyle: "cumulative", responseStyle: "con_end" },
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE ussd_sessions, orders, order_events, sellbacks, sellback_events, credit_notes, admin_sessions, admins RESTART IDENTITY CASCADE");
  await seedAdmin();
  await addReceivingNumber(OUR_MTN, "MTN");
  await fundPool("AIRTEL", naira(5_000));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "ussd.enabled", true);
    await setSetting(c, "founder", "ussd.service_code", "*347*55#");
    await setSetting(c, "founder", "network.transfer_code", { MTN: "*600*{pin}*{amount}*{number}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  });
});

const dialler = (options: Partial<ConstructorParameters<typeof Dialler>[0]> = {}) => new Dialler({ base, secret: SECRET, network: "MTN", ...options });

// --- the whole journey ----------------------------------------------------

test("a caller sends airtime across networks from the dial pad alone, and it is a real transfer", async () => {
  const d = dialler();
  const menu = await d.dial();
  assert.equal(menu.status, 200);
  assert.equal(menu.done, false);
  assert.match(menu.text, /1 Send airtime to another network/);

  const asksNumber = await d.press("1");
  assert.match(asksNumber.text, /Enter the number that will RECEIVE/);

  const asksNetwork = await d.press(RECIPIENT);
  assert.match(asksNetwork.text, /Which network is 0802 123 4567 on\?/);
  assert.match(asksNetwork.text, /2 Airtel \(we think\)/, "the prefix is offered as a guess, never used on its own");

  const asksAmount = await d.press("2");
  assert.match(asksAmount.text, /How much airtime to send\?/);
  assert.match(asksAmount.text, /From N100 to N10,000/);

  const confirm = await d.press("500");
  assert.match(confirm.text, /Check carefully/);
  assert.match(confirm.text, /N500 from your MTN line/);
  assert.match(confirm.text, /to 0802 123 4567 \(Airtel\)/);
  assert.match(confirm.text, /Fee N20, they get N480/, "the real fee from the fee engine");
  assert.equal(confirm.done, false);

  const sent = await d.press("1");
  assert.equal(sent.done, true, "the session ends so the caller can dial their network's code");
  const reference = /Ref (TX-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)?.[1];
  assert.ok(reference, `a reference is on the last screen: ${sent.text}`);
  assert.match(sent.text, /Now dial \*600\*PIN\*500\*08039990001# on your MTN line/);
  assert.match(sent.text, /PIN is your own transfer PIN. We never ask for it/);
  assert.match(sent.text, /We send N480 as soon as MTN confirms/);

  // The transfer is indistinguishable from one made on the website.
  const t = (await getTransferByReference(pool, reference!))!;
  assert.equal(t.state, "awaiting_inbound");
  assert.equal(t.sender_number, CALLER);
  assert.equal(t.recipient_number, RECIPIENT);
  assert.equal(t.from_network, "MTN");
  assert.equal(t.to_network, "AIRTEL");
  assert.equal(t.requested_kobo, naira(500));
  assert.equal(t.quoted_payout_kobo, naira(480));
  assert.equal(t.receiving_number, OUR_MTN);

  // And it completes through the ordinary rails.
  await as("bridge", (c) =>
    recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: OUR_MTN, senderNumber: CALLER, amountKobo: naira(500), rawText: `You have received N500 from ${CALLER}`, source: "bridge" }),
  );
  await as("worker", (c) => startPayout(c, "worker", t.id));
  await as("worker", (c) => completePayout(c, "worker", t.id, "VTP-1"));
  const done = (await getTransferByReference(pool, reference!))!;
  assert.equal(done.state, "completed");
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
});

test("the caller can read the state of that transfer back from the dial pad", async () => {
  const first = dialler();
  await first.dial();
  await first.press("1");
  await first.press(RECIPIENT);
  await first.press("2");
  await first.press("500");
  const sent = await first.press("1");
  const reference = /Ref (TX-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)![1]!;

  const second = dialler();
  await second.dial();
  await second.press("4");
  const state = await second.press(reference.toLowerCase());
  assert.equal(state.done, true);
  assert.match(state.text, new RegExp(`${reference}: waiting for your airtime`));
  assert.match(state.text, /N500 to 0802 123 4567 on Airtel/);

  const third = dialler();
  await third.dial();
  const recent = await third.press("5");
  assert.match(recent.text, /Your last sends:/);
  assert.match(recent.text, /N500 to Airtel: waiting for your airtime/);
});

// --- what the aggregator does on a bad line -------------------------------

test("a keypress the aggregator sends twice is answered once and creates one transfer", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const sent = await d.press("1");
  const again = await d.retry();
  assert.equal(again.text, sent.text, "the same question gets the same answer");
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transfers");
  assert.equal(rows[0]!.n, 1, "one transfer, not two");
});

test("a repeated keypress earlier in the journey does not advance the session", async () => {
  const d = dialler();
  await d.dial();
  const first = await d.press("1");
  const repeat = await d.retry();
  assert.equal(repeat.text, first.text);
  const asksNetwork = await d.press(RECIPIENT);
  assert.match(asksNetwork.text, /Which network/, "the journey carries on from where it really was");
});

test("a session the network has dropped starts again at the first screen", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  // The caller walked away. The network drops the session and the row ages.
  await pool.query("UPDATE ussd_sessions SET last_seen_at = now() - interval '2 hours'");
  const back = await d.press(RECIPIENT);
  assert.match(back.text, /1 Send airtime to another network/, "and not a number question with no context");
});

test("the keypress convention of the other kind of aggregator works too", async () => {
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example", ussd: { secret: SECRET, inputStyle: "keypress", responseStyle: "json" } });
  const other = app.listen(0);
  await new Promise<void>((r) => other.once("listening", r));
  const a = other.address();
  const otherBase = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  try {
    const k = new Dialler({ base: otherBase, secret: SECRET, style: "keypress", responseStyle: "json", network: "MTN" });
    await k.dial();
    const asksNumber = await k.press("1");
    // One key at a time gives nothing to compare, so the same key moments
    // later is the aggregator asking again and must not be acted on twice.
    assert.equal((await k.retry()).text, asksNumber.text);
    await k.press(RECIPIENT);
    await k.press("2");
    const confirm = await k.press("500");
    assert.match(confirm.text, /Fee N20, they get N480/);
    const sent = await k.press("1");
    assert.equal(sent.done, true);
    assert.match(sent.text, /Now dial \*600\*PIN\*500\*08039990001#/);
  } finally {
    other.close();
  }
});

test("an aggregator that posts JSON instead of a form is understood", async () => {
  const d = dialler();
  const menu = await d.sendAsJson("");
  assert.match(menu.text, /1 Send airtime/);
});

// --- the door --------------------------------------------------------------

test("the wrong shared secret, or none, is refused", async () => {
  const d = dialler();
  const wrong = await d.send("", { secret: "not-the-secret" });
  assert.equal(wrong.status, 401);
  // The same length as the real one, because a comparison that only checks
  // the length would let this through and is the easy mistake to make here.
  const sameLength = await d.send("", { secret: "x".repeat(SECRET.length) });
  assert.equal(sameLength.status, 401);
  const none = await fetch(`${base}/ussd`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "sessionId=x&phoneNumber=08031234567&text=" });
  assert.equal(none.status, 401);
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ussd_sessions")).rows[0]!.n, 0);
});

test("with the service switched off, callers are told so and sent to the website", async () => {
  await as("founder", (c) => setSetting(c, "founder", "ussd.enabled", false));
  const screen = await dialler().dial();
  assert.equal(screen.done, true);
  assert.match(screen.text, /not open at the moment/);
  assert.match(screen.text, /website/);
});

test("a short code that is not ours is not answered", async () => {
  const screen = await dialler({ serviceCode: "*123*9#" }).dial();
  assert.equal(screen.done, true);
  assert.match(screen.text, /not ours/);
});

test("a session with no readable caller number cannot go on", async () => {
  const screen = await dialler({ msisdn: "12345" }).dial();
  assert.equal(screen.done, true);
  assert.match(screen.text, /cannot read the number you are dialling from/);
});

test("with no secret on the server the address does not exist", async () => {
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example" });
  const closed = app.listen(0);
  await new Promise<void>((r) => closed.once("listening", r));
  const a = closed.address();
  try {
    const res = await fetch(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/ussd`, { method: "POST", body: "sessionId=x" });
    assert.equal(res.status, 404);
  } finally {
    closed.close();
  }
  assert.equal(ussdConfigFromEnv({}), undefined);
  assert.deepEqual(ussdConfigFromEnv({ USSD_SHARED_SECRET: "s" }), { secret: "s", inputStyle: "cumulative", responseStyle: "con_end" });
  assert.deepEqual(ussdConfigFromEnv({ USSD_SHARED_SECRET: "s", USSD_INPUT_STYLE: "keypress", USSD_RESPONSE_STYLE: "json" }), { secret: "s", inputStyle: "keypress", responseStyle: "json" });
});

// --- what a caller keys wrongly -------------------------------------------

test("a wrong menu choice, a bad number and a bad amount all ask again without losing the session", async () => {
  const d = dialler();
  await d.dial();
  const again = await d.press("9");
  assert.match(again.text, /Choose 1 to 5/);
  assert.equal(again.done, false);
  await d.press("1");
  const badNumber = await d.press("12345");
  assert.match(badNumber.text, /not a Nigerian mobile number/);
  assert.equal(badNumber.done, false);
  await d.press(RECIPIENT);
  const badNetwork = await d.press("8");
  assert.match(badNetwork.text, /Choose a network/);
  await d.press("2");
  const badAmount = await d.press("five hundred");
  assert.match(badAmount.text, /not an amount/);
  const confirm = await d.press("500");
  assert.match(confirm.text, /Check carefully/, "and the journey is still intact");
});

test("sending to the caller's own network is refused with the reason", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press("08031112222");
  const same = await d.press("1");
  assert.match(same.text, /MTN can send to itself for free/);
  assert.equal(same.done, false, "so they can choose another network without dialling again");
});

test("cancelling at the confirmation leaves nothing behind", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const cancelled = await d.press("0");
  assert.equal(cancelled.done, true);
  assert.match(cancelled.text, /Cancelled. Nothing was taken/);
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transfers")).rows[0]!.n, 0);
});

test("changing the number at the confirmation goes back to the number question", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const changed = await d.press("2");
  assert.match(changed.text, /Enter the number that will RECEIVE/);
  await d.press("08029998888");
  await d.press("2");
  const confirm = await d.press("500");
  assert.match(confirm.text, /to 0802 999 8888/);
});

// --- the rules the website obeys apply here too ---------------------------

test("a cap refuses a dialled transfer with the reason that fits on a screen", async () => {
  await as("founder", (c) => setSetting(c, "founder", "transfer.sender_daily_max_kobo", naira(300)));
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const refused = await d.press("1");
  assert.equal(refused.done, true);
  assert.match(refused.text, /can move N300 a day/);
  assert.ok(refused.text.length <= SCREEN_LIMIT);
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transfers")).rows[0]!.n, 0);
  const outcome = (await pool.query<{ outcome: string }>("SELECT outcome FROM ussd_sessions LIMIT 1")).rows[0]!.outcome;
  assert.equal(outcome, "refused:over_daily_limit", "and the reason is on the session for the command centre to read");
});

test("the network's own daily cap is explained on the screen rather than refused silently", async () => {
  await as("founder", (c) => setSetting(c, "founder", "network.daily_transfer_cap_kobo", { MTN: naira(200), AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const refused = await d.press("1");
  assert.match(refused.text, /MTN only lets a subscriber transfer N200 in a day/);
});

// --- selling and buying ---------------------------------------------------

test("a caller sells airtime to us from the dial pad and is promised credit", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: 0, GLO: 0, "9MOBILE": 0 });
  });
  const d = dialler();
  await d.dial();
  const asks = await d.press("2");
  assert.match(asks.text, /How much airtime do you want to sell to us\?/);
  const confirm = await d.press("1000");
  assert.match(confirm.text, /N1,000 of MTN airtime/);
  assert.match(confirm.text, /You get credit to spend with us/);
  const sent = await d.press("1");
  assert.equal(sent.done, true);
  const reference = /Ref (SB-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)?.[1];
  assert.ok(reference, sent.text);
  assert.match(sent.text, /Dial \*600\*PIN\*1000\*08039990001# on your MTN line/);
  assert.match(sent.text, /You get N800 of credit when it lands/);
  const s = (await getSellbackByReference(pool, reference!))!;
  assert.equal(s.seller_number, CALLER);
  assert.equal(s.outcome, "credit", "cash needs bank details, which nobody should type into a dial pad");
  assert.equal(s.face_kobo, naira(1_000));
});

test("a caller buys airtime from the dial pad and is given the bank details and a reference", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "retail.bank_name", "Example Bank");
    await setSetting(c, "founder", "retail.bank_account_number", "0123456789");
    await setSetting(c, "founder", "retail.bank_account_name", "Telco Ltd");
  });
  const d = dialler();
  await d.dial();
  await d.press("3");
  await d.press(RECIPIENT);
  await d.press("2");
  const confirm = await d.press("500");
  assert.match(confirm.text, /Buy airtime:/);
  assert.match(confirm.text, /N500 of Airtel/);
  const paid = await d.press("1");
  const reference = /([A-Z]{2}-[2-9A-HJKMNP-Z]{8})/.exec(paid.text)?.[1];
  assert.ok(reference, paid.text);
  assert.match(paid.text, /Pay N500 to/);
  assert.match(paid.text, /Example Bank 0123456789/);
  assert.match(paid.text, new RegExp(`Put ${reference} as the narration`));
  const o = (await getOrderByReference(pool, reference!))!;
  assert.equal(o.recipient_number, RECIPIENT);
  assert.equal(o.price_kobo, naira(500));
});

test("buying when no bank details are set says so instead of taking an order nobody can pay", async () => {
  await as("founder", (c) => setSetting(c, "founder", "retail.enabled", true));
  const d = dialler();
  await d.dial();
  await d.press("3");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const screen = await d.press("1");
  assert.match(screen.text, /cannot take bank transfers yet/);
});

// --- the screens themselves ----------------------------------------------

test("every screen fits what a network will carry", async () => {
  // The limit is not a style rule. A longer screen is cut or refused by the
  // network, and which of those happens is not ours to find out.
  assert.ok(MENU.length <= SCREEN_LIMIT, `the menu is ${MENU.length}`);
  const seen: string[] = [];
  const d = dialler();
  seen.push((await d.dial()).text);
  seen.push((await d.press("1")).text);
  seen.push((await d.press(RECIPIENT)).text);
  seen.push((await d.press("2")).text);
  seen.push((await d.press("500")).text);
  seen.push((await d.press("1")).text);
  for (const screen of seen) assert.ok(screen.length <= SCREEN_LIMIT, `${screen.length} characters: ${screen}`);
});

test("a message too long for a screen is cut at a word and still ends in a full stop", () => {
  const long = `${"a".repeat(40)} ${"b".repeat(40)} ${"c".repeat(40)} ${"d".repeat(40)} ${"e".repeat(40)}`;
  const fitted = fitScreen(long);
  assert.ok(fitted.length <= SCREEN_LIMIT, String(fitted.length));
  assert.match(fitted, /d\.$/, "the last whole word is kept");
  assert.doesNotMatch(fitted, / $/);
  assert.doesNotMatch(fitted, /e/, "and the word it could not fit is dropped, not cut in half");
  assert.equal(fitScreen("  short  "), "short", "and a short one is left alone");
});

test("numbers and states are written the way a caller reads them", () => {
  assert.equal(spaced("08021234567"), "0802 123 4567");
  assert.equal(spaced("234802"), "234802");
  assert.equal(stateWord("awaiting_inbound"), "waiting for your airtime");
  assert.equal(stateWord("completed"), "done");
  assert.equal(stateWord("refunding"), "coming back to you");
  assert.equal(stateWord("something_new"), "something new", "an unknown state still reads as words");
});

// --- the record of what happened -----------------------------------------

test("every screen and keypress is kept, so a caller can be answered from what was really sent", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  const row = (await pool.query<{ transcript: { keyed?: string; screen: string }[]; keypresses: number; caller_number: string; network_code: string }>("SELECT transcript, keypresses, caller_number, network_code FROM ussd_sessions LIMIT 1")).rows[0]!;
  assert.equal(row.caller_number, CALLER);
  assert.equal(row.network_code, "MTN", "the network the session came in over, which the aggregator knows");
  assert.equal(row.keypresses, 2);
  assert.equal(row.transcript.length, 3, "the opening screen and both keypresses");
  assert.equal(row.transcript[1]!.keyed, "1");
  assert.match(row.transcript[2]!.screen, /Which network/);
});

test("a caller who keys for ever is stopped politely", async () => {
  const d = dialler();
  await d.dial();
  await pool.query("UPDATE ussd_sessions SET keypresses = 40");
  const stopped = await d.press("1");
  assert.equal(stopped.done, true);
  assert.match(stopped.text, /gone on a long time and nothing has been taken/);
});

test("where the aggregator does not say which network the caller is on, we ask", async () => {
  const d = dialler({ network: undefined });
  await d.dial();
  const asks = await d.press("1");
  assert.match(asks.text, /Which network are you sending FROM\?/);
  assert.match(asks.text, /1 MTN \(we think\)/, "with the prefix as a guess");
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  const confirm = await d.press("500");
  assert.match(confirm.text, /N500 from your MTN line/);
});

test("two callers dialling at the same moment keep their own sessions", async () => {
  const one = dialler({ msisdn: "08031234567" });
  const two = dialler({ msisdn: "08039876543" });
  await Promise.all([one.dial(), two.dial()]);
  await Promise.all([one.press("1"), two.press("1")]);
  await Promise.all([one.press("08021111111"), two.press("08022222222")]);
  const [a, b] = await Promise.all([one.press("2"), two.press("2")]);
  assert.match(a.text, /How much airtime to send/);
  assert.match(b.text, /How much airtime to send/);
  const rows = await pool.query<{ answers: { to: string } }>("SELECT answers FROM ussd_sessions ORDER BY caller_number");
  assert.deepEqual(
    rows.rows.map((r) => r.answers.to),
    ["08021111111", "08022222222"],
  );
});

// --- the session as a record ---------------------------------------------

test("a dial that has finished is never written over, however often the aggregator asks again", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const sent = await d.press("1");
  const reference = /Ref (TX-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)![1]!;

  // The network drops the line and the aggregator, which never heard our
  // answer, dials the whole thing again on the same session id.
  const nothingKeyed = await d.send("");
  assert.equal(nothingKeyed.done, true);
  assert.equal(nothingKeyed.text, sent.text, "the caller gets their reference back, not a fresh menu");
  const strayKey = await d.send("9");
  assert.equal(strayKey.text, sent.text);

  const rows = await pool.query<{ n: number; reference: string; outcome: string }>(
    "SELECT count(*)::int AS n, max(reference) AS reference, max(outcome) AS outcome FROM ussd_sessions",
  );
  assert.equal(rows.rows[0]!.n, 1, "one session, not a second one that lost the first");
  assert.equal(rows.rows[0]!.reference, reference, "and it still holds what it created");
  assert.equal(rows.rows[0]!.outcome, "sent");
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transfers")).rows[0]!.n, 1);
});

test("a session the network dropped keeps what happened in it when the same id comes back", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await pool.query("UPDATE ussd_sessions SET last_seen_at = now() - interval '2 hours'");

  const back = await d.press("1");
  assert.match(back.text, /1 Send airtime to another network/);
  const rows = await pool.query<{ ended_at: Date | null; outcome: string | null; answers: { to?: string }; keypresses: number }>(
    "SELECT ended_at, outcome, answers, keypresses FROM ussd_sessions ORDER BY started_at",
  );
  assert.equal(rows.rows.length, 2, "the dropped session is its own record");
  assert.ok(rows.rows[0]!.ended_at, "the dropped one is closed, so the open list is honest");
  assert.equal(rows.rows[0]!.outcome, "dropped");
  assert.equal(rows.rows[0]!.answers.to, RECIPIENT, "with the number the caller really keyed still in it");
  assert.equal(rows.rows[1]!.keypresses, 0, "and the new one is back at the first screen with nothing keyed");
});

test("the first two requests of one dial arriving together make one session", async () => {
  // A weak line, and the aggregator sends the opening request twice before
  // either answer gets back to it.
  const d = dialler();
  const [first, second] = await Promise.all([d.dial(), d.send("")]);
  // Whichever of the two got there first, both answers are the opening menu
  // and neither is a telling-off for keying nothing.
  assert.equal(first.text, MENU);
  assert.equal(second.text, MENU);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await d.send("")).text, MENU, "and the same again if the aggregator asks a third time");
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ussd_sessions")).rows[0]!.n, 1);

  const asksNumber = await d.press("1");
  assert.match(asksNumber.text, /Enter the number that will RECEIVE/, "and the journey carries on from the one session");
});

test("a stray key at a confirmation asks again rather than throwing the journey away", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: 0, GLO: 0, "9MOBILE": 0 });
  });
  const d = dialler();
  await d.dial();
  await d.press("2");
  const confirm = await d.press("500");
  assert.match(confirm.text, /Sell to us:/);
  const again = await d.press("7");
  assert.equal(again.done, false, "a fat finger does not end the session");
  assert.equal(again.text, confirm.text, "it asks the same question again");
  const sold = await d.press("1");
  assert.match(sold.text, /Ref SB-/);
});

test("an aggregator looping on one session is stopped by the same ceiling", async () => {
  const d = dialler();
  await d.dial();
  const asks = await d.press("1");
  // The same keypress, over and over, which keys nothing and so would
  // otherwise hold the session open for as long as the loop runs.
  for (let i = 0; i < 39; i++) assert.equal((await d.retry()).text, asks.text);
  const stopped = await d.retry();
  assert.equal(stopped.done, true);
  assert.match(stopped.text, /gone on a long time and nothing has been taken/);
  const row = (await pool.query<{ outcome: string; transcript: unknown[] }>("SELECT outcome, transcript FROM ussd_sessions")).rows[0]!;
  assert.equal(row.outcome, "too_many_keypresses");
  assert.equal(row.transcript.length, 2, "a retry keys nothing, so it does not fill the record");
});

test("sessions the network walked away from are closed, so the open list is the open ones", async () => {
  const stale = dialler();
  await stale.dial();
  const live = dialler();
  await live.dial();
  await pool.query("UPDATE ussd_sessions SET last_seen_at = now() - interval '20 minutes' WHERE session_id = $1", [stale.sessionId]);

  // The window is the setting the endpoint itself uses, so a session that
  // could still be carried on is never closed underneath the caller.
  await as("founder", (c) => setSetting(c, "founder", "ussd.session_minutes", 60));
  assert.equal(await closeIdleUssdSessions(pool), 0, "twenty minutes idle is nothing when a session lasts an hour");

  await as("founder", (c) => setSetting(c, "founder", "ussd.session_minutes", 5));
  assert.equal(await closeIdleUssdSessions(pool), 1);
  assert.equal(await closeIdleUssdSessions(pool), 0, "and closing twice closes nothing twice");
  const rows = await pool.query<{ session_id: string; outcome: string | null }>("SELECT session_id, outcome FROM ussd_sessions WHERE ended_at IS NOT NULL");
  assert.deepEqual(rows.rows, [{ session_id: stale.sessionId, outcome: "dropped" }]);
});

test("a request that is neither the same nor the next keypress is not guessed at", async () => {
  const d = dialler();
  await d.dial();
  const asksNumber = await d.press("1");
  // The aggregator has sent something that does not follow what we hold.
  // Working out which part of it is new would be guessing with somebody's
  // money, so the caller is asked the same question again.
  const outOfOrder = await d.send("5");
  assert.equal(outOfOrder.done, false);
  assert.equal(outOfOrder.text, asksNumber.text);
  const carriesOn = await d.press(RECIPIENT);
  assert.match(carriesOn.text, /Which network is 0802 123 4567 on\?/);
});

test("the aggregator's own spelling of a network is understood", async () => {
  for (const [spelling, expected] of [
    ["MTN-NG", "MTN"],
    ["Globacom", "Glo"],
    ["etisalat", "9mobile"],
    ["airtel_ng", "Airtel"],
  ] as const) {
    const d = dialler({ network: spelling });
    await d.dial();
    // Knowing the caller's network means not asking for it, which is one
    // screen fewer in a journey where every screen costs the caller time.
    const asks = await d.press("1");
    assert.match(asks.text, /Enter the number that will RECEIVE/, spelling);
    await d.press(RECIPIENT);
    const amount = await d.press(expected === "Airtel" ? "1" : "2");
    assert.match(amount.text, /How much airtime to send/, spelling);
    const confirm = await d.press("500");
    assert.match(confirm.text, new RegExp(`from your ${expected} line`), spelling);
  }
});

test("a confirmation that has already created something creates nothing a second time", async () => {
  // The last defence against a double charge. The endpoint answers a finished
  // dial from what it stored and never reaches the engine again, so this is
  // the engine being asked directly: confirm a session that already holds a
  // reference, and nothing new may appear.
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: 0, GLO: 0, "9MOBILE": 0 });
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "retail.bank_name", "Example Bank");
    await setSetting(c, "founder", "retail.bank_account_number", "0123456789");
    await setSetting(c, "founder", "retail.bank_account_name", "Telco Limited");
  });

  const send = dialler();
  await send.dial();
  await send.press("1");
  await send.press(RECIPIENT);
  await send.press("2");
  await send.press("500");
  const sent = await send.press("1");
  const transferRef = /Ref (TX-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)![1]!;

  const sell = dialler();
  await sell.dial();
  await sell.press("2");
  await sell.press("500");
  const selling = await sell.press("1");
  const sellbackRef = /Ref (SB-[2-9A-HJKMNP-Z]{8})/.exec(selling.text)![1]!;

  const buy = dialler();
  await buy.dial();
  await buy.press("3");
  await buy.press(RECIPIENT);
  await buy.press("2");
  await buy.press("500");
  const buying = await buy.press("1");
  const orderRef = /(RT-[2-9A-HJKMNP-Z]{8})/.exec(buying.text)![1]!;

  const before = await counts();
  const base_: Session = {
    session_id: "already-done",
    caller_number: CALLER,
    service_code: "*347*55#",
    network_code: "MTN",
    step: "send_confirm",
    answers: { from: "MTN", to: RECIPIENT, toNetwork: "AIRTEL", amountKobo: naira(500) },
    input_so_far: "",
    last_screen: "",
    keypresses: 5,
    reference: transferRef,
  };
  const actor = `ussd:${CALLER}`;
  const again = await as(actor, async (c) => ({
    send: await advance(c, base_, "1", actor),
    sell: await advance(c, { ...base_, step: "sell_confirm", reference: sellbackRef }, "1", actor),
    buy: await advance(c, { ...base_, step: "buy_confirm", reference: orderRef }, "1", actor),
  }));
  assert.equal(again.send.reference, transferRef);
  assert.match(again.send.screen, new RegExp(`Ref ${transferRef}`), "the caller is shown the one they already have");
  assert.equal(again.sell.reference, sellbackRef);
  assert.match(again.sell.screen, new RegExp(`Ref ${sellbackRef}`));
  assert.equal(again.buy.reference, orderRef);
  assert.match(again.buy.screen, new RegExp(`Put ${orderRef} as the narration`));
  assert.deepEqual(await counts(), before, "and nothing new was created");
});

async function counts(): Promise<{ transfers: number; sellbacks: number; orders: number }> {
  const { rows } = await pool.query<{ transfers: number; sellbacks: number; orders: number }>(
    "SELECT (SELECT count(*) FROM transfers)::int AS transfers, (SELECT count(*) FROM sellbacks)::int AS sellbacks, (SELECT count(*) FROM orders)::int AS orders",
  );
  return rows[0]!;
}

// --- reading it back in the command centre --------------------------------

test("a dialled session can be read in the command centre, screen by screen", async () => {
  const d = dialler();
  await d.dial();
  await d.press("1");
  await d.press(RECIPIENT);
  await d.press("2");
  await d.press("500");
  const sent = await d.press("1");
  const reference = /Ref (TX-[2-9A-HJKMNP-Z]{8})/.exec(sent.text)![1]!;

  const b = new Browser(base);
  await b.login();
  const list = await b.get("/admin/dial");
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(CALLER));
  assert.match(list.text, new RegExp(reference), "with what the session made, so it can be opened");
  assert.match(list.text, /sent/, "and how it ended");

  const id = /\/admin\/dial\/(\d+)/.exec(list.text)![1]!;
  const one = await b.get(`/admin/dial/${id}`);
  assert.equal(one.status, 200);
  assert.match(one.text, /1 Send airtime to another network/, "the opening screen as the caller saw it");
  assert.match(one.text, new RegExp(`Enter the number that will RECEIVE`));
  assert.match(one.text, new RegExp(RECIPIENT), "and what they keyed");
  assert.match(one.text, new RegExp(d.sessionId), "with the network's own id, to quote to the aggregator");

  const byCaller = await b.get("/admin/dial?caller=0803%20123%204567");
  assert.match(byCaller.text, new RegExp(CALLER), "spaces in the filter are no obstacle");
  const other = await b.get("/admin/dial?caller=08099999999");
  assert.match(other.text, /Nobody has dialled yet/);

  const missing = await b.get("/admin/dial/999999");
  assert.equal(missing.status, 404);
  assert.match(missing.text, /no dialled session with that number/);
});

test("the limits on a screen are the limits that will be enforced", async () => {
  // Sending, selling to us and buying each have their own pair of limits in
  // the command centre. A screen that quotes the wrong pair costs the caller
  // a whole session: they key an amount the screen invited and are refused.
  await as("founder", async (c) => {
    await setSetting(c, "founder", "transfer.max_kobo", naira(9_000));
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.min_kobo", naira(200));
    await setSetting(c, "founder", "sellback.max_kobo", naira(7_000));
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "retail.min_kobo", naira(300));
    await setSetting(c, "founder", "retail.max_kobo", naira(20_000));
  });

  const send = dialler();
  await send.dial();
  await send.press("1");
  await send.press(RECIPIENT);
  assert.match((await send.press("2")).text, /From N100 to N9,000\./);

  const sell = dialler();
  await sell.dial();
  assert.match((await sell.press("2")).text, /From N200 to N7,000\./);

  const buy = dialler();
  await buy.dial();
  await buy.press("3");
  await buy.press(RECIPIENT);
  assert.match((await buy.press("2")).text, /From N300 to N20,000\./);
});
