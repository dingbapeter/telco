import { createHash, randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./auth.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { balance, lockAccount, postJournal } from "./ledger.ts";
import { applyBasisPoints, assertKobo, formatNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import { clearLoginFailures, loginWait, recordLoginFailure, resetLoginThrottle } from "./throttle.ts";
import { getSettingValue, getSettingValues } from "./settings.ts";

export type Agent = {
  id: number;
  code: string;
  name: string;
  phone: string;
  email: string | null;
  active: boolean;
  created_at: Date;
  // Null means the rate in Settings applies. A number here is a rate
  // agreed with this agent alone.
  discount_basis_points: number | null;
  commission_basis_points: number | null;
  credit_limit_kobo: number;
};

const COLUMNS = "id, code, name, phone, email, active, created_at, discount_basis_points, commission_basis_points, credit_limit_kobo";

export const AGENT_SESSION_DAYS = 30;

// Codes an agent can say aloud and a sender can type: no 0, O, 1, I or L.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newAgentCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function walletAccount(agentId: number): string {
  return `agent:${agentId}`;
}

// A person creates the agent and hands them a first password; the agent
// changes it on first login. The wallet is a ledger account of its own.
export async function createAgent(db: Queryable, input: { name: string; phone: string; email?: string | undefined; password?: string | undefined }): Promise<{ agent: Agent; password: string }> {
  const phone = normaliseNigerianNumber(input.phone);
  if (!phone) throw new UserFacingError("bad_phone", "The agent's phone should be a Nigerian mobile number like 08031234567.");
  if (!input.name.trim()) throw new UserFacingError("missing_name", "Give the agent a name.");
  const password = input.password ?? randomBytes(9).toString("base64url");
  const hash = await hashPassword(password);
  let agent: Agent | undefined;
  for (let attempt = 0; attempt < 5 && !agent; attempt++) {
    const { rows } = await db.query<Agent>(
      `INSERT INTO agents (code, name, phone, email, password_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING RETURNING ${COLUMNS}`,
      [newAgentCode(), input.name.trim(), phone, input.email?.trim() || null, hash],
    ).catch((err: { code?: string }) => {
      if (err.code === "23505") throw new UserFacingError("duplicate_phone", "An agent with that phone number already exists.");
      throw err;
    });
    agent = rows[0];
  }
  if (!agent) throw new Error("Could not find a free agent code.");
  await db.query("INSERT INTO ledger_accounts (code, kind, name) VALUES ($1, 'liability', $2) ON CONFLICT (code) DO NOTHING", [walletAccount(agent.id), `Wallet of agent ${agent.code} (${agent.name})`]);
  return { agent, password };
}

export async function getAgent(db: Queryable, id: number): Promise<Agent | undefined> {
  return (await db.query<Agent>(`SELECT ${COLUMNS} FROM agents WHERE id = $1`, [id])).rows[0];
}

export async function agentByCode(db: Queryable, code: string): Promise<Agent | undefined> {
  return (await db.query<Agent>(`SELECT ${COLUMNS} FROM agents WHERE code = $1 AND active`, [code.trim().toUpperCase()])).rows[0];
}

export async function listAgents(db: Queryable): Promise<(Agent & { balance_kobo: number })[]> {
  const { rows } = await db.query<Agent & { balance_kobo: number }>(
    `SELECT a.id, a.code, a.name, a.phone, a.email, a.active, a.created_at, a.discount_basis_points, a.commission_basis_points, a.credit_limit_kobo,
            -coalesce((SELECT sum(amount_kobo) FROM ledger_postings p WHERE p.account_code = 'agent:' || a.id), 0)::bigint AS balance_kobo
     FROM agents a ORDER BY a.created_at DESC`,
  );
  return rows;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resetAgentLoginLimits(): void {
  resetLoginThrottle();
}

export async function agentLogin(db: Queryable, phoneText: string, password: string, now = Date.now(), from = ""): Promise<{ token: string; csrfToken: string; agent: Agent }> {
  const enabled = await getSettingValue(db, "agent.enabled");
  if (!enabled) throw new UserFacingError("agents_off", "Agent accounts are not open at the moment.");
  const phone = normaliseNigerianNumber(phoneText) ?? phoneText.trim();
  const wait = loginWait(phone, from, now);
  if (wait > 0) throw new UserFacingError("too_many_attempts", `Too many wrong passwords. Wait ${Math.ceil(wait / 1000)} seconds and try again.`);
  const { rows } = await db.query<Agent & { password_hash: string }>(`SELECT ${COLUMNS}, password_hash FROM agents WHERE phone = $1`, [phone]);
  const a = rows[0];
  const ok = a !== undefined && a.active && (await verifyPassword(password, a.password_hash));
  if (!ok) {
    // A number nobody has an account for costs the same to try as one that
    // does, so nobody can walk the numbers to learn who our agents are.
    if (a === undefined) await verifyPassword(password, DUMMY_HASH);
    recordLoginFailure(phone, from, now);
    throw new UserFacingError("bad_login", "That phone number and password do not match.");
  }
  clearLoginFailures(phone);
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(16).toString("base64url");
  await db.query("INSERT INTO agent_sessions (token_hash, agent_id, expires_at, csrf_token) VALUES ($1, $2, now() + make_interval(days => $3), $4)", [hashToken(token), a!.id, AGENT_SESSION_DAYS, csrfToken]);
  const { password_hash: _ignored, ...safe } = a!;
  return { token, csrfToken, agent: safe };
}

export async function forgetOldAgentSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM agent_sessions WHERE expires_at < now()");
  return rowCount ?? 0;
}

export async function agentFromToken(db: Queryable, token: string | undefined): Promise<{ agent: Agent; csrfToken: string } | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<Agent & { csrf_token: string }>(
    `SELECT a.id, a.code, a.name, a.phone, a.email, a.active, a.created_at, a.discount_basis_points, a.commission_basis_points, a.credit_limit_kobo, s.csrf_token FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return undefined;
  const { csrf_token, ...agent } = r;
  return { agent, csrfToken: csrf_token };
}

export async function agentLogout(db: Queryable, token: string | undefined): Promise<void> {
  if (token) await db.query("DELETE FROM agent_sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function changeAgentPassword(db: Queryable, agentId: number, current: string, next: string): Promise<void> {
  const { rows } = await db.query<{ password_hash: string }>("SELECT password_hash FROM agents WHERE id = $1", [agentId]);
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) throw new UserFacingError("wrong_password", "The current password is not right.");
  await db.query("UPDATE agents SET password_hash = $2 WHERE id = $1", [agentId, await hashPassword(next)]);
  await db.query("DELETE FROM agent_sessions WHERE agent_id = $1", [agentId]);
}

export async function resetAgentPassword(db: Queryable, agentId: number): Promise<string> {
  const password = randomBytes(9).toString("base64url");
  await db.query("UPDATE agents SET password_hash = $2 WHERE id = $1", [agentId, await hashPassword(password)]);
  await db.query("DELETE FROM agent_sessions WHERE agent_id = $1", [agentId]);
  return password;
}

export async function walletBalance(db: Queryable, agentId: number): Promise<number> {
  return balance(db, walletAccount(agentId));
}

export type AgentTerms = {
  discountBasisPoints: number;
  commissionBasisPoints: number;
  // Whether the rate is this agent's own or the one in Settings, so the
  // pages can say which and the founder is never guessing.
  ownDiscount: boolean;
  ownCommission: boolean;
  creditLimitKobo: number;
  creditEnabled: boolean;
  creditDays: number;
};

// What this agent buys at, earns and may owe. One row and one settings read.
export async function agentTerms(db: Queryable, agentId: number): Promise<AgentTerms> {
  const { rows } = await db.query<{ discount_basis_points: number | null; commission_basis_points: number | null; credit_limit_kobo: number }>(
    "SELECT discount_basis_points, commission_basis_points, credit_limit_kobo FROM agents WHERE id = $1",
    [agentId],
  );
  const row = rows[0];
  if (!row) throw new UserFacingError("no_such_agent", "There is no agent with that id.");
  const [discount, commission, creditEnabled, creditDays] = await getSettingValues(db, ["agent.discount_basis_points", "agent.commission_basis_points", "agent.credit_enabled", "agent.credit_days"] as const);
  return {
    discountBasisPoints: row.discount_basis_points ?? discount,
    commissionBasisPoints: row.commission_basis_points ?? commission,
    ownDiscount: row.discount_basis_points !== null,
    ownCommission: row.commission_basis_points !== null,
    creditLimitKobo: row.credit_limit_kobo,
    creditEnabled,
    creditDays,
  };
}

export const MAX_AGENT_DISCOUNT_BASIS_POINTS = 2_000;
export const MAX_AGENT_COMMISSION_BASIS_POINTS = 10_000;

export type TermsInput = { discountBasisPoints: number | null; commissionBasisPoints: number | null; creditLimitKobo: number };

// The founder writes an agent's own rate and credit line here. Empty puts
// the agent back on the rate in Settings.
export async function setAgentTerms(db: Queryable, agentId: number, input: TermsInput): Promise<Agent> {
  const inRange = (v: number | null, max: number, what: string): void => {
    if (v === null) return;
    if (!Number.isInteger(v) || v < 0 || v > max) throw new UserFacingError("rate_out_of_range", `${what} must be a whole number of basis points between 0 and ${max}, which is ${max / 100} percent. Leave it empty to use the rate in Settings.`);
  };
  inRange(input.discountBasisPoints, MAX_AGENT_DISCOUNT_BASIS_POINTS, "The discount");
  inRange(input.commissionBasisPoints, MAX_AGENT_COMMISSION_BASIS_POINTS, "The share of our fee");
  assertKobo(input.creditLimitKobo);
  if (input.creditLimitKobo < 0) throw new UserFacingError("bad_credit_limit", "A credit line cannot be less than nothing.");
  const [ceiling] = await getSettingValues(db, ["agent.credit_max_kobo"] as const);
  if (input.creditLimitKobo > ceiling) {
    throw new UserFacingError(
      "credit_above_ceiling",
      ceiling === 0
        ? "No credit line can be given until you set the largest credit line one agent may have, under Settings, Agents."
        : `The largest credit line one agent may have is ${formatNaira(ceiling)}. Raise it under Settings, Agents first if you mean to give more.`,
    );
  }
  const { rows } = await db.query<Agent>(
    `UPDATE agents SET discount_basis_points = $2, commission_basis_points = $3, credit_limit_kobo = $4 WHERE id = $1 RETURNING ${COLUMNS}`,
    [agentId, input.discountBasisPoints, input.commissionBasisPoints, input.creditLimitKobo],
  );
  const a = rows[0];
  if (!a) throw new UserFacingError("no_such_agent", "There is no agent with that id.");
  return a;
}

// When the wallet last went below zero and has stayed there. Worked out from
// the wallet's own postings rather than kept in a column, because postings
// cannot be edited and a column can fall out of step with them.
export async function owingSince(db: Queryable, agentId: number): Promise<Date | null> {
  const { rows } = await db.query<{ since: Date | null }>(
    `WITH moves AS (
       SELECT j.id, j.posted_at, sum(-p.amount_kobo) OVER (ORDER BY j.id) AS running
       FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id
       WHERE p.account_code = $1
     )
     SELECT min(posted_at) AS since FROM moves
     WHERE running < 0 AND id > coalesce((SELECT max(id) FROM moves WHERE running >= 0), 0)`,
    [walletAccount(agentId)],
  );
  return rows[0]?.since ?? null;
}

export type Spendable = {
  balanceKobo: number;
  pendingKobo: number;
  creditLimitKobo: number;
  // What the agent owes us now, and how much of the credit line is left.
  owedKobo: number;
  creditFreeKobo: number;
  freeKobo: number;
  owingSince: Date | null;
  // Set when a credit line exists but cannot be drawn on, with the reason
  // in words the agent can act on.
  creditClosed: string | null;
};

// Everything the buy pages, the interface and the wallet page need to say
// what this agent can spend and why.
export async function spendable(db: Queryable, agentId: number, now = new Date()): Promise<Spendable> {
  const terms = await agentTerms(db, agentId);
  const balanceKobo = await walletBalance(db, agentId);
  const pendingKobo = await pendingWithdrawals(db, agentId);
  const since = terms.creditLimitKobo > 0 || balanceKobo < 0 ? await owingSince(db, agentId) : null;
  const owedKobo = Math.max(0, -balanceKobo);
  let creditClosed: string | null = null;
  if (terms.creditLimitKobo > 0 && !terms.creditEnabled) creditClosed = "Credit lines are paused at the moment, so only the money in your wallet can be spent.";
  else if (terms.creditLimitKobo > 0 && since !== null && now.getTime() - since.getTime() > terms.creditDays * 86_400_000) {
    creditClosed = `Your credit line has been owing since ${since.toISOString().slice(0, 10)}, longer than the ${terms.creditDays} days allowed, so it is closed until you top up enough to clear ${formatNaira(owedKobo)}.`;
  }
  const usable = creditClosed === null ? terms.creditLimitKobo : 0;
  return {
    balanceKobo,
    pendingKobo,
    creditLimitKobo: terms.creditLimitKobo,
    owedKobo,
    creditFreeKobo: Math.max(0, usable - owedKobo),
    freeKobo: balanceKobo - pendingKobo + usable,
    owingSince: since,
    creditClosed,
  };
}

// Money the agent paid us goes into their wallet. Recorded once per payment.
export async function topUpWallet(db: Queryable, agentId: number, input: { reference: string; paidKobo: number; feeKobo: number; cashAccount: string; method: string }): Promise<{ posted: boolean }> {
  assertKobo(input.paidKobo);
  const postings = [
    { account: input.cashAccount, amountKobo: input.paidKobo - input.feeKobo },
    { account: walletAccount(agentId), amountKobo: -input.paidKobo },
  ];
  if (input.feeKobo > 0) postings.push({ account: "expense:payment_fees", amountKobo: input.feeKobo });
  const r = await postJournal(db, { idempotencyKey: `agent:${agentId}:topup:${input.reference}`, description: `Wallet top-up of ${formatNaira(input.paidKobo)} by agent ${agentId} via ${input.method}, ${input.reference}`, reference: input.reference, postings });
  return { posted: r.posted };
}

// An agent buys for a customer from their wallet: the price, less the
// agent's discount, moves from the wallet to what is owed to buyers, and
// the order is paid at once.
export async function chargeWallet(db: pg.PoolClient, agentId: number, priceKobo: number, reference: string): Promise<void> {
  await lockAccount(db, walletAccount(agentId));
  // Money already asked for as a withdrawal is spoken for. Without this an
  // agent could ask for their balance in cash and then spend it, which
  // turns a settled withdrawal into one we cannot pay. A credit line adds
  // to what can be spent; nothing else does.
  const room = await spendable(db, agentId);
  if (room.freeKobo < priceKobo) throw new UserFacingError("wallet_low", walletLowMessage(room, priceKobo));
  await postJournal(db, {
    idempotencyKey: `order:${reference}:wallet`,
    description: `Agent ${agentId} paid ${formatNaira(priceKobo)} from wallet for ${reference}`,
    reference,
    postings: [
      { account: walletAccount(agentId), amountKobo: priceKobo },
      { account: "owed:buyers", amountKobo: -priceKobo },
    ],
  });
}

// Why a purchase was refused, in one sentence that names the next move.
// Written out here because four different pages show it.
function walletLowMessage(room: Spendable, priceKobo: number): string {
  // Nothing else to explain when the agent is plain prepaid.
  if (room.pendingKobo === 0 && room.creditLimitKobo === 0) return `Your wallet holds ${formatNaira(room.balanceKobo)} and this costs ${formatNaira(priceKobo)}. Top up first.`;
  const parts = [`Your wallet holds ${formatNaira(room.balanceKobo)}`];
  if (room.pendingKobo > 0) parts.push(`${formatNaira(room.pendingKobo)} of it is already asked for as a withdrawal`);
  if (room.creditLimitKobo > 0 && room.creditClosed === null) parts.push(`your credit line of ${formatNaira(room.creditLimitKobo)} has ${formatNaira(room.creditFreeKobo)} left`);
  return `${parts.join(", and ")}. That leaves ${formatNaira(room.freeKobo)} to spend and this costs ${formatNaira(priceKobo)}.${room.creditClosed ? ` ${room.creditClosed}` : " Top up first."}`;
}

// The agent's share of our fee on a transfer they brought, booked when the
// transfer completes. Zero commission books nothing.
export async function bookCommission(db: Queryable, agentId: number, transferId: number, reference: string, platformShareKobo: number): Promise<number> {
  const bp = (await agentTerms(db, agentId)).commissionBasisPoints;
  const commission = applyBasisPoints(platformShareKobo, bp);
  if (commission <= 0) return 0;
  await postJournal(db, {
    idempotencyKey: `transfer:${transferId}:commission`,
    description: `Commission of ${formatNaira(commission)} to agent ${agentId} on ${reference}`,
    reference,
    postings: [
      { account: "expense:agent_commissions", amountKobo: commission },
      { account: walletAccount(agentId), amountKobo: -commission },
    ],
  });
  await db.query("UPDATE transfers SET agent_commission_kobo = $2 WHERE id = $1", [transferId, commission]);
  return commission;
}

// What this agent pays for airtime or a bundle with a face value of so
// much. Their own rate if they have one, otherwise the rate in Settings.
export async function agentPrice(db: Queryable, faceKobo: number, agentId: number): Promise<{ priceKobo: number; discountKobo: number; discountBasisPoints: number }> {
  const bp = (await agentTerms(db, agentId)).discountBasisPoints;
  const discountKobo = applyBasisPoints(faceKobo, bp);
  return { priceKobo: faceKobo - discountKobo, discountKobo, discountBasisPoints: bp };
}

export type Withdrawal = { id: number; agent_id: number; amount_kobo: number; bank_details: string; state: "requested" | "paid" | "declined"; requested_at: Date; settled_at: Date | null; settled_by: string | null; reference: string | null; note: string | null };

// Money an agent has asked for and we have not yet sent.
export async function pendingWithdrawals(db: Queryable, agentId: number): Promise<number> {
  const { rows } = await db.query<{ total: number }>("SELECT coalesce(sum(amount_kobo), 0)::bigint AS total FROM agent_withdrawals WHERE agent_id = $1 AND state = 'requested'", [agentId]);
  return Number(rows[0]!.total);
}

export async function requestWithdrawal(db: pg.PoolClient, agentId: number, amountKobo: number, bankDetails: string): Promise<Withdrawal> {
  assertKobo(amountKobo);
  if (amountKobo <= 0) throw new UserFacingError("bad_amount", "The amount must be more than zero.");
  if (!bankDetails.trim()) throw new UserFacingError("missing_bank", "Say which bank and account the money should go to.");
  await lockAccount(db, walletAccount(agentId));
  const have = await walletBalance(db, agentId);
  const pending = await pendingWithdrawals(db, agentId);
  // A credit line is ours to lend for buying airtime, never money to take
  // out in cash, so this reads the wallet itself and not the room to spend.
  if (have <= 0) throw new UserFacingError("wallet_low", have < 0 ? `Your wallet is at ${formatNaira(have)}, so you owe ${formatNaira(-have)} and there is nothing to withdraw.` : "Your wallet is empty, so there is nothing to withdraw.");
  if (amountKobo + pending > have) throw new UserFacingError("wallet_low", `Your wallet holds ${formatNaira(have)}${pending > 0 ? ` with ${formatNaira(pending)} already requested` : ""}. Ask for ${formatNaira(have - pending)} or less.`);
  return (await db.query<Withdrawal>("INSERT INTO agent_withdrawals (agent_id, amount_kobo, bank_details) VALUES ($1, $2, $3) RETURNING *", [agentId, amountKobo, bankDetails.trim()])).rows[0]!;
}

// A person sent the money by bank transfer and records it, once.
export async function settleWithdrawal(db: pg.PoolClient, actor: string, id: number, outcome: "paid" | "declined", reference: string): Promise<Withdrawal> {
  const w = (await db.query<Withdrawal>("SELECT * FROM agent_withdrawals WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!w) throw new UserFacingError("no_such_withdrawal", "There is no withdrawal with that id.");
  if (w.state !== "requested") throw new UserFacingError("already_settled", `That withdrawal is already ${w.state}.`);
  if (outcome === "paid") {
    await lockAccount(db, walletAccount(w.agent_id));
    const have = await walletBalance(db, w.agent_id);
    if (have < w.amount_kobo) throw new UserFacingError("wallet_low", `The agent's wallet holds ${formatNaira(have)}, less than the ${formatNaira(w.amount_kobo)} requested. Decline it and ask them to request again.`);
    await postJournal(db, {
      idempotencyKey: `withdrawal:${w.id}:paid`,
      description: `Withdrawal of ${formatNaira(w.amount_kobo)} paid to agent ${w.agent_id}, bank reference ${reference}`,
      reference,
      postings: [
        { account: walletAccount(w.agent_id), amountKobo: w.amount_kobo },
        { account: "cash:bank", amountKobo: -w.amount_kobo },
      ],
    });
  }
  return (await db.query<Withdrawal>("UPDATE agent_withdrawals SET state = $2, settled_at = now(), settled_by = $3, reference = $4 WHERE id = $1 RETURNING *", [id, outcome, actor, reference])).rows[0]!;
}
