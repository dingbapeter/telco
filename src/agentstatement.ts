import type { Agent } from "./agents.ts";
import { agentTerms, walletAccount, walletBalance } from "./agents.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { formatNaira } from "./money.ts";
import type { NetworkCode } from "./settings.ts";

// What an agent hands their accountant, or reads to see where the month
// went: every movement of their wallet in a period, what it was, and the
// balance after it. Built from the ledger, so it can never disagree with
// the books.

export type StatementKind = "top_up" | "purchase" | "commission" | "withdrawal" | "refund" | "adjustment";

export const KIND_WORDS: Record<StatementKind, string> = {
  top_up: "Top-up",
  purchase: "Purchase",
  commission: "Commission",
  withdrawal: "Withdrawal",
  refund: "Refund",
  adjustment: "Adjustment",
};

export type StatementLine = { at: Date; kind: StatementKind; description: string; reference: string | null; changeKobo: number; balanceKobo: number };

export type StatementPurchase = { at: Date; reference: string; network_code: NetworkCode; recipient_number: string; face_kobo: number; discount_kobo: number; price_kobo: number; state: string; payment_method: string | null; batch_reference: string | null };

export type Statement = {
  agent: Agent;
  from: string;
  to: string;
  openingKobo: number;
  closingKobo: number;
  lines: StatementLine[];
  totals: Record<StatementKind, { count: number; kobo: number }>;
  purchases: StatementPurchase[];
  purchasedFaceKobo: number;
  purchasedPriceKobo: number;
  savedKobo: number;
  owedKobo: number;
  creditLimitKobo: number;
};

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });

export function lagosToday(now = new Date()): string {
  return lagosDay.format(now);
}

export function startOfLagosMonth(now = new Date()): string {
  return `${lagosToday(now).slice(0, 7)}-01`;
}

function checkDay(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UserFacingError("bad_date", `${what} should be a date like 2026-01-31.`);
  // Date.parse rolls the 30th of February into March, so the only way to
  // know the date was real is to write it back out and compare.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new UserFacingError("bad_date", `${what} is not a real date.`);
  return value;
}

// Our own idempotency keys say what each journal was for, so the kind is
// read from them rather than guessed from the words a person will change.
export function kindOf(idempotencyKey: string): StatementKind {
  if (/^agent:\d+:topup:/.test(idempotencyKey)) return "top_up";
  if (/^order:.+:wallet$/.test(idempotencyKey)) return "purchase";
  if (/:commission$/.test(idempotencyKey)) return "commission";
  if (/^withdrawal:\d+:paid$/.test(idempotencyKey)) return "withdrawal";
  if (/:refund$/.test(idempotencyKey)) return "refund";
  return "adjustment";
}

export async function buildStatement(db: Queryable, agent: Agent, range: { from?: string | undefined; to?: string | undefined } = {}, now = new Date()): Promise<Statement> {
  const from = checkDay(range.from?.trim() || startOfLagosMonth(now), "The start date");
  const to = checkDay(range.to?.trim() || lagosToday(now), "The end date");
  if (from > to) throw new UserFacingError("dates_backwards", "The start date is after the end date. Swap them.");
  const account = walletAccount(agent.id);
  // Both ends read in Lagos time, and the end date is included in full, so
  // a statement to the last day of the month holds that day's business.
  const opening = (await db.query<{ total: number }>(
    `SELECT coalesce(sum(-p.amount_kobo), 0)::bigint AS total FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id
     WHERE p.account_code = $1 AND j.posted_at < ($2::date) AT TIME ZONE 'Africa/Lagos'`,
    [account, from],
  )).rows[0]!.total;
  const moves = (await db.query<{ at: Date; description: string; reference: string | null; idempotency_key: string; change_kobo: number }>(
    `SELECT j.posted_at AS at, j.description, j.reference, j.idempotency_key, -p.amount_kobo AS change_kobo
     FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id
     WHERE p.account_code = $1 AND j.posted_at >= ($2::date) AT TIME ZONE 'Africa/Lagos' AND j.posted_at < ($3::date + 1) AT TIME ZONE 'Africa/Lagos'
     ORDER BY j.id`,
    [account, from, to],
  )).rows;
  const totals = Object.fromEntries(Object.keys(KIND_WORDS).map((k) => [k, { count: 0, kobo: 0 }])) as Statement["totals"];
  let running = opening;
  const lines: StatementLine[] = [];
  for (const m of moves) {
    running += m.change_kobo;
    const kind = kindOf(m.idempotency_key);
    totals[kind].count += 1;
    totals[kind].kobo += m.change_kobo;
    lines.push({ at: m.at, kind, description: m.description, reference: m.reference, changeKobo: m.change_kobo, balanceKobo: running });
  }
  const purchases = (await db.query<StatementPurchase>(
    `SELECT o.created_at AS at, o.reference, o.network_code, o.recipient_number, o.face_kobo, o.discount_kobo, o.price_kobo, o.state, o.payment_method, b.reference AS batch_reference
     FROM orders o LEFT JOIN agent_batches b ON b.id = o.batch_id
     WHERE o.agent_id = $1 AND o.created_at >= ($2::date) AT TIME ZONE 'Africa/Lagos' AND o.created_at < ($3::date + 1) AT TIME ZONE 'Africa/Lagos'
     ORDER BY o.id`,
    [agent.id, from, to],
  )).rows;
  // What the airtime was worth against what the agent paid for it: the
  // number a shop wants, because the difference is their margin.
  const counted = purchases.filter((p) => p.state !== "refunded" && p.state !== "cancelled" && p.state !== "expired");
  const purchasedFaceKobo = counted.reduce((n, p) => n + p.face_kobo, 0);
  const purchasedPriceKobo = counted.reduce((n, p) => n + p.price_kobo, 0);
  const closingKobo = running;
  const terms = await agentTerms(db, agent.id);
  const nowBalance = await walletBalance(db, agent.id);
  return {
    agent,
    from,
    to,
    openingKobo: opening,
    closingKobo,
    lines,
    totals,
    purchases,
    purchasedFaceKobo,
    purchasedPriceKobo,
    savedKobo: purchasedFaceKobo - purchasedPriceKobo,
    owedKobo: Math.max(0, -nowBalance),
    creditLimitKobo: terms.creditLimitKobo,
  };
}

// A cell that starts with one of these is read as a formula by spreadsheet
// programs, so it is quoted with a leading apostrophe. A customer's name
// beginning with an equals sign must not run as code on someone's machine.
function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const csvDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
// "2026-09-30 14:05" in Lagos time. Used in the files and on the pages, so
// a line in a spreadsheet and the same line on the screen read alike.
export const lagosStamp = (d: Date): string => csvDay.format(d).replace(", ", " ");
const stamp = lagosStamp;

// Amounts in the file are naira with two decimals, which is what a
// spreadsheet and an accountant both expect. Kobo never leave the code.
const amount = (kobo: number): string => (kobo / 100).toFixed(2);

export function movementsCsv(s: Statement): string {
  const rows = [
    ["Date", "Kind", "Entry", "Reference", "Money in", "Money out", "Balance"],
    ["", "", `Opening balance on ${s.from}`, "", "", "", amount(s.openingKobo)],
    ...s.lines.map((l) => [stamp(l.at), KIND_WORDS[l.kind], l.description, l.reference ?? "", l.changeKobo > 0 ? amount(l.changeKobo) : "", l.changeKobo < 0 ? amount(-l.changeKobo) : "", amount(l.balanceKobo)]),
    ["", "", `Closing balance on ${s.to}`, "", "", "", amount(s.closingKobo)],
  ];
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function purchasesCsv(s: Statement): string {
  const rows = [
    ["Date", "Reference", "Batch", "Network", "Number", "Face value", "Discount", "Paid", "Paid from", "State"],
    ...s.purchases.map((p) => [stamp(p.at), p.reference, p.batch_reference ?? "", p.network_code, p.recipient_number, amount(p.face_kobo), amount(p.discount_kobo), amount(p.price_kobo), p.payment_method ?? "not paid", p.state.replaceAll("_", " ")]),
  ];
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function statementFileName(s: Statement, what: "movements" | "purchases"): string {
  return `telco-${s.agent.code}-${what}-${s.from}-to-${s.to}.csv`;
}

// Read on the wallet page and in the interface: one line that says where
// the month stands.
export function statementSummary(s: Statement): string {
  return `${s.purchases.length} purchases worth ${formatNaira(s.purchasedFaceKobo)} bought for ${formatNaira(s.purchasedPriceKobo)}, ${formatNaira(s.totals.commission.kobo)} in commission, closing at ${formatNaira(s.closingKobo)}.`;
}
