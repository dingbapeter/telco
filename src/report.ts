import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { START_OF_TODAY } from "./receiving.ts";

// What the business holds, what it owes, and what it earned. Every figure
// here is read from the ledger, which cannot be edited, so this page and
// the books can never disagree. Nothing is cached and nothing is kept in a
// second table that could drift.

export type Line = { code: string; name: string; kobo: number };

// The ledger's own names describe an account to somebody reading the books.
// On a phone they push the amount off the screen, so the money page uses
// these instead, and falls back to the ledger's name for anything new.
const SHORT: Record<string, string> = {
  "cash:bank": "Our bank account",
  "cash:paystack": "Held by Paystack",
  "wallet:vtpass": "Provider wallet",
  "owed:senders": "Senders not yet paid out",
  "owed:buyers": "Buyers not yet delivered",
  "owed:sellers": "Sellers not yet paid",
  "revenue:fees": "Our share of transfer fees",
  "revenue:provider_commission": "Commission from the provider",
  "revenue:sellback_margin": "Margin on what we buy back",
  "revenue:voided_credit": "Credit stopped",
  "expense:retail_discounts": "Discounts given to buyers",
  "expense:agent_commissions": "Commission paid to agents",
  "expense:payment_fees": "Payment provider's fees",
  "expense:losses": "Airtime and data lost",
};

export function shortName(code: string, name: string): string {
  if (SHORT[code]) return SHORT[code];
  const pool = /^pool:(.+)$/.exec(code);
  if (pool) return `${pool[1]} airtime`;
  const data = /^datapool:(.+)$/.exec(code);
  if (data) return `${data[1]} data`;
  const owed = /^owed:(.+)$/.exec(code);
  if (owed) return `${owed[1]}'s share of fees`;
  return name;
}

export type BalanceSheet = {
  held: Line[];
  owed: Line[];
  heldKobo: number;
  owedKobo: number;
  // What is left when everybody else has been paid: the founder's money in
  // the business plus whatever it has earned since.
  ownKobo: number;
  putInKobo: number;
  earnedKobo: number;
  // The books add up when these two agree, and a deferred trigger in the
  // database makes sure they do. Shown because a figure a person can check
  // is worth more than a promise.
  addsUp: boolean;
};

// Assets and expenses grow with debits, everything else with credits, so
// every account reads as a positive number when it is healthy.
const NATURAL = "CASE WHEN a.kind IN ('asset', 'expense') THEN coalesce(sum(p.amount_kobo), 0) ELSE -coalesce(sum(p.amount_kobo), 0) END";

async function linesOf(db: Queryable, kinds: string[], where = "", params: unknown[] = []): Promise<Line[]> {
  const { rows } = await db.query<{ code: string; name: string; kobo: number }>(
    `SELECT a.code, a.name, (${NATURAL})::bigint AS kobo
     FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_code = a.code
     ${where ? `AND ${where}` : ""}
     WHERE a.kind = ANY($${params.length + 1})
     GROUP BY a.code, a.name, a.kind ORDER BY a.code`,
    [...params, kinds],
  );
  return rows.map((r) => ({ ...r, name: shortName(r.code, r.name) }));
}

// Agent wallets are one line each in the ledger and one line between them
// on the page: a shop's balance is their business, and the founder needs
// the total they are holding for everybody.
function foldAgentWallets(lines: Line[]): Line[] {
  const wallets = lines.filter((l) => l.code.startsWith("agent:"));
  if (wallets.length === 0) return lines;
  const total = wallets.reduce((n, l) => n + l.kobo, 0);
  return [
    ...lines.filter((l) => !l.code.startsWith("agent:")),
    { code: "agent:*", name: `Agents' wallets (${wallets.length})`, kobo: total },
  ];
}

// The books add up when what is left after everybody else has been paid is
// exactly what the founder put in plus what has been earned since. A
// deferred trigger in the database already refuses any journal that would
// break this, so it is an alarm that should never sound. It is kept, and
// kept as its own arithmetic, because an alarm nobody can read is not worth
// having and one that cannot be tested is not worth trusting.
export function booksAddUp(s: { heldKobo: number; owedKobo: number; putInKobo: number; earnedKobo: number }): boolean {
  return s.heldKobo - s.owedKobo === s.putInKobo + s.earnedKobo;
}

export async function balanceSheet(db: Queryable): Promise<BalanceSheet> {
  const held = (await linesOf(db, ["asset"])).filter((l) => l.kobo !== 0);
  const owed = foldAgentWallets(await linesOf(db, ["liability"])).filter((l) => l.kobo !== 0);
  const equity = await linesOf(db, ["equity"]);
  const revenue = await linesOf(db, ["revenue"]);
  const expenses = await linesOf(db, ["expense"]);
  const heldKobo = held.reduce((n, l) => n + l.kobo, 0);
  const owedKobo = owed.reduce((n, l) => n + l.kobo, 0);
  const putInKobo = equity.reduce((n, l) => n + l.kobo, 0);
  const earnedKobo = revenue.reduce((n, l) => n + l.kobo, 0) - expenses.reduce((n, l) => n + l.kobo, 0);
  const ownKobo = heldKobo - owedKobo;
  return { held, owed, heldKobo, owedKobo, ownKobo, putInKobo, earnedKobo, addsUp: booksAddUp({ heldKobo, owedKobo, putInKobo, earnedKobo }) };
}

export type Period = { from: string; to: string };

export type Volumes = {
  transfers: number;
  movedKobo: number;
  orders: number;
  soldKobo: number;
  sales: number;
  boughtKobo: number;
  agentOrders: number;
  agentKobo: number;
};

export type Day = { day: string; earnedKobo: number; spentKobo: number; profitKobo: number };

export type ProfitAndLoss = {
  from: string;
  to: string;
  earned: Line[];
  spent: Line[];
  earnedKobo: number;
  spentKobo: number;
  profitKobo: number;
  // Not ours and not a cost: the networks' share of the fee, held for them
  // until it is settled.
  networkShareKobo: number;
  volumes: Volumes;
  days: Day[];
};

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });
export const today = (now = new Date()): string => lagosDay.format(now);
export const startOfMonth = (now = new Date()): string => `${today(now).slice(0, 7)}-01`;

export function checkDay(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UserFacingError("bad_date", `${what} should be a date like 2026-01-31.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new UserFacingError("bad_date", `${what} is not a real date.`);
  return value;
}

// Both ends are read in Lagos time and the end date is included in full, so
// a month to the 31st holds that day's business.
const FROM = "($1::date) AT TIME ZONE 'Africa/Lagos'";
const TO = "($2::date + 1) AT TIME ZONE 'Africa/Lagos'";

export async function profitAndLoss(db: Queryable, range: { from?: string | undefined; to?: string | undefined } = {}, now = new Date()): Promise<ProfitAndLoss> {
  const from = checkDay(range.from?.trim() || startOfMonth(now), "The start date");
  const to = checkDay(range.to?.trim() || today(now), "The end date");
  if (from > to) throw new UserFacingError("dates_backwards", "The start date is after the end date. Swap them.");
  const inPeriod = `p.journal_id IN (SELECT id FROM ledger_journals WHERE posted_at >= ${FROM} AND posted_at < ${TO})`;
  const earned = (await linesOf(db, ["revenue"], inPeriod, [from, to])).filter((l) => l.kobo !== 0);
  const spent = (await linesOf(db, ["expense"], inPeriod, [from, to])).filter((l) => l.kobo !== 0);
  const networkShare = (await linesOf(db, ["liability"], inPeriod, [from, to])).filter((l) => /^owed:(MTN|AIRTEL|GLO|9MOBILE)$/.test(l.code));
  const volumes = (await db.query<Volumes>(
    `SELECT
       (SELECT count(*)::int FROM transfers WHERE state = 'completed' AND paid_out_at >= ${FROM} AND paid_out_at < ${TO}) AS transfers,
       (SELECT coalesce(sum(received_kobo), 0)::bigint FROM transfers WHERE state = 'completed' AND paid_out_at >= ${FROM} AND paid_out_at < ${TO}) AS "movedKobo",
       (SELECT count(*)::int FROM orders WHERE state = 'delivered' AND delivered_at >= ${FROM} AND delivered_at < ${TO}) AS orders,
       (SELECT coalesce(sum(price_kobo), 0)::bigint FROM orders WHERE state = 'delivered' AND delivered_at >= ${FROM} AND delivered_at < ${TO}) AS "soldKobo",
       (SELECT count(*)::int FROM sellbacks WHERE state IN ('received', 'settled', 'paid') AND received_at >= ${FROM} AND received_at < ${TO}) AS sales,
       (SELECT coalesce(sum(pay_kobo), 0)::bigint FROM sellbacks WHERE state IN ('received', 'settled', 'paid') AND received_at >= ${FROM} AND received_at < ${TO}) AS "boughtKobo",
       (SELECT count(*)::int FROM orders WHERE state = 'delivered' AND payment_method = 'wallet' AND delivered_at >= ${FROM} AND delivered_at < ${TO}) AS "agentOrders",
       (SELECT coalesce(sum(price_kobo), 0)::bigint FROM orders WHERE state = 'delivered' AND payment_method = 'wallet' AND delivered_at >= ${FROM} AND delivered_at < ${TO}) AS "agentKobo"`,
    [from, to],
  )).rows[0]!;
  // One row per day that had any money on it, in Lagos days.
  const days = (await db.query<{ day: string; earned: number; spent: number }>(
    `SELECT to_char(j.posted_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
            coalesce(sum(CASE WHEN a.kind = 'revenue' THEN -p.amount_kobo ELSE 0 END), 0)::bigint AS earned,
            coalesce(sum(CASE WHEN a.kind = 'expense' THEN p.amount_kobo ELSE 0 END), 0)::bigint AS spent
     FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id JOIN ledger_accounts a ON a.code = p.account_code
     WHERE a.kind IN ('revenue', 'expense') AND j.posted_at >= ${FROM} AND j.posted_at < ${TO}
     GROUP BY 1 ORDER BY 1`,
    [from, to],
  )).rows;
  const earnedKobo = earned.reduce((n, l) => n + l.kobo, 0);
  const spentKobo = spent.reduce((n, l) => n + l.kobo, 0);
  return {
    from,
    to,
    earned,
    spent,
    earnedKobo,
    spentKobo,
    profitKobo: earnedKobo - spentKobo,
    networkShareKobo: networkShare.reduce((n, l) => n + l.kobo, 0),
    volumes,
    days: days.map((d) => ({ day: d.day, earnedKobo: d.earned, spentKobo: d.spent, profitKobo: d.earned - d.spent })),
  };
}

// Today's earnings, for the overview. Cheaper than the whole report.
// Revenue is credited and expenses are debited, so the profit on both is
// the same sum with the sign turned round, and no case is needed.
export async function earnedToday(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ kobo: number }>(
    `SELECT coalesce(sum(-p.amount_kobo), 0)::bigint AS kobo
     FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id JOIN ledger_accounts a ON a.code = p.account_code
     WHERE a.kind IN ('revenue', 'expense') AND j.posted_at >= ${START_OF_TODAY}`,
  );
  return rows[0]!.kobo;
}
