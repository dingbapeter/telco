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

export type Agent = { id: number; code: string; name: string; phone: string; email: string | null; active: boolean; created_at: Date };

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
      "INSERT INTO agents (code, name, phone, email, password_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING RETURNING id, code, name, phone, email, active, created_at",
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
  return (await db.query<Agent>("SELECT id, code, name, phone, email, active, created_at FROM agents WHERE id = $1", [id])).rows[0];
}

export async function agentByCode(db: Queryable, code: string): Promise<Agent | undefined> {
  return (await db.query<Agent>("SELECT id, code, name, phone, email, active, created_at FROM agents WHERE code = $1 AND active", [code.trim().toUpperCase()])).rows[0];
}

export async function listAgents(db: Queryable): Promise<(Agent & { balance_kobo: number })[]> {
  const { rows } = await db.query<Agent & { balance_kobo: number }>(
    `SELECT a.id, a.code, a.name, a.phone, a.email, a.active, a.created_at,
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
  const { rows } = await db.query<Agent & { password_hash: string }>("SELECT id, code, name, phone, email, active, created_at, password_hash FROM agents WHERE phone = $1", [phone]);
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
    `SELECT a.id, a.code, a.name, a.phone, a.email, a.active, a.created_at, s.csrf_token FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r ? { agent: { id: r.id, code: r.code, name: r.name, phone: r.phone, email: r.email, active: r.active, created_at: r.created_at }, csrfToken: r.csrf_token } : undefined;
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
  const have = await walletBalance(db, agentId);
  // Money already asked for as a withdrawal is spoken for. Without this an
  // agent could ask for their balance in cash and then spend it, which
  // turns a settled withdrawal into one we cannot pay.
  const pending = await pendingWithdrawals(db, agentId);
  if (have - pending < priceKobo) {
    throw new UserFacingError(
      "wallet_low",
      pending > 0
        ? `Your wallet holds ${formatNaira(have)} with ${formatNaira(pending)} already asked for as a withdrawal, so ${formatNaira(have - pending)} is free and this costs ${formatNaira(priceKobo)}. Top up first.`
        : `Your wallet holds ${formatNaira(have)} and this costs ${formatNaira(priceKobo)}. Top up first.`,
    );
  }
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

// The agent's share of our fee on a transfer they brought, booked when the
// transfer completes. Zero commission books nothing.
export async function bookCommission(db: Queryable, agentId: number, transferId: number, reference: string, platformShareKobo: number): Promise<number> {
  const bp = await getSettingValue(db, "agent.commission_basis_points");
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

export async function agentPrice(db: Queryable, faceKobo: number): Promise<{ priceKobo: number; discountKobo: number }> {
  const [bp] = await getSettingValues(db, ["agent.discount_basis_points"] as const);
  const discountKobo = applyBasisPoints(faceKobo, bp);
  return { priceKobo: faceKobo - discountKobo, discountKobo };
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
