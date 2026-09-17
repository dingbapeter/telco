import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { setSetting } from "../src/settings.ts";
import {
  approvePayout,
  completePayout,
  completeRefund,
  expireQuotes,
  failPayout,
  getTransfer,
  getTransferByReference,
  newReference,
  quoteTransfer,
  recordInbound,
  releaseHold,
  startPayout,
  startRefund,
} from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";

const SENDER = "08031234567";
const RECIPIENT = "08021234567";
const OUR_MTN = "08039990001";

beforeEach(async () => {
  await clean();
  await addReceivingNumber(OUR_MTN, "MTN");
  await fundPool("AIRTEL", naira(5_000));
});
after(() => pool.end());

const quote = (amountKobo = naira(500), overrides: Partial<Parameters<typeof quoteTransfer>[2]> = {}) =>
  as("sender", (c) =>
    quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: SENDER, recipientNumber: RECIPIENT, amountKobo, ...overrides }),
  );

const airtimeArrives = (amountKobo = naira(500), extra: Partial<Parameters<typeof recordInbound>[2]> = {}) =>
  as("bridge:mtn-phone", (c) =>
    recordInbound(c, "bridge:mtn-phone", {
      networkCode: "MTN",
      receivingNumber: OUR_MTN,
      senderNumber: SENDER,
      amountKobo,
      rawText: `You have received N${amountKobo / 100} airtime from ${SENDER}. Ref 77123`,
      source: "bridge",
      ...extra,
    }),
  );

test("a sender is quoted the fee, what the recipient gets, and which number to send to", async () => {
  const { transfer, fee } = await quote();
  assert.equal(transfer.state, "awaiting_inbound");
  assert.equal(transfer.receiving_number, OUR_MTN);
  assert.equal(fee.feeKobo, naira(20));
  assert.equal(fee.payoutKobo, naira(480));
  assert.equal(transfer.quoted_payout_kobo, naira(480));
  assert.match(transfer.reference, /^TX-[2-9A-HJKMNP-Z]{8}$/);
  assert.ok(transfer.expires_at.getTime() > Date.now() + 29 * 60_000);
});

test("references never contain letters that get confused when read aloud", () => {
  for (let i = 0; i < 500; i++) assert.doesNotMatch(newReference(), /[01OIL]/);
});

test("a transfer between two numbers on the same network is turned away with the reason", async () => {
  await assert.rejects(quote(naira(500), { toNetwork: "MTN" }), /Both numbers are on MTN/);
});

test("a sender cannot move less than the minimum or more than the maximum", async () => {
  await assert.rejects(quote(naira(50)), /smallest transfer is N100/);
  await assert.rejects(quote(naira(20_000)), /largest transfer is N10,000/);
});

test("a sender is stopped at their daily limit and told how much is left", async () => {
  await as("founder", (c) => setSetting(c, "founder", "transfer.sender_daily_max_kobo", naira(1_000)));
  await quote(naira(600));
  await assert.rejects(quote(naira(500)), /has N400 left today/);
  await quote(naira(400));
});

test("a quote larger than the network's own daily transfer cap is refused before the network refuses it", async () => {
  await as("founder", (c) => setSetting(c, "founder", "network.daily_transfer_cap_kobo", { MTN: naira(300), AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  await assert.rejects(quote(naira(500)), /MTN only lets a subscriber transfer N300 in a day/);
});

test("with no receiving number on the sender's network the founder is told where to add one", async () => {
  await assert.rejects(quote(naira(500), { fromNetwork: "GLO", toNetwork: "MTN" }), /add an active GLO number or raise a daily cap/);
});

test("the receiving number with the most room left today takes the next transfer, and a full one is skipped", async () => {
  const second = "08039990002";
  await addReceivingNumber(second, "MTN", naira(600));
  await pool.query("UPDATE receiving_numbers SET daily_cap_kobo = $1 WHERE number = $2", [naira(600), OUR_MTN]);
  const a = await quote(naira(500));
  const b = await quote(naira(500));
  assert.notEqual(a.transfer.receiving_number, b.transfer.receiving_number);
  await assert.rejects(quote(naira(500)), /No MTN number can take this transfer/);
  await quote(naira(100));
});

test("airtime arriving from the sender confirms the transfer, books the pool, and matches the notification", async () => {
  const { transfer } = await quote();
  const outcome = await airtimeArrives();
  assert.equal(outcome.outcome, "matched");
  const t = await getTransfer(pool, transfer.id);
  assert.equal(t!.state, "inbound_confirmed");
  assert.equal(t!.received_kobo, naira(500));
  assert.equal(t!.payout_kobo, naira(480));
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
  assert.equal(await balance(pool, "owed:senders"), naira(500));
  const n = await pool.query("SELECT matched_transfer_id FROM inbound_notifications");
  assert.equal(n.rows[0].matched_transfer_id, transfer.id);
});

test("the same notification arriving twice is recorded once and books nothing twice", async () => {
  await quote();
  const first = await airtimeArrives();
  const second = await airtimeArrives();
  assert.equal(first.outcome, "matched");
  assert.equal(second.outcome, "duplicate");
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
  const n = await pool.query("SELECT count(*)::int AS n FROM inbound_notifications");
  assert.equal(n.rows[0].n, 1);
});

test("airtime that nobody asked us to expect is kept for a person to look at and pays out nothing", async () => {
  const outcome = await airtimeArrives(naira(500));
  assert.equal(outcome.outcome, "unmatched");
  assert.equal(await balance(pool, "pool:MTN"), 0);
  const n = await pool.query("SELECT matched_transfer_id FROM inbound_notifications");
  assert.equal(n.rows[0].matched_transfer_id, null);
});

test("what arrives is what we move: a different amount than quoted gets a fresh fee on the real amount", async () => {
  const { transfer } = await quote(naira(500));
  const outcome = await airtimeArrives(naira(1_000));
  assert.equal(outcome.outcome, "matched");
  const t = await getTransfer(pool, transfer.id);
  assert.equal(t!.received_kobo, naira(1_000));
  assert.equal(t!.fee_kobo, naira(40));
  assert.equal(t!.payout_kobo, naira(960));
  assert.equal(t!.quoted_payout_kobo, naira(480));
});

test("an amount that arrives below the minimum is held for a person and cannot be released, only refunded", async () => {
  const { transfer } = await quote(naira(500));
  const outcome = await airtimeArrives(naira(50));
  assert.equal(outcome.outcome, "held");
  const t = await getTransfer(pool, transfer.id);
  assert.equal(t!.state, "held");
  assert.equal(t!.hold_reason, "amount_below_minimum");
  assert.equal(await balance(pool, "owed:senders"), naira(50));
  await assert.rejects(as("founder", (c) => releaseHold(c, "founder", transfer.id)), /can only be refunded/);
  const refund = await as("founder", (c) => startRefund(c, "founder", transfer.id));
  assert.equal(refund.amountKobo, naira(50));
  assert.equal(refund.network, "MTN");
  assert.equal(refund.number, SENDER);
});

test("a notification is matched to the waiting transfer for exactly its amount before any other", async () => {
  const small = await quote(naira(200));
  const big = await quote(naira(500));
  const outcome = await airtimeArrives(naira(500));
  assert.equal(outcome.outcome, "matched");
  assert.equal((outcome as { transfer: { id: number } }).transfer.id, big.transfer.id);
  assert.equal((await getTransfer(pool, small.transfer.id))!.state, "awaiting_inbound");
});

test("a paid transfer books the payout, the fee as revenue, and leaves nothing owed to the sender", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  const start = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(start.started, true);
  if (!start.started) return;
  assert.deepEqual(start.instruction, { transferId: transfer.id, reference: transfer.reference, network: "AIRTEL", number: RECIPIENT, amountKobo: naira(480) });
  const done = await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-1"));
  assert.equal(done!.state, "completed");
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(5_000 - 480));
  assert.equal(await balance(pool, "pool:MTN"), naira(500));
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
  assert.equal(await balance(pool, "owed:senders"), 0);
  assert.equal(await balance(pool, "owed:MTN"), 0);
});

test("when a network has a share of the fee, its share is booked as owed to it", async () => {
  await as("founder", (c) => setSetting(c, "founder", "fee.network_share_basis_points", { MTN: 2_500, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-2"));
  assert.equal(await balance(pool, "owed:MTN"), naira(5));
  assert.equal(await balance(pool, "revenue:fees"), naira(15));
});

test("a payout completion that arrives twice books nothing twice", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  const first = await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-3"));
  const second = await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-3"));
  assert.ok(first);
  assert.equal(second, undefined);
  assert.equal(await balance(pool, "revenue:fees"), naira(20));
});

test("two workers cannot both start the same payout", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  const [a, b] = await Promise.all([
    as("worker-a", (c) => startPayout(c, "worker-a", transfer.id)),
    as("worker-b", (c) => startPayout(c, "worker-b", transfer.id)),
  ]);
  assert.equal([a.started, b.started].filter(Boolean).length, 1);
  assert.equal((await getTransfer(pool, transfer.id))!.payout_attempts, 1);
});

test("a payout cannot start before the airtime has arrived", async () => {
  const { transfer } = await quote();
  const start = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(start.started, false);
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(5_000));
});

test("a payout larger than the approval threshold waits for a named approver", async () => {
  await as("founder", (c) => setSetting(c, "founder", "payout.auto_approve_max_kobo", naira(300)));
  const { transfer } = await quote(naira(500));
  await airtimeArrives();
  const start = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(start.started, false);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "awaiting_approval");
  const approved = await as("founder", (c) => approvePayout(c, "founder", transfer.id));
  assert.equal(approved.approved_by, "founder");
  const again = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(again.started, true);
});

test("payouts on a network stop at the daily ceiling and the founder is told where to raise it", async () => {
  await as("founder", (c) => setSetting(c, "founder", "payout.daily_ceiling_kobo", { MTN: naira(5_000), AIRTEL: naira(500), GLO: naira(5_000), "9MOBILE": naira(5_000) }));
  const first = await quote(naira(500));
  await airtimeArrives(naira(500), { rawText: "first" });
  await as("worker", (c) => startPayout(c, "worker", first.transfer.id));
  await as("worker", (c) => completePayout(c, "worker", first.transfer.id, "VTP-4"));
  const second = await quote(naira(500));
  await airtimeArrives(naira(500), { rawText: "second" });
  const start = await as("worker", (c) => startPayout(c, "worker", second.transfer.id));
  assert.equal(start.started, false);
  assert.match((start as { reason: string }).reason, /past the N500 ceiling. Raise the ceiling in the command centre under Guardrails/);
  assert.equal((await getTransfer(pool, second.transfer.id))!.hold_reason, "daily_payout_ceiling");
});

test("a payout the pool cannot cover is held, and released once the pool is topped up", async () => {
  await pool.query("TRUNCATE ledger_postings, ledger_journals RESTART IDENTITY");
  await fundPool("AIRTEL", naira(100));
  const { transfer } = await quote(naira(500));
  await airtimeArrives();
  const start = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(start.started, false);
  assert.match((start as { reason: string }).reason, /AIRTEL pool holds N100 and this payout needs N480. Top up the AIRTEL pool/);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "held");
  await fundPool("AIRTEL", naira(1_000));
  const released = await as("founder", (c) => releaseHold(c, "founder", transfer.id));
  assert.equal(released.state, "inbound_confirmed");
  const again = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(again.started, true);
});

test("a failed payout can be retried and the attempt count tells the story", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => failPayout(c, "worker", transfer.id, "provider timed out"));
  assert.equal((await getTransfer(pool, transfer.id))!.state, "payout_failed");
  const retry = await as("worker", (c) => startPayout(c, "worker", transfer.id));
  assert.equal(retry.started, true);
  assert.equal((await getTransfer(pool, transfer.id))!.payout_attempts, 2);
  assert.equal(await balance(pool, "pool:AIRTEL"), naira(5_000));
});

test("a refund returns the airtime to the sender exactly once and leaves nothing owed", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => failPayout(c, "worker", transfer.id, "recipient number barred"));
  const instruction = await as("founder", (c) => startRefund(c, "founder", transfer.id));
  assert.deepEqual(instruction, { transferId: transfer.id, reference: transfer.reference, network: "MTN", number: SENDER, amountKobo: naira(500) });
  await assert.rejects(as("founder", (c) => startRefund(c, "founder", transfer.id)), /cannot be refunded/);
  const done = await as("worker", (c) => completeRefund(c, "worker", transfer.id, "SIM-1"));
  const again = await as("worker", (c) => completeRefund(c, "worker", transfer.id, "SIM-1"));
  assert.equal(done!.state, "refunded");
  assert.equal(again, undefined);
  assert.equal(await balance(pool, "owed:senders"), 0);
  assert.equal(await balance(pool, "pool:MTN"), 0);
  assert.equal(await balance(pool, "revenue:fees"), 0);
});

test("a completed transfer cannot be refunded", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-5"));
  await assert.rejects(as("founder", (c) => startRefund(c, "founder", transfer.id)), /completed cannot be refunded/);
});

test("a quote nobody paid for expires, but airtime that lands late in the grace period still matches it", async () => {
  const { transfer } = await quote();
  await pool.query("UPDATE transfers SET expires_at = now() - interval '1 minute' WHERE id = $1", [transfer.id]);
  assert.equal(await expireQuotes(pool), 1);
  assert.equal((await getTransfer(pool, transfer.id))!.state, "expired");
  const outcome = await airtimeArrives();
  assert.equal(outcome.outcome, "matched");
  assert.equal((await getTransfer(pool, transfer.id))!.state, "inbound_confirmed");
});

test("airtime that lands after the grace period is not matched to a stale quote", async () => {
  const { transfer } = await quote();
  await pool.query("UPDATE transfers SET expires_at = now() - interval '3 hours' WHERE id = $1", [transfer.id]);
  await expireQuotes(pool);
  const outcome = await airtimeArrives();
  assert.equal(outcome.outcome, "unmatched");
});

test("an expired quote does not count against the sender's daily limit", async () => {
  await as("founder", (c) => setSetting(c, "founder", "transfer.sender_daily_max_kobo", naira(1_000)));
  const { transfer } = await quote(naira(800));
  await pool.query("UPDATE transfers SET expires_at = now() - interval '1 minute' WHERE id = $1", [transfer.id]);
  await expireQuotes(pool);
  await quote(naira(800));
});

test("every step of a transfer is in its event trail with who did it", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  await as("worker", (c) => startPayout(c, "worker", transfer.id));
  await as("worker", (c) => completePayout(c, "worker", transfer.id, "VTP-6"));
  const { rows } = await pool.query("SELECT from_state, to_state, actor FROM transfer_events WHERE transfer_id = $1 ORDER BY id", [transfer.id]);
  assert.deepEqual(
    rows.map((r) => [r.from_state, r.to_state, r.actor]),
    [
      [null, "awaiting_inbound", "sender"],
      ["awaiting_inbound", "inbound_confirmed", "bridge:mtn-phone"],
      ["inbound_confirmed", "paying_out", "worker"],
      ["paying_out", "completed", "worker"],
    ],
  );
});

test("every change to a transfer row lands in the audit log without any code asking for it", async () => {
  const { transfer } = await quote();
  await airtimeArrives();
  const { rows } = await pool.query("SELECT actor, action, after->>'state' AS state FROM audit_log WHERE table_name = 'transfers' AND row_id = $1 ORDER BY id", [String(transfer.id)]);
  assert.deepEqual(
    rows.map((r) => [r.actor, r.action, r.state]),
    [
      ["sender", "insert", "awaiting_inbound"],
      ["bridge:mtn-phone", "update", "inbound_confirmed"],
    ],
  );
});

test("a transfer can be found by its reference however it is typed", async () => {
  const { transfer } = await quote();
  const found = await getTransferByReference(pool, ` ${transfer.reference.toLowerCase()} `);
  assert.equal(found!.id, transfer.id);
});
