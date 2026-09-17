import type { Queryable } from "./db.ts";
import { assertKobo } from "./money.ts";

export type Posting = { account: string; amountKobo: number };

export type JournalInput = {
  idempotencyKey: string;
  description: string;
  reference?: string;
  postings: Posting[];
};

export type JournalResult = { journalId: number; posted: boolean };

// Debits are positive and credits negative, and a journal must sum to zero.
// The check is made here so the caller gets a clear message, and again by a
// deferred trigger in the database so nothing can post an unbalanced journal
// by going around this function. Two defences on purpose.
export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) throw new Error("A journal needs at least two postings.");
  let sum = 0;
  for (const p of postings) {
    assertKobo(p.amountKobo, `posting to ${p.account}`);
    if (p.amountKobo === 0) throw new Error(`Posting to ${p.account} is zero; leave it out instead.`);
    sum += p.amountKobo;
  }
  if (sum !== 0) throw new Error(`Journal does not balance: debits minus credits is ${sum} kobo.`);
}

// Posts a journal once. A second call with the same idempotency key does
// nothing and reports so, which is what makes every webhook and retry safe.
export async function postJournal(db: Queryable, input: JournalInput): Promise<JournalResult> {
  assertBalanced(input.postings);
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO ledger_journals (description, reference, idempotency_key)
     VALUES ($1, $2, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.description, input.reference ?? null, input.idempotencyKey],
  );
  const row = inserted.rows[0];
  if (!row) {
    const existing = await db.query<{ id: number }>("SELECT id FROM ledger_journals WHERE idempotency_key = $1", [
      input.idempotencyKey,
    ]);
    return { journalId: existing.rows[0]!.id, posted: false };
  }
  for (const p of input.postings) {
    await db.query("INSERT INTO ledger_postings (journal_id, account_code, amount_kobo) VALUES ($1, $2, $3)", [
      row.id,
      p.account,
      p.amountKobo,
    ]);
  }
  return { journalId: row.id, posted: true };
}

// Natural balance: assets and expenses grow with debits, everything else
// with credits, so every account reads as a positive number when healthy.
export async function balance(db: Queryable, account: string): Promise<number> {
  const { rows } = await db.query<{ kind: string; total: number }>(
    `SELECT a.kind, coalesce(sum(p.amount_kobo), 0)::bigint AS total
     FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_code = a.code
     WHERE a.code = $1 GROUP BY a.kind`,
    [account],
  );
  const row = rows[0];
  if (!row) throw new Error(`Ledger account ${account} does not exist.`);
  return naturalBalance(row.kind, row.total);
}

// Zero minus zero is zero; the unary minus would give negative zero, which
// is equal to zero in arithmetic but not to a test, a JSON encoder or a
// person reading "-0" on a screen.
function naturalBalance(kind: string, total: number): number {
  return kind === "asset" || kind === "expense" ? total : 0 - total;
}

export async function balances(db: Queryable): Promise<{ code: string; kind: string; name: string; balanceKobo: number }[]> {
  const { rows } = await db.query<{ code: string; kind: string; name: string; total: number }>(
    `SELECT a.code, a.kind, a.name, coalesce(sum(p.amount_kobo), 0)::bigint AS total
     FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_code = a.code
     GROUP BY a.code, a.kind, a.name ORDER BY a.kind, a.code`,
  );
  return rows.map((r) => ({
    code: r.code,
    kind: r.kind,
    name: r.name,
    balanceKobo: naturalBalance(r.kind, r.total),
  }));
}

// Serialises everyone who wants to read a balance before moving airtime out
// of it, so two payouts cannot both pass the same balance check.
export async function lockAccount(db: Queryable, account: string): Promise<void> {
  await db.query("SELECT code FROM ledger_accounts WHERE code = $1 FOR UPDATE", [account]);
}
