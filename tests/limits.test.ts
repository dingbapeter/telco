import assert from "node:assert/strict";
import type pg from "pg";
import { after, beforeEach, test } from "node:test";
import { balance } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { setSetting } from "../src/settings.ts";
import { getTransfer, quoteTransfer, recordInbound } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";

// The caps that exist to stop the service being used to wash money, and what
// happens to value that arrives over one.

const SENDER = "08031234567";
const OTHER_SENDER = "08035550001";
const RECIPIENT = "08021234567";
const OUR_MTN = "08039990001";

beforeEach(async () => {
  await clean();
  await addReceivingNumber(OUR_MTN, "MTN");
  await fundPool("AIRTEL", naira(5_000));
});
after(() => pool.end());

const set = (key: Parameters<typeof setSetting>[2], value: unknown) => as("founder", (c) => setSetting(c, "founder", key, value));

const quote = (amountKobo = naira(500), from = SENDER, to = RECIPIENT) =>
  as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: from, recipientNumber: to, amountKobo }));

const airtimeArrives = (amountKobo = naira(500), from = SENDER, tag = "77123") =>
  as("bridge:mtn-phone", (c) =>
    recordInbound(c, "bridge:mtn-phone", {
      networkCode: "MTN",
      receivingNumber: OUR_MTN,
      senderNumber: from,
      amountKobo,
      // The reference makes two messages for the same amount two messages
      // rather than the same one twice.
      rawText: `You have received N${amountKobo / 100} airtime from ${from}. Ref ${tag}`,
      source: "bridge",
    }),
  );

test("a sender over the week's money cap is refused and told what is left until Monday", async () => {
  await set("transfer.sender_weekly_max_kobo", naira(1_200));
  await quote(naira(1_000));
  await assert.rejects(quote(naira(500)), /can move N1,200 a week and has N200 left until Monday/);
});

test("a transfer made before Monday does not count against the week", async () => {
  await set("transfer.sender_weekly_max_kobo", naira(1_200));
  const { transfer } = await quote(naira(1_000));
  await pool.query("UPDATE transfers SET created_at = created_at - interval '8 days' WHERE id = $1", [transfer.id]);
  await quote(naira(1_000));
});

test("a sender who has made the day's allowance of transfers is refused however small the next one is", async () => {
  await set("transfer.sender_daily_max_count", 2);
  await quote(naira(100));
  await quote(naira(100));
  await assert.rejects(quote(naira(100)), /can make 2 transfers a day and has made 2 today. The next one can go tomorrow/);
});

test("the week's allowance of transfers holds even when each day is inside the daily one", async () => {
  await set("transfer.sender_daily_max_count", 2);
  await set("transfer.sender_weekly_max_count", 3);
  await quote(naira(100));
  await quote(naira(100));
  await pool.query("UPDATE transfers SET created_at = created_at - interval '1 day'");
  await quote(naira(100));
  await assert.rejects(quote(naira(100)), /can make 3 transfers a week and has made 3 since Monday/);
});

test("a cap set to zero is off", async () => {
  await set("transfer.sender_weekly_max_kobo", 0);
  await set("transfer.sender_daily_max_count", 0);
  await set("transfer.sender_weekly_max_count", 0);
  await set("transfer.recipient_daily_max_kobo", 0);
  await set("transfer.recipient_daily_max_count", 0);
  await set("transfer.sender_daily_max_kobo", naira(100_000));
  for (let i = 0; i < 12; i++) await quote(naira(100));
});

test("a receiving number is capped across everybody sending to it, without telling anybody its totals", async () => {
  await set("transfer.recipient_daily_max_kobo", naira(1_200));
  await quote(naira(1_000), SENDER);
  await assert.rejects(quote(naira(500), OTHER_SENDER), (err: Error) => {
    assert.match(err.message, /One number can only be sent N1,200 a day, and this one has reached it/);
    // What another line has already been sent today is not a stranger's to
    // learn, so no figure about it appears.
    assert.doesNotMatch(err.message, /1,000/);
    return true;
  });
});

test("a receiving number is capped on how many transfers it may be sent in a day", async () => {
  await set("transfer.recipient_daily_max_count", 1);
  await quote(naira(100), SENDER);
  await assert.rejects(quote(naira(100), OTHER_SENDER), /One number can only be sent 1 transfer a day, and this one has reached that/);
});

test("airtime that arrives over a cap goes straight back to the line it came from", async () => {
  await set("transfer.sender_daily_max_kobo", naira(1_000));
  const { transfer } = await quote(naira(500));
  // The sender dialled a bigger amount than they were quoted, which is the
  // only way past a cap checked when the quote was made.
  const outcome = await airtimeArrives(naira(1_500));
  assert.equal(outcome.outcome, "returned");
  const after = (await getTransfer(pool, transfer.id))!;
  assert.equal(after.state, "refunding");
  assert.equal(after.hold_reason, "over_daily_limit");
  assert.equal(after.received_kobo, naira(1_500));
  assert.equal(after.fee_kobo, null);
  // The value is on our SIM and all of it is owed back. No fee was taken.
  assert.equal(await balance(pool, "pool:MTN"), naira(1_500));
  // A liability reads as what we owe, so this is N1,500 owed back.
  assert.equal(await balance(pool, "owed:senders"), naira(1_500));
  assert.equal(await balance(pool, "revenue:fees"), 0);
});

test("with the switch off, value over a cap waits for a person instead of going back", async () => {
  await set("transfer.sender_daily_max_kobo", naira(1_000));
  await set("transfer.return_over_limit", false);
  const { transfer } = await quote(naira(500));
  const outcome = await airtimeArrives(naira(1_500));
  assert.equal(outcome.outcome, "held");
  const after = (await getTransfer(pool, transfer.id))!;
  assert.equal(after.state, "held");
  assert.equal(after.hold_reason, "over_daily_limit");
});

test("a transfer that fills the cap exactly is not sent back as though it broke it", async () => {
  // The transfer's own row is in the table by the time the airtime lands.
  // Counting it against itself would send back every transfer made at the
  // cap, which is the one amount a cap is meant to allow.
  await set("transfer.sender_daily_max_kobo", naira(500));
  const { transfer } = await quote(naira(500));
  const outcome = await airtimeArrives(naira(500));
  assert.equal(outcome.outcome, "matched");
  assert.equal((await getTransfer(pool, transfer.id))!.state, "inbound_confirmed");
});

test("the day's count does not send back the transfer that was quoted inside it", async () => {
  await set("transfer.sender_daily_max_count", 1);
  const { transfer } = await quote(naira(500));
  const outcome = await airtimeArrives(naira(500));
  assert.equal(outcome.outcome, "matched");
  assert.equal((await getTransfer(pool, transfer.id))!.state, "inbound_confirmed");
});

test("value sent back does not count against the sender afterwards", async () => {
  await set("transfer.sender_daily_max_kobo", naira(1_000));
  await quote(naira(500));
  await airtimeArrives(naira(1_500));
  // The N1,500 is on its way back, so it never moved and the day is clear.
  await quote(naira(900));
});

// Two transactions held open on purpose, so the second really is inside the
// first and the test does not depend on which finishes first. Timing-based
// concurrency tests pass by luck; these two drive the interleaving.
async function inTwoTransactions<T>(first: (c: pg.PoolClient) => Promise<T>, second: (c: pg.PoolClient) => Promise<T>): Promise<{ a: T; b: Promise<T> }> {
  const one = await pool.connect();
  const two = await pool.connect();
  await one.query("BEGIN");
  await one.query("SELECT set_config('app.actor', 'test-a', true)");
  await two.query("BEGIN");
  await two.query("SELECT set_config('app.actor', 'test-b', true)");
  const a = await first(one);
  // Started while the first transaction is still open, so anything the first
  // holds a lock on makes this wait.
  const b = second(two)
    .then(async (r) => {
      await two.query("COMMIT");
      two.release();
      return r;
    })
    .catch(async (err: unknown) => {
      await two.query("ROLLBACK").catch(() => undefined);
      two.release();
      throw err;
    });
  // Wait until the database says the second is really waiting on a lock
  // before letting the first finish. Without this the commit below can win
  // the race and the test would pass whether the lock is there or not.
  await waitUntilSomethingIsBlocked();
  await one.query("COMMIT");
  one.release();
  return { a, b };
}

async function waitUntilSomethingIsBlocked(timeoutMs = 3_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if (rows[0]!.n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("a second quote cannot pass a cap the first one has already filled", async () => {
  await set("transfer.sender_daily_max_kobo", naira(1_000));
  const { b } = await inTwoTransactions(
    (c) => quoteTransfer(c, "test-a", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: SENDER, recipientNumber: RECIPIENT, amountKobo: naira(800) }),
    (c) => quoteTransfer(c, "test-b", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: SENDER, recipientNumber: RECIPIENT, amountKobo: naira(800) }),
  );
  // Without the lock the second counts the day before the first is in it.
  await assert.rejects(b, /has N200 left today/);
});

test("two amounts arriving for one sender cannot both slip past a cap", async () => {
  // Each was quoted a small amount and sent far more. One at a time, the
  // second breaks the day's cap; without the lock the second counts only the
  // first's small quote and both get through.
  await set("transfer.sender_daily_max_kobo", naira(1_000));
  await quote(naira(100));
  await quote(naira(100));
  const arrives = (tag: string) => (c: pg.PoolClient) =>
    recordInbound(c, "bridge:mtn-phone", {
      networkCode: "MTN",
      receivingNumber: OUR_MTN,
      senderNumber: SENDER,
      amountKobo: naira(600),
      rawText: `You have received N600 airtime from ${SENDER}. Ref ${tag}`,
      source: "bridge",
    });
  const { a, b } = await inTwoTransactions(arrives("aaa"), arrives("bbb"));
  assert.equal(a.outcome, "matched");
  assert.equal((await b).outcome, "returned");
});
