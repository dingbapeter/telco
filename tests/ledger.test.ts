import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { balance, balances, postJournal } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { as, clean, fundPool, pool } from "./helpers/db.ts";

beforeEach(clean);
after(() => pool.end());

test("airtime put into a pool shows as that pool's balance and as the founder's float", async () => {
  await fundPool("MTN", naira(10_000));
  assert.equal(await balance(pool, "pool:MTN"), naira(10_000));
  assert.equal(await balance(pool, "equity:float"), naira(10_000));
  assert.equal(await balance(pool, "pool:AIRTEL"), 0);
});

test("a journal that does not balance is refused before it touches the database", async () => {
  await assert.rejects(
    as("test", (c) =>
      postJournal(c, {
        idempotencyKey: "bad",
        description: "unbalanced",
        postings: [
          { account: "pool:MTN", amountKobo: 100 },
          { account: "equity:float", amountKobo: -99 },
        ],
      }),
    ),
    /debits minus credits is 1 kobo/,
  );
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM ledger_journals");
  assert.equal(rows[0].n, 0);
});

test("the database itself refuses an unbalanced journal even when the application check is bypassed", async () => {
  await assert.rejects(
    as("test", async (c) => {
      const j = await c.query("INSERT INTO ledger_journals (description, idempotency_key) VALUES ('raw', 'raw') RETURNING id");
      await c.query("INSERT INTO ledger_postings (journal_id, account_code, amount_kobo) VALUES ($1, 'pool:MTN', 100)", [j.rows[0].id]);
      await c.query("INSERT INTO ledger_postings (journal_id, account_code, amount_kobo) VALUES ($1, 'equity:float', -50)", [j.rows[0].id]);
    }),
    /does not balance/,
  );
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM ledger_journals");
  assert.equal(rows[0].n, 0);
});

test("a journal with one posting is refused", async () => {
  await assert.rejects(
    as("test", (c) => postJournal(c, { idempotencyKey: "one", description: "one", postings: [{ account: "pool:MTN", amountKobo: 100 }] })),
    /at least two postings/,
  );
});

test("posting the same journal twice books it once", async () => {
  const input = {
    idempotencyKey: "webhook-123",
    description: "twice",
    postings: [
      { account: "pool:MTN", amountKobo: naira(50) },
      { account: "equity:float", amountKobo: -naira(50) },
    ],
  };
  const first = await as("test", (c) => postJournal(c, input));
  const second = await as("test", (c) => postJournal(c, input));
  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(first.journalId, second.journalId);
  assert.equal(await balance(pool, "pool:MTN"), naira(50));
});

test("a posting can never be changed or deleted once written", async () => {
  await fundPool("MTN", naira(100));
  await assert.rejects(pool.query("UPDATE ledger_postings SET amount_kobo = 1"), /immutable/);
  await assert.rejects(pool.query("DELETE FROM ledger_postings"), /immutable/);
  await assert.rejects(pool.query("UPDATE ledger_journals SET description = 'x'"), /immutable/);
  await assert.rejects(pool.query("DELETE FROM ledger_journals"), /immutable/);
  assert.equal(await balance(pool, "pool:MTN"), naira(100));
});

test("a posting to an account that does not exist is refused", async () => {
  await assert.rejects(
    as("test", (c) =>
      postJournal(c, {
        idempotencyKey: "ghost",
        description: "ghost",
        postings: [
          { account: "pool:NOWHERE", amountKobo: 1 },
          { account: "equity:float", amountKobo: -1 },
        ],
      }),
    ),
  );
});

test("every account reads as a positive number when it holds what it should", async () => {
  await fundPool("AIRTEL", naira(300));
  const all = await balances(pool);
  const byCode = Object.fromEntries(all.map((a) => [a.code, a.balanceKobo]));
  assert.equal(byCode["pool:AIRTEL"], naira(300));
  assert.equal(byCode["equity:float"], naira(300));
  assert.equal(byCode["revenue:fees"], 0);
});
