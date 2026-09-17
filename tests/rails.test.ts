import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { railFromEnv } from "../src/rails/rail.ts";
import { interpret, newRequestId, vtpassConfigFromEnv, VtpassRail } from "../src/rails/vtpass.ts";
import { setSetting } from "../src/settings.ts";
import { getTransfer, quoteTransfer, recordInbound, RETRY_WAIT_MINUTES } from "../src/transfers.ts";
import { runPayoutCycle } from "../src/worker.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { billerDown, delivered, failed, FakeVtpass, lowWallet, processing } from "./helpers/vtpass.ts";

const vt = new FakeVtpass();
before(() => vt.start());
after(async () => {
  vt.stop();
  await pool.end();
});

function rail(): VtpassRail {
  return new VtpassRail({ baseUrl: vt.base, apiKey: vt.keys.api, secretKey: vt.keys.secret, publicKey: vt.keys.public });
}

beforeEach(async () => {
  await clean();
  vt.calls = [];
  vt.script.clear();
  vt.balance = 12_345.5;
  await addReceivingNumber("08039990001", "MTN");
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", true));
});

async function confirmedTransfer(amountNaira = 500) {
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: naira(amountNaira) }));
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(amountNaira), rawText: `received ${Math.random()}`, source: "bridge" }));
  return transfer;
}

test("the provider is only used when its keys are in the environment", () => {
  assert.equal(railFromEnv({}), undefined);
  assert.equal(vtpassConfigFromEnv({ VTPASS_API_KEY: "a" }), undefined);
  const sandbox = vtpassConfigFromEnv({ VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s" })!;
  assert.equal(sandbox.baseUrl, "https://sandbox.vtpass.com/api");
  const live = vtpassConfigFromEnv({ VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s", VTPASS_PUBLIC_KEY: "p", VTPASS_ENV: "live" })!;
  assert.equal(live.baseUrl, "https://vtpass.com/api");
  assert.equal(railFromEnv({ VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s" })!.name, "vtpass");
});

test("a request id starts with the Lagos date and time to the minute, as the provider requires", () => {
  const id = newRequestId(new Date("2026-09-17T23:30:00Z"));
  // 23:30 UTC is 00:30 on the 18th in Lagos.
  assert.match(id, /^202609180030[0-9a-f]{12}$/);
  assert.notEqual(newRequestId(), newRequestId());
});

test("each answer the provider can give is read as done, still working, try later, or stop", () => {
  assert.equal(interpret(delivered("r", 480) as never).kind, "delivered");
  assert.equal(interpret(processing("r") as never).kind, "processing");
  assert.equal(interpret({ code: "000", content: { transactions: { status: "pending" } } }).kind, "processing");
  assert.equal(interpret(lowWallet).kind, "retry");
  assert.match(interpret(lowWallet).message, /Fund the wallet at vtpass.com/);
  assert.equal(interpret(billerDown).kind, "retry");
  assert.equal(interpret(failed).kind, "failed");
  assert.equal(interpret({ code: "011", response_description: "MISSING ARGUMENTS" }).kind, "failed");
  assert.equal(interpret({ code: "019" }).kind, "processing");
  assert.equal(interpret({}).kind, "retry");
});

test("a purchase is sent with the provider's field names, the right service id, whole naira, and both keys", async () => {
  const r = await rail().send({ requestId: "202609171000abc", network: "9MOBILE", number: "08091234567", amountKobo: naira(480) });
  assert.equal(r.kind, "delivered");
  const call = vt.calls.find((c) => c.path === "/pay")!;
  assert.deepEqual(call.body, { request_id: "202609171000abc", serviceID: "etisalat", amount: 480, phone: "08091234567" });
  assert.equal(call.headers["api-key"], "api-test");
  assert.equal(call.headers["secret-key"], "secret-test");
  if (r.kind === "delivered") {
    assert.equal(r.chargedKobo, 46_560);
    assert.equal(r.commissionKobo, 1_440);
    assert.equal(r.reference, "vt-202609171000abc");
  }
});

test("wrong keys are reported as wrong keys, with where to fix them", async () => {
  const bad = new VtpassRail({ baseUrl: vt.base, apiKey: "nope", secretKey: "nope", publicKey: "nope" });
  const h = await bad.health();
  assert.equal(h.ok, false);
  assert.match(h.message, /refused the keys.*VTPASS_API_KEY/);
});

test("the health check makes a real call and reads the wallet balance when the provider offers it", async () => {
  const h = await rail().health();
  assert.equal(h.ok, true);
  assert.equal(h.balanceKobo, 1_234_550);
  vt.balance = undefined;
  const without = await rail().health();
  assert.equal(without.ok, true);
  assert.equal(without.balanceKobo, undefined);
  assert.match(without.message, /did not report a wallet balance/);
});

test("a confirmed transfer is paid through the provider without a person, and the wallet, fee and commission are booked", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  const report = await runPayoutCycle(pool, rail());
  assert.equal(report.sent, 1);
  assert.equal(report.delivered, 1);
  const done = (await getTransfer(pool, t.id))!;
  assert.equal(done.state, "completed");
  assert.equal(done.payout_rail, "vtpass");
  assert.match(done.payout_reference!, /^vt-/);
  assert.equal(await balance(pool, "wallet:vtpass"), naira(10_000) - 46_560);
  assert.equal(await balance(pool, "revenue:provider_commission"), 1_440);
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
  assert.equal(await balance(pool, "owed:senders"), 0);
  assert.equal(await balance(pool, "pool:AIRTEL"), 0);
});

test("with automatic payouts off, nothing is sent and the transfer waits for a person", async () => {
  await as("founder", (c) => setSetting(c, "founder", "payout.automatic", false));
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  const report = await runPayoutCycle(pool, rail());
  assert.deepEqual(report.skipped, ["automatic payouts are off"]);
  assert.equal(vt.payCalls(), 0);
  assert.equal((await getTransfer(pool, t.id))!.state, "inbound_confirmed");
});

test("a payout the provider is still working on is left alone and then settled by asking again, never sent twice", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  vt.defaultPay = (b) => processing(b.request_id);
  const first = await runPayoutCycle(pool, rail());
  assert.equal(first.sent, 1);
  assert.equal(first.delivered, 0);
  let now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "paying_out");
  assert.match(now.payout_last_error!, /still working/);
  // Too soon to ask again.
  await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 1);
  // Later, the provider is asked by request id and says delivered.
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const later = await runPayoutCycle(pool, rail(), new Date());
  assert.equal(later.checked, 1);
  assert.equal(later.delivered, 1);
  assert.equal(vt.payCalls(), 1);
  now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "completed");
  vt.defaultPay = (b) => delivered(b.request_id, b.amount);
});

test("when the provider never answers, the result is checked by request id before anything is sent again", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  const original = vt.defaultPay;
  let requestId = "";
  vt.defaultPay = (b) => {
    requestId = b.request_id;
    vt.script.set(b.request_id, { pay: new Error("cut off") });
    return null as never;
  };
  // The fake drops the connection the first time it sees this request id.
  const r = rail();
  const originalSend = r.send.bind(r);
  r.send = async (input) => {
    vt.script.set(input.requestId, { pay: new Error("cut off"), requery: [delivered(input.requestId, 480)] });
    return originalSend(input);
  };
  const first = await runPayoutCycle(pool, r);
  assert.equal(first.sent, 1);
  const mid = (await getTransfer(pool, t.id))!;
  assert.equal(mid.state, "paying_out");
  assert.match(mid.payout_last_error!, /Could not get an answer/);
  await pool.query("UPDATE transfer_events SET at = at - interval '2 minutes'");
  const second = await runPayoutCycle(pool, r);
  assert.equal(second.checked, 1);
  assert.equal(second.delivered, 1);
  assert.equal(vt.calls.filter((c) => c.path === "/requery").length, 1);
  assert.equal((await getTransfer(pool, t.id))!.state, "completed");
  vt.defaultPay = original;
  void requestId;
});

test("a low provider wallet is retried after a wait with a message that says to fund it, up to the attempt limit, then left for a person", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  await as("founder", (c) => setSetting(c, "founder", "payout.max_attempts", 2));
  const t = await confirmedTransfer();
  vt.defaultPay = () => lowWallet;
  const first = await runPayoutCycle(pool, rail());
  assert.equal(first.retried, 1);
  let now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "payout_failed");
  assert.match(now.payout_last_error!, /Fund the wallet/);
  const wait = (now.payout_next_attempt_at!.getTime() - Date.now()) / 60_000;
  assert.ok(wait > RETRY_WAIT_MINUTES[0]! - 0.1 && wait <= RETRY_WAIT_MINUTES[0]!, `first wait is ${wait} minutes`);
  // Not yet due.
  await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 1);
  // Due: second and last attempt.
  await pool.query("UPDATE transfers SET payout_next_attempt_at = now() - interval '1 second'");
  await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 2);
  now = (await getTransfer(pool, t.id))!;
  assert.equal(now.payout_attempts, 2);
  // Over the limit: even when due, it is left for a person.
  await pool.query("UPDATE transfers SET payout_next_attempt_at = now() - interval '1 second'");
  await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 2);
  assert.equal((await getTransfer(pool, t.id))!.state, "payout_failed");
  vt.defaultPay = (b) => delivered(b.request_id, b.amount);
});

test("a failure the provider calls final is not retried automatically", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  vt.defaultPay = () => failed;
  const report = await runPayoutCycle(pool, rail());
  assert.equal(report.failed, 1);
  const now = (await getTransfer(pool, t.id))!;
  assert.equal(now.state, "payout_failed");
  assert.equal(now.payout_next_attempt_at, null);
  await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 1);
  vt.defaultPay = (b) => delivered(b.request_id, b.amount);
});

test("when our ledger says the provider wallet cannot cover a payout, it is held before anything is sent", async () => {
  await fundPool("wallet:vtpass", naira(100));
  const t = await confirmedTransfer();
  const report = await runPayoutCycle(pool, rail());
  assert.equal(vt.payCalls(), 0);
  assert.match(report.skipped[0]!, /provider wallet holds N100 and this payout needs N480. Record money added to the provider wallet under Pools/);
  assert.equal((await getTransfer(pool, t.id))!.state, "held");
});

test("provider figures that do not add up are refused rather than booked", async () => {
  await fundPool("wallet:vtpass", naira(10_000));
  const t = await confirmedTransfer();
  vt.defaultPay = (b) => ({ ...(delivered(b.request_id, b.amount) as object), content: { transactions: { status: "delivered", transactionId: "x", amount: 480, commission: 10, total_amount: 400 } } });
  await assert.rejects(runPayoutCycle(pool, rail()), /do not add up/);
  assert.equal((await getTransfer(pool, t.id))!.state, "paying_out");
  assert.equal(await balance(pool, "wallet:vtpass"), naira(10_000));
  vt.defaultPay = (b) => delivered(b.request_id, b.amount);
});
