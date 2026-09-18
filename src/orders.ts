import { randomInt } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "./db.ts";
import { agentPrice, chargeWallet } from "./agents.ts";
import { activeBundle, type Bundle } from "./bundles.ts";
import { consumeLots } from "./datalots.ts";
import { UserFacingError } from "./errors.ts";
import { balance, lockAccount, postJournal } from "./ledger.ts";
import { applyBasisPoints, assertKobo, formatNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import { getSettingValues, NETWORK_CODES, type NetworkCode } from "./settings.ts";
import { RETRY_WAIT_MINUTES, type PaidVia } from "./transfers.ts";

export type OrderState = "awaiting_payment" | "expired" | "cancelled" | "paid" | "delivering" | "delivered" | "delivery_failed" | "held" | "refunded";

export type Order = {
  id: number;
  reference: string;
  state: OrderState;
  network_code: NetworkCode;
  recipient_number: string;
  buyer_email: string | null;
  face_kobo: number;
  discount_kobo: number;
  price_kobo: number;
  payment_method: string | null;
  payment_reference: string | null;
  paid_kobo: number | null;
  payment_fee_kobo: number | null;
  paid_at: Date | null;
  delivery_rail: string | null;
  delivery_request_id: string | null;
  delivery_reference: string | null;
  delivery_attempts: number;
  delivery_next_attempt_at: Date | null;
  delivery_last_error: string | null;
  delivered_at: Date | null;
  refunded_kobo: number | null;
  refund_reference: string | null;
  refunded_at: Date | null;
  hold_reason: string | null;
  created_at: Date;
  expires_at: Date;
  bundle_id: number | null;
  agent_id: number | null;
};

type Client = pg.PoolClient;

const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newOrderReference(): string {
  let s = "RT-";
  for (let i = 0; i < 8; i++) s += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return s;
}

async function recordEvent(db: Queryable, orderId: number, from: OrderState | null, to: OrderState, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("INSERT INTO order_events (order_id, from_state, to_state, actor, detail) VALUES ($1, $2, $3, $4, $5::jsonb)", [orderId, from, to, actor, JSON.stringify(detail)]);
}

export async function getOrder(db: Queryable, id: number): Promise<Order | undefined> {
  return (await db.query<Order>("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
}

export async function getOrderByReference(db: Queryable, reference: string): Promise<Order | undefined> {
  return (await db.query<Order>("SELECT * FROM orders WHERE reference = $1", [reference.trim().toUpperCase()])).rows[0];
}

async function claim(db: Queryable, id: number, from: OrderState | OrderState[], to: OrderState, extra: Record<string, unknown> = {}): Promise<Order | undefined> {
  const fromStates = Array.isArray(from) ? from : [from];
  const sets = ["state = $2"];
  const params: unknown[] = [id, to, fromStates];
  for (const [col, val] of Object.entries(extra)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  return (await db.query<Order>(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1 AND state = ANY($3::text[]) RETURNING *`, params)).rows[0];
}

export type Quote = { faceKobo: number; discountKobo: number; priceKobo: number };

export function priceFor(faceKobo: number, discountBasisPoints: number): Quote {
  const discountKobo = applyBasisPoints(faceKobo, discountBasisPoints);
  return { faceKobo, discountKobo, priceKobo: faceKobo - discountKobo };
}

// A buyer asks for airtime on a network. The price is the face value less
// any discount set for that network to drain its pool.
export type OrderInput = {
  network: string;
  recipientNumber: string;
  faceKobo?: number | undefined;
  bundleId?: number | undefined;
  email?: string | undefined;
  // The agent who brought the buyer, or who is buying from their wallet.
  agentId?: number | undefined;
  fromWallet?: boolean | undefined;
};

export async function createOrder(db: Client, actor: string, input: OrderInput): Promise<Order> {
  const network = input.network.toUpperCase();
  if (!(NETWORK_CODES as readonly string[]).includes(network)) throw new UserFacingError("unknown_network", "Choose the network of the number you are buying for.");
  const recipient = normaliseNigerianNumber(input.recipientNumber);
  if (!recipient) throw new UserFacingError("bad_recipient_number", "The number should be a Nigerian mobile number like 08021234567.");
  const bundle: Bundle | undefined = input.bundleId ? await activeBundle(db, input.bundleId, network) : undefined;
  const face = bundle ? bundle.price_kobo : assertKobo(input.faceKobo ?? 0);
  const [enabled, min, max, discounts, windowMinutes] = await getSettingValues(db, ["retail.enabled", "retail.min_kobo", "retail.max_kobo", "retail.discount_basis_points", "retail.order_window_minutes"] as const);
  if (!enabled) throw new UserFacingError("retail_off", "Buying airtime is not open right now. Try again later.");
  if (!bundle && face < min) throw new UserFacingError("below_minimum", `The smallest purchase is ${formatNaira(min)}.`);
  if (face > max) throw new UserFacingError("above_maximum", `The largest purchase is ${formatNaira(max)}.`);
  if (face % 100 !== 0 && !bundle) throw new UserFacingError("whole_naira", "Buy a whole number of naira, like 500.");
  // A bundle is sold at its catalogue price; the discount is for airtime.
  // An agent buying from their wallet gets the agent's discount instead.
  const q = input.fromWallet && input.agentId
    ? { faceKobo: face, ...(await agentPrice(db, face)) }
    : bundle ? { faceKobo: face, discountKobo: 0, priceKobo: face } : priceFor(face, discounts[network as NetworkCode]);
  const email = input.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserFacingError("bad_email", "That does not look like an email address. Leave it empty if you prefer.");
  const { rows } = await db.query<Order>(
    `INSERT INTO orders (reference, state, network_code, recipient_number, buyer_email, face_kobo, discount_kobo, price_kobo, expires_at, bundle_id, agent_id)
     VALUES ($1, 'awaiting_payment', $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8), $9, $10) RETURNING *`,
    [newOrderReference(), network, recipient, email, q.faceKobo, q.discountKobo, q.priceKobo, windowMinutes, bundle?.id ?? null, input.agentId ?? null],
  );
  let order = rows[0]!;
  await recordEvent(db, order.id, null, "awaiting_payment", actor, { face_kobo: face, price_kobo: q.priceKobo, agent_id: input.agentId ?? null });
  if (input.fromWallet && input.agentId) {
    // Paid at once from the wallet; delivery follows like any paid order.
    await chargeWallet(db, input.agentId, q.priceKobo, order.reference);
    order = (await claim(db, order.id, "awaiting_payment", "paid", { payment_method: "wallet", payment_reference: `wallet:${input.agentId}`, paid_kobo: q.priceKobo, payment_fee_kobo: 0, paid_at: new Date() }))!;
    await recordEvent(db, order.id, "awaiting_payment", "paid", actor, { method: "wallet", paid_kobo: q.priceKobo });
  }
  return order;
}

export type PaymentIn = { method: "bank_transfer" | "paystack"; reference: string; paidKobo: number; feeKobo: number; cashAccount: string };

// Money has arrived. Claims the order once and books the cash, whichever
// way and however many times we are told about the same payment.
export async function recordPayment(db: Client, actor: string, orderId: number, p: PaymentIn): Promise<{ order: Order; outcome: "paid" | "held" | "already" }> {
  const current = (await db.query<Order>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
  if (!current) throw new UserFacingError("no_such_order", "There is no order with that reference.");
  if (current.state !== "awaiting_payment" && current.state !== "expired") return { order: current, outcome: "already" };
  assertKobo(p.paidKobo);
  const short = p.paidKobo < current.price_kobo;
  const next: OrderState = short ? "held" : "paid";
  const moved = (await claim(db, current.id, ["awaiting_payment", "expired"], next, {
    payment_method: p.method,
    payment_reference: p.reference,
    paid_kobo: p.paidKobo,
    payment_fee_kobo: p.feeKobo,
    paid_at: new Date(),
    hold_reason: short ? "underpaid" : null,
  }))!;
  const postings = [
    { account: p.cashAccount, amountKobo: p.paidKobo - p.feeKobo },
    { account: "owed:buyers", amountKobo: -p.paidKobo },
  ];
  if (p.feeKobo > 0) postings.push({ account: "expense:payment_fees", amountKobo: p.feeKobo });
  await postJournal(db, { idempotencyKey: `order:${moved.id}:payment`, description: `Payment of ${formatNaira(p.paidKobo)} for ${moved.reference} by ${p.method}`, reference: moved.reference, postings });
  await recordEvent(db, moved.id, current.state, next, actor, { method: p.method, reference: p.reference, paid_kobo: p.paidKobo, fee_kobo: p.feeKobo, ...(short ? { hold_reason: "underpaid" } : {}) });
  return { order: moved, outcome: short ? "held" : "paid" };
}

export type DeliveryOptions = { fundingAccount?: string; rail?: string; requestId?: string };
export type DeliveryStart = { started: true; network: NetworkCode; number: string; amountKobo: number; bundle?: Bundle | undefined } | { started: false; state: OrderState; reason: string };

export async function startDelivery(db: Client, actor: string, orderId: number, options: DeliveryOptions = {}): Promise<DeliveryStart> {
  const o = (await db.query<Order>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
  if (!o) throw new UserFacingError("no_such_order", "There is no order with that id.");
  if (o.state !== "paid" && o.state !== "delivery_failed") return { started: false, state: o.state, reason: `Order is ${o.state.replaceAll("_", " ")}, not waiting for delivery.` };
  const funding = options.fundingAccount ?? (o.bundle_id ? `datapool:${o.network_code}` : `pool:${o.network_code}`);
  await lockAccount(db, funding);
  const available = await balance(db, funding);
  if (available < o.face_kobo) {
    const moved = await claim(db, o.id, o.state, "held", { hold_reason: "pool_too_low" });
    if (moved) await recordEvent(db, o.id, o.state, "held", actor, { hold_reason: "pool_too_low", account: funding, available_kobo: available });
    return { started: false, state: "held", reason: `${funding.startsWith("wallet:") ? "The provider wallet" : `The ${o.network_code} pool`} holds ${formatNaira(available)} and this order needs ${formatNaira(o.face_kobo)}. Top it up under Pools, then release the order.` };
  }
  const moved = await claim(db, o.id, o.state, "delivering", { delivery_attempts: o.delivery_attempts + 1, delivery_rail: options.rail ?? "manual", delivery_request_id: options.requestId ?? null, delivery_next_attempt_at: null });
  if (!moved) return { started: false, state: o.state, reason: "Another process took this order first." };
  await recordEvent(db, o.id, o.state, "delivering", actor, { attempt: moved.delivery_attempts, rail: moved.delivery_rail, request_id: moved.delivery_request_id });
  const bundle = o.bundle_id ? await activeBundle(db, o.bundle_id).catch(() => undefined) : undefined;
  return { started: true, network: o.network_code, number: o.recipient_number, amountKobo: o.face_kobo, bundle };
}

// The airtime landed. Books the sale: the buyer's money against the pool
// or the provider wallet, with the discount and any commission as their
// own lines.
export async function completeDelivery(db: Client, actor: string, orderId: number, reference: string, via?: PaidVia): Promise<Order | undefined> {
  const moved = await claim(db, orderId, "delivering", "delivered", { delivery_reference: reference, delivered_at: new Date(), delivery_last_error: null });
  if (!moved) return undefined;
  const postings = [{ account: "owed:buyers", amountKobo: moved.price_kobo }];
  if (moved.discount_kobo > 0) postings.push({ account: "expense:retail_discounts", amountKobo: moved.discount_kobo });
  if (via) {
    if (via.chargedKobo + via.commissionKobo !== moved.face_kobo) throw new Error(`Provider figures do not add up for ${moved.reference}: charged ${via.chargedKobo} plus commission ${via.commissionKobo} is not the face value ${moved.face_kobo}.`);
    postings.push({ account: via.account, amountKobo: -via.chargedKobo });
    if (via.commissionKobo > 0) postings.push({ account: "revenue:provider_commission", amountKobo: -via.commissionKobo });
  } else {
    postings.push({ account: moved.bundle_id ? `datapool:${moved.network_code}` : `pool:${moved.network_code}`, amountKobo: -moved.face_kobo });
    if (moved.bundle_id) await consumeLots(db, moved.network_code, moved.face_kobo);
  }
  await postJournal(db, { idempotencyKey: `order:${moved.id}:delivery`, description: `Delivered ${formatNaira(moved.face_kobo)} on ${moved.network_code} for ${moved.reference}`, reference: moved.reference, postings });
  await recordEvent(db, moved.id, "delivering", "delivered", actor, { reference });
  return moved;
}

export async function failDelivery(db: Client, actor: string, orderId: number, reason: string, options: { retryable?: boolean } = {}): Promise<Order | undefined> {
  const current = await getOrder(db, orderId);
  if (!current) return undefined;
  const wait = RETRY_WAIT_MINUTES[Math.min(current.delivery_attempts, RETRY_WAIT_MINUTES.length) - 1] ?? RETRY_WAIT_MINUTES[RETRY_WAIT_MINUTES.length - 1]!;
  const nextAttempt = options.retryable ? new Date(Date.now() + wait * 60_000) : null;
  const moved = await claim(db, orderId, "delivering", "delivery_failed", { delivery_last_error: reason, delivery_next_attempt_at: nextAttempt });
  if (!moved) return undefined;
  await recordEvent(db, moved.id, "delivering", "delivery_failed", actor, { reason, retry_at: nextAttempt?.toISOString() ?? null });
  return moved;
}

export async function releaseOrderHold(db: Client, actor: string, orderId: number): Promise<Order> {
  const o = (await db.query<Order>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
  if (!o || o.state !== "held") throw new UserFacingError("not_held", "This order is not on hold.");
  if (o.hold_reason === "underpaid") throw new UserFacingError("underpaid", `This order was underpaid (${formatNaira(o.paid_kobo!)} of ${formatNaira(o.price_kobo)}). It can only be refunded.`);
  const moved = (await claim(db, o.id, "held", "paid", { hold_reason: null }))!;
  await recordEvent(db, o.id, "held", "paid", actor, { released_from: o.hold_reason });
  return moved;
}

// A person sends the buyer's money back by bank transfer and records it.
export async function refundOrder(db: Client, actor: string, orderId: number, reference: string, cashAccount = "cash:bank"): Promise<Order> {
  const o = (await db.query<Order>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
  if (!o) throw new UserFacingError("no_such_order", "There is no order with that id.");
  if (o.paid_kobo === null) throw new UserFacingError("not_paid", "Nothing was paid on this order, so there is nothing to refund.");
  // Money that came from an agent's wallet goes back to that wallet.
  if (o.payment_method === "wallet" && o.agent_id) cashAccount = `agent:${o.agent_id}`;
  const moved = await claim(db, o.id, ["paid", "delivery_failed", "held"], "refunded", { refunded_kobo: o.paid_kobo, refund_reference: reference, refunded_at: new Date() });
  if (!moved) throw new UserFacingError("cannot_refund", `An order that is ${o.state.replaceAll("_", " ")} cannot be refunded.`);
  await postJournal(db, {
    idempotencyKey: `order:${moved.id}:refund`,
    description: `Refunded ${formatNaira(o.paid_kobo)} for ${moved.reference}`,
    reference: moved.reference,
    postings: [
      { account: "owed:buyers", amountKobo: o.paid_kobo },
      { account: cashAccount, amountKobo: -o.paid_kobo },
    ],
  });
  await recordEvent(db, moved.id, o.state, "refunded", actor, { refund_reference: reference, refunded_kobo: o.paid_kobo });
  return moved;
}

export async function cancelOrder(db: Client, actor: string, orderId: number): Promise<Order> {
  const moved = await claim(db, orderId, ["awaiting_payment", "expired"], "cancelled");
  if (!moved) throw new UserFacingError("cannot_cancel", "Only an unpaid order can be cancelled.");
  await recordEvent(db, orderId, "awaiting_payment", "cancelled", actor);
  return moved;
}

export async function expireOrders(db: Queryable, actor = "system"): Promise<number> {
  const { rows } = await db.query<{ id: number }>("UPDATE orders SET state = 'expired' WHERE state = 'awaiting_payment' AND expires_at < now() RETURNING id");
  for (const r of rows) await recordEvent(db, r.id, "awaiting_payment", "expired", actor);
  return rows.length;
}
