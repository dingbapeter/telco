import { createHash, randomInt } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { bookCommission } from "./agents.ts";
import { activeBundle, describeBundle, getBundle, type Bundle } from "./bundles.ts";
import { consumeLots, openLot } from "./datalots.ts";
import { computeFee, loadFeeRule, requiredAmountFor, type FeeBreakdown, type FeeRule } from "./fees.ts";
import { balance, lockAccount, postJournal } from "./ledger.ts";
import { assertKobo, formatNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "./settings.ts";

export type TransferState =
  | "awaiting_inbound"
  | "expired"
  | "inbound_confirmed"
  | "awaiting_approval"
  | "paying_out"
  | "completed"
  | "payout_failed"
  | "held"
  | "refunding"
  | "refunded";

export type Transfer = {
  id: number;
  reference: string;
  state: TransferState;
  from_network: NetworkCode;
  to_network: NetworkCode;
  sender_number: string;
  recipient_number: string;
  receiving_number: string;
  requested_kobo: number;
  received_kobo: number | null;
  fee_kobo: number | null;
  platform_share_kobo: number | null;
  network_share_kobo: number | null;
  payout_kobo: number | null;
  quoted_fee_kobo: number;
  quoted_payout_kobo: number;
  created_at: Date;
  expires_at: Date;
  inbound_confirmed_at: Date | null;
  paid_out_at: Date | null;
  refunded_at: Date | null;
  payout_attempts: number;
  payout_reference: string | null;
  hold_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  payout_rail: string | null;
  payout_request_id: string | null;
  payout_next_attempt_at: Date | null;
  payout_last_error: string | null;
  in_kind: "airtime" | "data";
  in_bundle_id: number | null;
  out_kind: "airtime" | "data";
  out_bundle_id: number | null;
  refund_rail: string | null;
  refund_request_id: string | null;
  agent_id: number | null;
  agent_commission_kobo: number | null;
};

// Where value received lands: airtime in the network's pool, gifted data in
// its data pool at catalogue value.
export function inboundAccount(t: Pick<Transfer, "in_kind" | "from_network">): string {
  return t.in_kind === "data" ? `datapool:${t.from_network}` : `pool:${t.from_network}`;
}

type Client = pg.PoolClient;

// Lagos midnight, because every daily limit in the product is a Nigerian day.
const START_OF_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

function isNetwork(code: string): code is NetworkCode {
  return (NETWORK_CODES as readonly string[]).includes(code);
}

// References people read out over the phone: no 0, O, 1, I or L.
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newReference(): string {
  let s = "TX-";
  for (let i = 0; i < 8; i++) s += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return s;
}

async function recordEvent(
  db: Queryable,
  transferId: number,
  from: TransferState | null,
  to: TransferState,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "INSERT INTO transfer_events (transfer_id, from_state, to_state, actor, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [transferId, from, to, actor, JSON.stringify(detail)],
  );
}

export async function getTransfer(db: Queryable, id: number): Promise<Transfer | undefined> {
  const { rows } = await db.query<Transfer>("SELECT * FROM transfers WHERE id = $1", [id]);
  return rows[0];
}

export async function getTransferByReference(db: Queryable, reference: string): Promise<Transfer | undefined> {
  const { rows } = await db.query<Transfer>("SELECT * FROM transfers WHERE reference = $1", [reference.trim().toUpperCase()]);
  return rows[0];
}

// The single way a transfer changes state. It moves zero rows when the
// transfer is not where the caller thinks it is, and the caller must treat
// that as "someone else got here first" and do no side effects.
async function claim(
  db: Queryable,
  id: number,
  from: TransferState | TransferState[],
  to: TransferState,
  extra: Record<string, unknown> = {},
): Promise<Transfer | undefined> {
  const fromStates = Array.isArray(from) ? from : [from];
  const sets = ["state = $2"];
  const params: unknown[] = [id, to, fromStates];
  for (const [col, val] of Object.entries(extra)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  const { rows } = await db.query<Transfer>(
    `UPDATE transfers SET ${sets.join(", ")} WHERE id = $1 AND state = ANY($3::text[]) RETURNING *`,
    params,
  );
  return rows[0];
}

export type QuoteInput = {
  fromNetwork: string;
  toNetwork: string;
  senderNumber: string;
  recipientNumber: string;
  // The airtime amount to send. Not needed when a bundle is being sent (its
  // catalogue value is the amount) or when a bundle is to be received (the
  // amount to send is worked out from its price).
  amountKobo?: number | undefined;
  inBundleId?: number | undefined;
  outBundleId?: number | undefined;
  // The agent who brought this sender, if any.
  agentId?: number | undefined;
};

// Works out, for a transfer whose payout must be exactly a bundle's price,
// the fee and shares from what was received: the rule's fee, the network's
// share on that, and whatever is left over above the price is ours too.
export function settleForBundle(receivedKobo: number, priceKobo: number, rule: FeeRule): FeeBreakdown {
  const base = computeFee(receivedKobo, rule);
  if (base.payoutKobo < priceKobo) throw new UserFacingError("not_enough_for_bundle", `${formatNaira(receivedKobo)} does not cover the bundle after the fee.`);
  const fee = receivedKobo - priceKobo;
  return { amountKobo: receivedKobo, feeKobo: fee, networkShareKobo: base.networkShareKobo, platformShareKobo: fee - base.networkShareKobo, payoutKobo: priceKobo };
}

// Creates a transfer waiting for airtime or data. Everything the sender is
// told comes from here: what to send, to which number, what the recipient
// will get, and by when.
export async function quoteTransfer(db: Client, actor: string, input: QuoteInput): Promise<{ transfer: Transfer; fee: FeeBreakdown; inBundle?: Bundle; outBundle?: Bundle }> {
  const from = input.fromNetwork.toUpperCase();
  const to = input.toNetwork.toUpperCase();
  if (!isNetwork(from) || !isNetwork(to)) {
    throw new UserFacingError("unknown_network", "Choose the network you are sending from and the network you are sending to.");
  }
  if (from === to) {
    throw new UserFacingError(
      "same_network",
      `Both numbers are on ${from}. Use ${from}'s own transfer code for that; this service moves airtime between different networks.`,
    );
  }
  const active = await db.query<{ code: string }>("SELECT code FROM networks WHERE code = ANY($1) AND active", [[from, to]]);
  if (active.rows.length !== 2) {
    throw new UserFacingError("network_paused", "Transfers on one of these networks are paused right now. Try again later.");
  }
  const sender = normaliseNigerianNumber(input.senderNumber);
  const recipient = normaliseNigerianNumber(input.recipientNumber);
  if (!sender) throw new UserFacingError("bad_sender_number", "The sending number should be a Nigerian mobile number like 08031234567.");
  if (!recipient) throw new UserFacingError("bad_recipient_number", "The receiving number should be a Nigerian mobile number like 08021234567.");

  const inBundle = input.inBundleId ? await activeBundle(db, input.inBundleId, from) : undefined;
  if (inBundle && !inBundle.giftable) throw new UserFacingError("not_giftable", `${describeBundle(inBundle)} cannot be gifted to us on ${from}. Choose a bundle marked as giftable.`);
  const outBundle = input.outBundleId ? await activeBundle(db, input.outBundleId, to) : undefined;
  const rule = await loadFeeRule(db, from, to);
  let amount: number;
  if (inBundle) amount = inBundle.price_kobo;
  else if (outBundle) amount = requiredAmountFor(outBundle.price_kobo, rule);
  else {
    if (input.amountKobo === undefined) throw new UserFacingError("no_amount", "Enter the amount of airtime to move.");
    amount = assertKobo(input.amountKobo);
  }
  const [min, max, dailyMax, caps, windowMinutes] = await getSettingValues(db, [
    "transfer.min_kobo",
    "transfer.max_kobo",
    "transfer.sender_daily_max_kobo",
    "network.daily_transfer_cap_kobo",
    "transfer.inbound_window_minutes",
  ] as const);
  if (amount < min && !inBundle) throw new UserFacingError("below_minimum", `The smallest transfer is ${formatNaira(min)}.`);
  if (amount > max) throw new UserFacingError("above_maximum", `The largest transfer is ${formatNaira(max)}. ${outBundle ? "Choose a smaller bundle." : "Send it in more than one transfer."}`);
  const networkCap = caps[from];
  if (!inBundle && networkCap > 0 && amount > networkCap) {
    throw new UserFacingError(
      "above_network_cap",
      `${from} only lets a subscriber transfer ${formatNaira(networkCap)} in a day, so it would refuse this. Send ${formatNaira(networkCap)} or less.`,
    );
  }
  // One number at a time, or two quotes asked for together would each see
  // the day's total without the other and both pass the limit. The lock is
  // held to the end of this transaction and taken on the number itself, so
  // it never blocks anybody else.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sender:${sender}`]);
  const today = await db.query<{ total: number }>(
    `SELECT coalesce(sum(coalesce(received_kobo, requested_kobo)), 0)::bigint AS total FROM transfers
     WHERE sender_number = $1 AND created_at >= ${START_OF_TODAY} AND state NOT IN ('expired', 'refunded')`,
    [sender],
  );
  const usedToday = today.rows[0]!.total;
  if (usedToday + amount > dailyMax) {
    const left = Math.max(0, dailyMax - usedToday);
    throw new UserFacingError("daily_limit", `This number can move ${formatNaira(dailyMax)} a day and has ${formatNaira(left)} left today.`);
  }

  let fee: FeeBreakdown;
  try {
    fee = outBundle ? settleForBundle(amount, outBundle.price_kobo, rule) : computeFee(amount, rule);
  } catch (err) {
    if (err instanceof UserFacingError && err.code === "not_enough_for_bundle" && inBundle && outBundle) {
      throw new UserFacingError("bundle_too_small", `${describeBundle(inBundle)} is worth ${formatNaira(inBundle.price_kobo)}, which does not cover ${describeBundle(outBundle)} plus the fee. Choose a smaller bundle to receive.`);
    }
    throw err;
  }

  // The receiving number with the most room left today takes the transfer.
  const receiving = await db.query<{ number: string }>(
    `SELECT r.number FROM receiving_numbers r
     LEFT JOIN LATERAL (
       SELECT coalesce(sum(coalesce(received_kobo, requested_kobo)), 0)::bigint AS used FROM transfers t
       WHERE t.receiving_number = r.number AND t.created_at >= ${START_OF_TODAY} AND t.state NOT IN ('expired', 'refunded')
     ) u ON true
     WHERE r.network_code = $1 AND r.active AND (r.daily_cap_kobo = 0 OR u.used + $2 <= r.daily_cap_kobo)
     ORDER BY CASE WHEN r.daily_cap_kobo = 0 THEN 0 ELSE u.used END ASC, r.number ASC LIMIT 1`,
    [from, amount],
  );
  const receivingNumber = receiving.rows[0]?.number;
  if (!receivingNumber) {
    throw new UserFacingError(
      "no_receiving_number",
      `No ${from} number can take this transfer right now. In the command centre under Receiving numbers, add an active ${from} number or raise a daily cap.`,
    );
  }

  const { rows } = await db.query<Transfer>(
    `INSERT INTO transfers (reference, state, from_network, to_network, sender_number, recipient_number, receiving_number,
       requested_kobo, quoted_fee_kobo, quoted_payout_kobo, expires_at, in_kind, in_bundle_id, out_kind, out_bundle_id, agent_id)
     VALUES ($1, 'awaiting_inbound', $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10), $11, $12, $13, $14, $15) RETURNING *`,
    [newReference(), from, to, sender, recipient, receivingNumber, amount, fee.feeKobo, fee.payoutKobo, windowMinutes, inBundle ? "data" : "airtime", inBundle?.id ?? null, outBundle ? "data" : "airtime", outBundle?.id ?? null, input.agentId ?? null],
  );
  const transfer = rows[0]!;
  await recordEvent(db, transfer.id, null, "awaiting_inbound", actor, { requested_kobo: amount, quoted_fee_kobo: fee.feeKobo, in_bundle: inBundle?.code ?? null, out_bundle: outBundle?.code ?? null });
  return { transfer, fee, ...(inBundle ? { inBundle } : {}), ...(outBundle ? { outBundle } : {}) };
}

// The amounts to record when value has arrived for a transfer: the fee and
// shares, the payout, or the reason it must wait for a person.
async function settlement(db: Queryable, t: Transfer, amount: number): Promise<{ fee: FeeBreakdown | null; holdReason: string | null }> {
  const [min, max] = await getSettingValues(db, ["transfer.min_kobo", "transfer.max_kobo"] as const);
  if (t.out_kind === "data") {
    // A bundle costs what it costs: the sender was told the exact amount.
    if (amount !== t.requested_kobo) return { fee: null, holdReason: amount < t.requested_kobo ? "amount_below_required" : "amount_above_required" };
    const outBundle = await activeBundle(db, t.out_bundle_id!).catch(() => undefined);
    if (!outBundle) return { fee: null, holdReason: "bundle_withdrawn" };
    try {
      return { fee: settleForBundle(amount, outBundle.price_kobo, await loadFeeRule(db, t.from_network, t.to_network)), holdReason: null };
    } catch (err) {
      // The bundle was repriced, or the fee was raised, between the quote
      // and the airtime arriving. The sender's airtime is ours and must be
      // recorded: it waits for a person rather than throwing, which would
      // roll back the message that told us about it and leave every other
      // message behind it stuck.
      if (err instanceof UserFacingError) return { fee: null, holdReason: "bundle_repriced" };
      throw err;
    }
  }
  if (t.in_kind !== "data" && amount < min) return { fee: null, holdReason: "amount_below_minimum" };
  if (amount > max) return { fee: null, holdReason: "amount_above_maximum" };
  try {
    return { fee: computeFee(amount, await loadFeeRule(db, t.from_network, t.to_network)), holdReason: null };
  } catch (err) {
    if (err instanceof UserFacingError && err.code === "fee_exceeds_amount") return { fee: null, holdReason: "fee_exceeds_amount" };
    throw err;
  }
}

export type InboundNotification = {
  networkCode: string;
  receivingNumber: string;
  senderNumber: string;
  amountKobo: number;
  rawText: string;
  source: "bridge" | "manual";
  occurredAt?: Date;
  // Set when what arrived was gifted data: the size, with amountKobo being
  // the catalogue value of a bundle of that size.
  dataMb?: number | undefined;
};

export type InboundOutcome =
  | { outcome: "duplicate"; notificationId: number }
  | { outcome: "unmatched"; notificationId: number }
  | { outcome: "matched"; notificationId: number; transfer: Transfer }
  | { outcome: "held"; notificationId: number; transfer: Transfer; reason: string };

// Records a network notification and, if a transfer is waiting for it, marks
// the airtime as received and books it. The same notification arriving twice
// is recorded once and does nothing the second time.
export async function recordInbound(db: Client, actor: string, n: InboundNotification): Promise<InboundOutcome> {
  const network = n.networkCode.toUpperCase();
  if (!isNetwork(network)) throw new UserFacingError("unknown_network", `${n.networkCode} is not a network this system knows.`);
  const receiving = normaliseNigerianNumber(n.receivingNumber);
  const sender = normaliseNigerianNumber(n.senderNumber);
  if (!receiving || !sender) {
    throw new UserFacingError("bad_notification_numbers", "The notification's sending or receiving number is not a Nigerian mobile number.");
  }
  const amount = assertKobo(n.amountKobo);
  const occurred = n.occurredAt ? n.occurredAt.toISOString() : "";
  const hash = createHash("sha256")
    .update([network, receiving, sender, amount, n.rawText.trim(), occurred].join("|"))
    .digest("hex");
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO inbound_notifications (network_code, receiving_number, sender_number, amount_kobo, raw_text, source, occurred_at, recorded_by, dedupe_hash, data_mb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_hash) DO NOTHING RETURNING id`,
    [network, receiving, sender, amount, n.rawText, n.source, n.occurredAt ?? null, actor, hash, n.dataMb ?? null],
  );
  const insertedRow = inserted.rows[0];
  if (!insertedRow) {
    const existing = await db.query<{ id: number }>("SELECT id FROM inbound_notifications WHERE dedupe_hash = $1", [hash]);
    return { outcome: "duplicate", notificationId: existing.rows[0]!.id };
  }
  const notificationId = insertedRow.id;

  const grace = await getSettingValue(db, "transfer.inbound_grace_minutes");
  // Airtime matches a transfer waiting for airtime, preferring the exact
  // amount; gifted data matches a transfer waiting for a bundle of that size.
  const candidates = n.dataMb
    ? await db.query<Transfer>(
        `SELECT t.* FROM transfers t JOIN data_bundles b ON b.id = t.in_bundle_id
         WHERE t.from_network = $1 AND t.receiving_number = $2 AND t.sender_number = $3 AND t.in_kind = 'data' AND b.size_mb = $4
           AND t.state IN ('awaiting_inbound', 'expired') AND t.expires_at + make_interval(mins => $5) > now()
         ORDER BY t.created_at ASC FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
        [network, receiving, sender, n.dataMb, grace],
      )
    : await db.query<Transfer>(
        `SELECT * FROM transfers
         WHERE from_network = $1 AND receiving_number = $2 AND sender_number = $3 AND in_kind = 'airtime'
           AND state IN ('awaiting_inbound', 'expired')
           AND expires_at + make_interval(mins => $5) > now()
         ORDER BY (requested_kobo = $4) DESC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [network, receiving, sender, amount, grace],
      );
  const candidate = candidates.rows[0];
  if (!candidate) return { outcome: "unmatched", notificationId };
  const updated = await bookInbound(db, actor, candidate, amount, notificationId, {});
  if (!updated) return { outcome: "unmatched", notificationId };
  return updated.hold_reason
    ? { outcome: "held", notificationId, transfer: updated, reason: updated.hold_reason }
    : { outcome: "matched", notificationId, transfer: updated };
}

// Value has arrived for a waiting transfer. What arrived is what we move,
// with the fee worked out on the real amount; an amount that cannot be
// moved is held for a person, with the value still booked as received.
async function bookInbound(db: Client, actor: string, candidate: Transfer, amount: number, notificationId: number, detail: Record<string, unknown>): Promise<Transfer | undefined> {
  const { fee, holdReason } = await settlement(db, candidate, amount);
  const nextState: TransferState = holdReason ? "held" : "inbound_confirmed";
  const updated = await claim(db, candidate.id, ["awaiting_inbound", "expired"], nextState, {
    received_kobo: amount,
    fee_kobo: fee?.feeKobo ?? null,
    platform_share_kobo: fee?.platformShareKobo ?? null,
    network_share_kobo: fee?.networkShareKobo ?? null,
    payout_kobo: fee?.payoutKobo ?? null,
    inbound_confirmed_at: new Date(),
    hold_reason: holdReason,
  });
  if (!updated) return undefined;
  await postJournal(db, {
    idempotencyKey: `transfer:${updated.id}:inbound`,
    description: `${updated.in_kind === "data" ? "Data" : "Airtime"} received on ${updated.from_network} for ${updated.reference}`,
    reference: updated.reference,
    postings: [
      { account: inboundAccount(updated), amountKobo: amount },
      { account: "owed:senders", amountKobo: -amount },
    ],
  });
  if (updated.in_kind === "data" && updated.in_bundle_id) {
    const b = await getBundle(db, updated.in_bundle_id);
    if (b) await openLot(db, { network: updated.from_network, bundleId: b.id, sizeMb: b.size_mb, valueKobo: amount, validityDays: b.validity_days, source: updated.reference });
  }
  await db.query("UPDATE inbound_notifications SET matched_transfer_id = $1 WHERE id = $2", [updated.id, notificationId]);
  await recordEvent(db, updated.id, candidate.state, nextState, actor, {
    notification_id: notificationId,
    received_kobo: amount,
    ...detail,
    ...(holdReason ? { hold_reason: holdReason } : {}),
  });
  return updated;
}

export type PayoutInstruction = {
  transferId: number;
  reference: string;
  network: NetworkCode;
  number: string;
  amountKobo: number;
  // Present when a bundle, not airtime, is to be delivered.
  bundle?: Bundle | undefined;
};

export type PayoutStart = { started: true; instruction: PayoutInstruction } | { started: false; state: TransferState; reason: string };

// Claims a confirmed transfer for payout after every guardrail passes: the
// second approver threshold, the daily ceiling for the destination network,
// and the pool balance read under lock. The rail that actually sends the
// airtime takes the returned instruction.
export type PayoutOptions = {
  // Where the airtime comes from: our SIM's pool for a manual payout, or the
  // provider's wallet for an automatic one.
  fundingAccount?: string;
  rail?: string;
  requestId?: string;
};

export async function startPayout(db: Client, actor: string, transferId: number, options: PayoutOptions = {}): Promise<PayoutStart> {
  const { rows } = await db.query<Transfer>("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [transferId]);
  const t = rows[0];
  if (!t) throw new UserFacingError("no_such_transfer", "There is no transfer with that id.");
  if (t.state !== "inbound_confirmed" && t.state !== "payout_failed") {
    return { started: false, state: t.state, reason: `Transfer is ${t.state.replaceAll("_", " ")}, not waiting for payout.` };
  }
  const payout = t.payout_kobo!;
  const [autoMax, ceilings] = await getSettingValues(db, ["payout.auto_approve_max_kobo", "payout.daily_ceiling_kobo"] as const);
  if (payout > autoMax && !t.approved_by) {
    const moved = await claim(db, t.id, t.state, "awaiting_approval");
    if (moved) await recordEvent(db, t.id, t.state, "awaiting_approval", actor, { payout_kobo: payout, threshold_kobo: autoMax });
    return {
      started: false,
      state: "awaiting_approval",
      reason: `Payout of ${formatNaira(payout)} is above the ${formatNaira(autoMax)} threshold and needs an administrator's approval.`,
    };
  }
  const funding = options.fundingAccount ?? `pool:${t.to_network}`;
  await lockAccount(db, funding);
  // Both guardrails are read under this lock, so two payouts starting
  // together cannot each see a pool or a day's total without the other.
  //
  // The day's payouts are counted by when the payout happened, not when the transfer was asked
  // for: a transfer quoted before midnight and paid after it belongs to the
  // day it was paid, and would otherwise fall between the two days and
  // count against neither.
  const paidToday = await db.query<{ total: number }>(
    `SELECT coalesce(sum(payout_kobo), 0)::bigint AS total FROM transfers
     WHERE to_network = $1 AND (state = 'paying_out' OR (state = 'completed' AND paid_out_at >= ${START_OF_TODAY}))`,
    [t.to_network],
  );
  const ceiling = ceilings[t.to_network];
  if (paidToday.rows[0]!.total + payout > ceiling) {
    const moved = await claim(db, t.id, t.state, "held", { hold_reason: "daily_payout_ceiling" });
    if (moved) await recordEvent(db, t.id, t.state, "held", actor, { hold_reason: "daily_payout_ceiling", ceiling_kobo: ceiling });
    return {
      started: false,
      state: "held",
      reason: `Paying ${formatNaira(payout)} would take today's ${t.to_network} payouts past the ${formatNaira(ceiling)} ceiling. Raise the ceiling in the command centre under Guardrails, or release it tomorrow.`,
    };
  }
  // What the account holds, less what is already on its way out of it: a
  // payout in flight has left the SIM but not yet the ledger.
  const available = (await balance(db, funding)) - (await committedAgainst(db, funding));
  if (available < payout) {
    const moved = await claim(db, t.id, t.state, "held", { hold_reason: "pool_too_low" });
    if (moved) await recordEvent(db, t.id, t.state, "held", actor, { hold_reason: "pool_too_low", account: funding, available_kobo: available });
    const where = funding.startsWith("wallet:") ? `Record money added to the provider wallet under Pools` : `Top up the ${t.to_network} pool`;
    return {
      started: false,
      state: "held",
      reason: `${funding === `pool:${t.to_network}` ? `The ${t.to_network} pool` : "The provider wallet"} holds ${formatNaira(available)} and this payout needs ${formatNaira(payout)}. ${where}, then release the transfer.`,
    };
  }
  const moved = await claim(db, t.id, t.state, "paying_out", {
    payout_attempts: t.payout_attempts + 1,
    payout_rail: options.rail ?? "manual",
    payout_request_id: options.requestId ?? null,
    payout_next_attempt_at: null,
    payout_funding_account: funding,
  });
  if (!moved) return { started: false, state: t.state, reason: "Another process took this transfer first." };
  await recordEvent(db, t.id, t.state, "paying_out", actor, { attempt: moved.payout_attempts, rail: moved.payout_rail, request_id: moved.payout_request_id });
  const bundle = t.out_bundle_id ? await activeBundle(db, t.out_bundle_id).catch(() => undefined) : undefined;
  return {
    started: true,
    instruction: { transferId: t.id, reference: t.reference, network: t.to_network, number: t.recipient_number, amountKobo: payout, ...(bundle ? { bundle } : {}) },
  };
}

// Value already promised out of one account and not yet posted to it:
// transfers being paid and orders being delivered. Read under the same lock
// as the balance it is subtracted from.
export async function committedAgainst(db: Queryable, account: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `SELECT coalesce((SELECT sum(payout_kobo) FROM transfers WHERE state = 'paying_out' AND payout_funding_account = $1), 0)
          + coalesce((SELECT sum(face_kobo) FROM orders WHERE state = 'delivering' AND delivery_funding_account = $1), 0) AS total`,
    [account],
  );
  return Number(rows[0]!.total);
}

export async function approvePayout(db: Client, actor: string, transferId: number): Promise<Transfer> {
  const moved = await claim(db, transferId, "awaiting_approval", "inbound_confirmed", { approved_by: actor, approved_at: new Date() });
  if (!moved) throw new UserFacingError("not_awaiting_approval", "This transfer is not waiting for approval.");
  await recordEvent(db, transferId, "awaiting_approval", "inbound_confirmed", actor, { approved: true });
  return moved;
}

// The rail says the airtime landed. Books the payout, the fee and the
// network's share. Calling this twice books nothing twice.
export type PaidVia = { account: string; chargedKobo: number; commissionKobo: number };

export async function completePayout(db: Client, actor: string, transferId: number, payoutReference: string, via?: PaidVia): Promise<Transfer | undefined> {
  const moved = await claim(db, transferId, "paying_out", "completed", { payout_reference: payoutReference, paid_out_at: new Date(), payout_last_error: null });
  if (!moved) return undefined;
  const postings = [
    { account: "owed:senders", amountKobo: moved.received_kobo! },
    { account: "revenue:fees", amountKobo: -moved.platform_share_kobo! },
  ];
  if (via) {
    // The provider charged its wallet less than the airtime's face value;
    // the difference is commission they pay us, booked as its own revenue.
    if (via.chargedKobo + via.commissionKobo !== moved.payout_kobo!) {
      throw new Error(`Provider figures do not add up for ${moved.reference}: charged ${via.chargedKobo} plus commission ${via.commissionKobo} is not the payout ${moved.payout_kobo}.`);
    }
    postings.push({ account: via.account, amountKobo: -via.chargedKobo });
    if (via.commissionKobo > 0) postings.push({ account: "revenue:provider_commission", amountKobo: -via.commissionKobo });
    // A sending phone gifts a bundle out of our own data pool, so the lots
    // it came from are spent whether or not a rail reported the send.
    if (via.account.startsWith("datapool:")) await consumeLots(db, moved.to_network, via.chargedKobo);
  } else {
    // From our own SIM: airtime from its pool, a gifted bundle from its data pool.
    postings.push({ account: moved.out_kind === "data" ? `datapool:${moved.to_network}` : `pool:${moved.to_network}`, amountKobo: -moved.payout_kobo! });
    if (moved.out_kind === "data") await consumeLots(db, moved.to_network, moved.payout_kobo!);
  }
  if (moved.network_share_kobo! > 0) postings.push({ account: `owed:${moved.from_network}`, amountKobo: -moved.network_share_kobo! });
  await postJournal(db, {
    idempotencyKey: `transfer:${moved.id}:payout`,
    description: `Paid ${formatNaira(moved.payout_kobo!)} on ${moved.to_network} for ${moved.reference}`,
    reference: moved.reference,
    postings,
  });
  // The agent who brought the sender earns their share of our part of the fee.
  if (moved.agent_id) await bookCommission(db, moved.agent_id, moved.id, moved.reference, moved.platform_share_kobo!);
  await recordEvent(db, moved.id, "paying_out", "completed", actor, { payout_reference: payoutReference });
  return moved;
}

// A failed payout waits one, five, then fifteen minutes before the next
// automatic try; a person can always retry sooner from the transfer page.
export const RETRY_WAIT_MINUTES = [1, 5, 15];

export async function failPayout(db: Client, actor: string, transferId: number, reason: string, options: { retryable?: boolean } = {}): Promise<Transfer | undefined> {
  const current = await getTransfer(db, transferId);
  if (!current) return undefined;
  const wait = RETRY_WAIT_MINUTES[Math.min(current.payout_attempts, RETRY_WAIT_MINUTES.length) - 1] ?? RETRY_WAIT_MINUTES[RETRY_WAIT_MINUTES.length - 1]!;
  const nextAttempt = options.retryable ? new Date(Date.now() + wait * 60_000) : null;
  const moved = await claim(db, transferId, "paying_out", "payout_failed", { payout_last_error: reason, payout_next_attempt_at: nextAttempt });
  if (!moved) return undefined;
  await recordEvent(db, moved.id, "paying_out", "payout_failed", actor, { reason, retry_at: nextAttempt?.toISOString() ?? null });
  return moved;
}

// A person decides to send the airtime back. The rail then sends it on the
// origin network, and completeRefund books it once the rail confirms.
// One refund, one hand. A refund left with no rail belongs to the phones,
// and the command centre shows no form for it; a refund marked manual
// belongs to a person, and the phones leave it alone. Nothing may be in
// both places at once, because both would send real airtime.
export async function startRefund(db: Client, actor: string, transferId: number): Promise<PayoutInstruction & { byHand: boolean }> {
  const { rows } = await db.query<Transfer>("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [transferId]);
  const t = rows[0];
  if (!t) throw new UserFacingError("no_such_transfer", "There is no transfer with that id.");
  // With automatic payouts off, no phone will ever pick this up, so it is a
  // person's from the start.
  const automatic = await getSettingValue(db, "payout.automatic");
  const moved = await claim(db, t.id, ["payout_failed", "held", "awaiting_approval"], "refunding", automatic ? {} : { refund_rail: "manual" });
  if (!moved) throw new UserFacingError("cannot_refund", `A transfer that is ${t.state.replaceAll("_", " ")} cannot be refunded.`);
  await recordEvent(db, t.id, t.state, "refunding", actor);
  return { transferId: t.id, reference: t.reference, network: t.from_network, number: t.sender_number, amountKobo: t.received_kobo!, byHand: !automatic };
}

// A person taking a refund off the phones. Only possible while no phone has
// been given it, so the two can never both be sending.
export async function refundByHand(db: Client, actor: string, transferId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE transfers SET refund_rail = 'manual' WHERE id = $1 AND state = 'refunding' AND refund_request_id IS NULL AND coalesce(refund_rail, '') <> 'manual'",
    [transferId],
  );
  if (rowCount) await recordEvent(db, transferId, "refunding", "refunding", actor, { refund: "taken over by hand" });
  return (rowCount ?? 0) > 0;
}

export async function completeRefund(db: Client, actor: string, transferId: number, refundReference: string, options: { byHand?: boolean } = {}): Promise<Transfer | undefined> {
  // A person may only record a refund that is theirs to send. While a phone
  // holds it, recording it by hand would mean the sender is paid twice.
  if (options.byHand) {
    const { rows } = await db.query<{ refund_rail: string | null }>("SELECT refund_rail FROM transfers WHERE id = $1", [transferId]);
    if (rows[0]?.refund_rail !== "manual") {
      throw new UserFacingError("refund_not_yours", "This refund is with a sending phone. Take it over first if you want to send it by hand.");
    }
  }
  const moved = await claim(db, transferId, "refunding", "refunded", { refunded_at: new Date(), payout_reference: refundReference });
  if (!moved) return undefined;
  await postJournal(db, {
    idempotencyKey: `transfer:${moved.id}:refund`,
    description: `Refunded ${formatNaira(moved.received_kobo!)} on ${moved.from_network} for ${moved.reference}`,
    reference: moved.reference,
    postings: [
      { account: "owed:senders", amountKobo: moved.received_kobo! },
      { account: inboundAccount(moved), amountKobo: -moved.received_kobo! },
    ],
  });
  if (moved.in_kind === "data") await consumeLots(db, moved.from_network, moved.received_kobo!);
  await recordEvent(db, moved.id, "refunding", "refunded", actor, { refund_reference: refundReference });
  return moved;
}

// A person has fixed what held the transfer (topped up the pool, raised a
// ceiling) and sends it back to the payout queue.
export async function releaseHold(db: Client, actor: string, transferId: number): Promise<Transfer> {
  const { rows } = await db.query<Transfer>("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [transferId]);
  const t = rows[0];
  if (!t || t.state !== "held") throw new UserFacingError("not_held", "This transfer is not on hold.");
  if (t.payout_kobo === null) {
    throw new UserFacingError(
      "held_amount_outside_limits",
      `This transfer is held because the amount received is outside the limits (${t.hold_reason?.replaceAll("_", " ")}). It can only be refunded.`,
    );
  }
  const moved = await claim(db, t.id, "held", "inbound_confirmed", { hold_reason: null });
  await recordEvent(db, t.id, "held", "inbound_confirmed", actor, { released_from: t.hold_reason });
  return moved!;
}

// Quotes nobody paid for. Run on a timer. An expired quote can still be
// matched during the grace period, which is why expiry is a state and not a
// deletion.
export async function expireQuotes(db: Queryable, actor = "system"): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "UPDATE transfers SET state = 'expired' WHERE state = 'awaiting_inbound' AND expires_at < now() RETURNING id",
  );
  for (const r of rows) await recordEvent(db, r.id, "awaiting_inbound", "expired", actor);
  return rows.length;
}

// A person matches airtime that arrived without a quote, or from a different
// number than the sender gave, to the transfer it was meant for. Network and
// receiving number must agree; the sender number is the person's judgement
// and is recorded as such.
export async function attachNotification(db: Client, actor: string, notificationId: number, transferId: number): Promise<Transfer> {
  const n = (await db.query<{ id: number; network_code: string; receiving_number: string; sender_number: string; amount_kobo: number; matched_transfer_id: number | null; data_mb: number | null }>(
    "SELECT id, network_code, receiving_number, sender_number, amount_kobo, matched_transfer_id, data_mb FROM inbound_notifications WHERE id = $1 FOR UPDATE",
    [notificationId],
  )).rows[0];
  if (!n) throw new UserFacingError("no_such_notification", "There is no notification with that id.");
  if (n.matched_transfer_id !== null) throw new UserFacingError("already_matched", "That notification is already matched to a transfer.");
  const t = (await db.query<Transfer>("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [transferId])).rows[0];
  if (!t) throw new UserFacingError("no_such_transfer", "There is no transfer with that reference.");
  if (t.state !== "awaiting_inbound" && t.state !== "expired") {
    throw new UserFacingError("not_waiting", `Transfer ${t.reference} is ${t.state.replaceAll("_", " ")}, so it is not waiting for airtime.`);
  }
  if (t.from_network !== n.network_code || t.receiving_number !== n.receiving_number) {
    throw new UserFacingError("wrong_route", `That airtime arrived on ${n.network_code} number ${n.receiving_number}, but ${t.reference} expects ${t.from_network} number ${t.receiving_number}.`);
  }
  if ((t.in_kind === "data") !== (n.data_mb !== null)) {
    throw new UserFacingError("wrong_kind", t.in_kind === "data" ? `${t.reference} is waiting for gifted data, and that notification is airtime.` : `${t.reference} is waiting for airtime, and that notification is gifted data.`);
  }
  const updated = await bookInbound(db, actor, t, n.amount_kobo, n.id, { matched_by_hand: true, notification_sender: n.sender_number });
  if (!updated) throw new UserFacingError("not_waiting", `Transfer ${t.reference} was taken by another process first.`);
  return updated;
}
