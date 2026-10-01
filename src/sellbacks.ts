import { randomInt } from "node:crypto";
import type pg from "pg";
import { activeBundle, describeBundle, getBundle, type Bundle } from "./bundles.ts";
import { openLot } from "./datalots.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { postJournal } from "./ledger.ts";
import { applyBasisPoints, assertKobo, formatNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "./settings.ts";
import { chooseReceivingNumber, START_OF_TODAY } from "./receiving.ts";

// Buying airtime and data back from the people holding it.
//
// Somebody with airtime or a bundle they cannot use sends it to one of our
// SIMs with the network's own code, and we pay for it: credit to spend with
// us, or cash by bank transfer where the founder has turned that on. The
// value is only ever believed from the network's own message, which is the
// same rule the transfer side follows and the only proof the value really
// landed.

export type SellbackState = "awaiting_inbound" | "expired" | "held" | "received" | "settled" | "paid" | "returned" | "cancelled";

export type Sellback = {
  id: number;
  reference: string;
  state: SellbackState;
  network_code: NetworkCode;
  seller_number: string;
  receiving_number: string;
  kind: "airtime" | "data";
  bundle_id: number | null;
  face_kobo: number;
  rate_basis_points: number;
  quoted_pay_kobo: number;
  received_kobo: number | null;
  pay_kobo: number | null;
  outcome: "credit" | "cash";
  bank_details: string | null;
  credit_code: string | null;
  hold_reason: string | null;
  notification_id: number | null;
  created_at: Date;
  expires_at: Date;
  received_at: Date | null;
  settled_at: Date | null;
  settled_by: string | null;
  payout_reference: string | null;
};

export type CreditNote = {
  code: string;
  sellback_id: number;
  amount_kobo: number;
  remaining_kobo: number;
  state: "open" | "used" | "voided";
  created_at: Date;
  last_used_at: Date | null;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
};

type Client = pg.PoolClient;

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function code(prefix: string, length: number): string {
  let s = prefix;
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
export const newSellbackReference = (): string => code("SB-", 8);
export const newCreditCode = (): string => code("CR-", 10);

function isNetwork(value: string): value is NetworkCode {
  return (NETWORK_CODES as readonly string[]).includes(value);
}

// Where bought value lands: airtime in the network's pool, data in its data
// pool, both at the price we expect to sell it for.
function poolFor(s: Pick<Sellback, "kind" | "network_code">): string {
  return s.kind === "data" ? `datapool:${s.network_code}` : `pool:${s.network_code}`;
}

async function recordEvent(db: Queryable, id: number, from: SellbackState | null, to: SellbackState, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("INSERT INTO sellback_events (sellback_id, from_state, to_state, actor, detail) VALUES ($1, $2, $3, $4, $5::jsonb)", [id, from, to, actor, JSON.stringify(detail)]);
}

async function claim(db: Queryable, id: number, from: SellbackState | SellbackState[], to: SellbackState, extra: Record<string, unknown> = {}): Promise<Sellback | undefined> {
  const states = Array.isArray(from) ? from : [from];
  const sets = ["state = $2"];
  const params: unknown[] = [id, to, states];
  for (const [column, value] of Object.entries(extra)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  return (await db.query<Sellback>(`UPDATE sellbacks SET ${sets.join(", ")} WHERE id = $1 AND state = ANY($3::text[]) RETURNING *`, params)).rows[0];
}

export async function getSellback(db: Queryable, id: number): Promise<Sellback | undefined> {
  return (await db.query<Sellback>("SELECT * FROM sellbacks WHERE id = $1", [id])).rows[0];
}

export async function getSellbackByReference(db: Queryable, reference: string): Promise<Sellback | undefined> {
  return (await db.query<Sellback>("SELECT * FROM sellbacks WHERE reference = $1", [reference.trim().toUpperCase()])).rows[0];
}

export async function isBlocked(db: Queryable, number: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM sellback_blocks WHERE number = $1", [number])).rowCount === 1;
}

export async function blockSeller(db: Queryable, actor: string, numberText: string, reason: string): Promise<string> {
  const number = normaliseNigerianNumber(numberText);
  if (!number) throw new UserFacingError("bad_phone", "That is not a Nigerian mobile number.");
  if (!reason.trim()) throw new UserFacingError("missing_reason", "Say why the number is blocked, so the next person reading this knows.");
  await db.query("INSERT INTO sellback_blocks (number, reason, added_by) VALUES ($1, $2, $3) ON CONFLICT (number) DO UPDATE SET reason = EXCLUDED.reason, added_at = now(), added_by = EXCLUDED.added_by", [number, reason.trim(), actor]);
  return number;
}

export async function unblockSeller(db: Queryable, numberText: string): Promise<void> {
  const number = normaliseNigerianNumber(numberText) ?? numberText.trim();
  await db.query("DELETE FROM sellback_blocks WHERE number = $1", [number]);
}

// The cheapest share of face value anybody can buy airtime from us for,
// counting the retail discount on that network, the agents' standing
// discount and any rate agreed with one agent. Buying back above this would
// let the same naira be bought from us and sold straight back at a profit,
// round and round, at our expense.
export async function cheapestSellingShare(db: Queryable, network: NetworkCode): Promise<{ shareBasisPoints: number; who: string }> {
  const [retail, agents] = await getSettingValues(db, ["retail.discount_basis_points", "agent.discount_basis_points"] as const);
  const { rows } = await db.query<{ most: number | null }>("SELECT max(discount_basis_points) AS most FROM agents WHERE active AND discount_basis_points IS NOT NULL");
  const own = rows[0]?.most ?? 0;
  const candidates: { discount: number; who: string }[] = [
    { discount: retail[network], who: `the ${network} retail discount` },
    { discount: agents, who: "the agents' discount" },
    { discount: own, who: "the rate agreed with one agent" },
  ];
  const biggest = candidates.reduce((a, b) => (b.discount > a.discount ? b : a));
  return { shareBasisPoints: 10_000 - biggest.discount, who: biggest.who };
}

export type RateCheck = { ok: true; rate: number } | { ok: false; reason: string };

// 8000 basis points reads as "80 percent", 7750 as "77.5 percent".
export function percentOf(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")} percent`;
}

// The rate we may buy at on this network, and why not if we may not.
export async function rateFor(db: Queryable, network: NetworkCode, kind: "airtime" | "data"): Promise<RateCheck> {
  const [airtimeRates, dataRates, margin] = await getSettingValues(db, ["sellback.airtime_rate_basis_points", "sellback.data_rate_basis_points", "sellback.min_margin_basis_points"] as const);
  const rate = kind === "data" ? dataRates[network] : airtimeRates[network];
  if (rate <= 0) return { ok: false, reason: `We are not buying ${kind} on ${network} at the moment.` };
  const cheapest = await cheapestSellingShare(db, network);
  const most = cheapest.shareBasisPoints - margin;
  if (rate > most) {
    return {
      ok: false,
      reason:
        `Buying ${kind} on ${network} is paused because the rate is unsafe: we pay ${percentOf(rate)} of face value while ${cheapest.who} lets it be bought from us for ${percentOf(cheapest.shareBasisPoints)}. ` +
        `Under Settings, Buying back, drop the rate below ${percentOf(most)} or lower that discount.`,
    };
  }
  return { ok: true, rate };
}

export type SellbackInput = {
  network: string;
  sellerNumber: string;
  kind: "airtime" | "data";
  bundleId?: number | undefined;
  amountKobo?: number | undefined;
  outcome: "credit" | "cash";
  bankDetails?: string | undefined;
};

export type SellbackQuote = { sellback: Sellback; bundle?: Bundle | undefined; payKobo: number };

// What a seller is promised, and the number to send it to. The rate quoted
// here is the rate honoured when the value lands, even if the setting moves
// in between: a quote is a promise.
export async function quoteSellback(db: Client, actor: string, input: SellbackInput): Promise<SellbackQuote> {
  const network = input.network.toUpperCase();
  if (!isNetwork(network)) throw new UserFacingError("unknown_network", "Choose the network the airtime or data is on.");
  const [airtimeOn, dataOn, cashOn, min, max, sellerDaily, buyCaps, windowMinutes, cashCap] = await getSettingValues(db, [
    "sellback.airtime_enabled",
    "sellback.data_enabled",
    "sellback.cash_enabled",
    "sellback.min_kobo",
    "sellback.max_kobo",
    "sellback.seller_daily_max_kobo",
    "sellback.daily_buy_cap_kobo",
    "sellback.window_minutes",
    "sellback.cash_daily_cap_kobo",
  ] as const);
  if (input.kind === "airtime" && !airtimeOn) throw new UserFacingError("not_buying_airtime", "We are not buying airtime at the moment.");
  if (input.kind === "data" && !dataOn) throw new UserFacingError("not_buying_data", "We are not buying data at the moment.");
  const active = await db.query("SELECT code FROM networks WHERE code = $1 AND active", [network]);
  if (active.rowCount !== 1) throw new UserFacingError("network_paused", `We are not taking anything on ${network} right now. Try again later.`);
  const seller = normaliseNigerianNumber(input.sellerNumber);
  if (!seller) throw new UserFacingError("bad_seller_number", "Your number should be a Nigerian mobile number like 08031234567.");
  // Said plainly, without saying what it is about this number: somebody
  // told they are blocked and why would simply use another line.
  if (await isBlocked(db, seller)) throw new UserFacingError("seller_blocked", "We cannot buy from this number. If you believe that is a mistake, keep your receipt and contact us.");
  if (input.outcome === "cash") {
    if (!cashOn || cashCap === 0) throw new UserFacingError("no_cash", "We are only paying in credit at the moment, which you can spend on airtime or data for any number.");
    if (!input.bankDetails?.trim()) throw new UserFacingError("missing_bank", "Give the bank, account number and account name the money should go to.");
    if (input.bankDetails.trim().length > 200) throw new UserFacingError("long_bank", "Keep the bank details under two hundred characters.");
  }

  const bundle = input.kind === "data" ? await activeBundle(db, input.bundleId ?? 0, network) : undefined;
  if (bundle && !bundle.giftable) throw new UserFacingError("not_giftable", `${describeBundle(bundle)} cannot be gifted to us on ${network}. Choose a bundle marked as giftable.`);
  const face = bundle ? bundle.price_kobo : assertKobo(input.amountKobo ?? 0);
  if (face <= 0) throw new UserFacingError("no_amount", "Enter how much airtime you want to sell.");
  if (face < min) throw new UserFacingError("below_minimum", `The smallest we buy is ${formatNaira(min)}.`);
  if (face > max) throw new UserFacingError("above_maximum", `The most we buy at once is ${formatNaira(max)}. Sell it in more than one go.`);

  const check = await rateFor(db, network, input.kind);
  if (!check.ok) throw new UserFacingError("rate_unsafe", check.reason);
  const payKobo = applyBasisPoints(face, check.rate);
  if (payKobo <= 0) throw new UserFacingError("too_small_to_pay", "That is too small for us to pay anything for.");

  // One seller at a time, or two quotes asked for together would each see
  // the day's total without the other and both pass the limit.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`seller:${seller}`]);
  const sellerToday = (await db.query<{ total: number }>(
    `SELECT coalesce(sum(coalesce(received_kobo, face_kobo)), 0)::bigint AS total FROM sellbacks
     WHERE seller_number = $1 AND created_at >= ${START_OF_TODAY} AND state NOT IN ('expired', 'cancelled', 'returned')`,
    [seller],
  )).rows[0]!.total;
  if (sellerToday + face > sellerDaily) {
    const left = Math.max(0, sellerDaily - sellerToday);
    throw new UserFacingError("seller_daily_limit", `This number can sell ${formatNaira(sellerDaily)} a day and has ${formatNaira(left)} left today.`);
  }

  const cap = buyCaps[network];
  if (cap === 0) throw new UserFacingError("no_buy_cap", `We are not buying on ${network} at the moment.`);
  const boughtToday = (await db.query<{ total: number }>(
    `SELECT coalesce(sum(coalesce(received_kobo, face_kobo)), 0)::bigint AS total FROM sellbacks
     WHERE network_code = $1 AND created_at >= ${START_OF_TODAY} AND state NOT IN ('expired', 'cancelled', 'returned')`,
    [network],
  )).rows[0]!.total;
  if (boughtToday + face > cap) {
    throw new UserFacingError("daily_buy_cap", `We have bought as much ${network} value as we can take today. Try again tomorrow.`);
  }

  const receivingNumber = await chooseReceivingNumber(db, network, face);
  if (!receivingNumber) {
    throw new UserFacingError("no_receiving_number", `No ${network} number of ours can take this right now. Try again later.`);
  }

  const { rows } = await db.query<Sellback>(
    `INSERT INTO sellbacks (reference, network_code, seller_number, receiving_number, kind, bundle_id, face_kobo, rate_basis_points, quoted_pay_kobo, outcome, bank_details, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12)) RETURNING *`,
    [newSellbackReference(), network, seller, receivingNumber, input.kind, bundle?.id ?? null, face, check.rate, payKobo, input.outcome, input.outcome === "cash" ? input.bankDetails!.trim() : null, windowMinutes],
  );
  const sellback = rows[0]!;
  await recordEvent(db, sellback.id, null, "awaiting_inbound", actor, { face_kobo: face, rate_basis_points: check.rate, pay_kobo: payKobo, outcome: input.outcome, bundle: bundle?.code ?? null });
  return { sellback, bundle, payKobo };
}

// A notification the transfer side could not place. Airtime matches a sale
// waiting for airtime, preferring the exact amount; gifted data matches a
// sale waiting for a bundle of that size.
export async function matchSellback(
  db: Client,
  actor: string,
  n: { network: NetworkCode; receivingNumber: string; sellerNumber: string; amountKobo: number; dataMb?: number | undefined; notificationId: number },
): Promise<Sellback | undefined> {
  const grace = await getSettingValue(db, "transfer.inbound_grace_minutes");
  const candidates = n.dataMb
    ? await db.query<Sellback>(
        `SELECT s.* FROM sellbacks s JOIN data_bundles b ON b.id = s.bundle_id
         WHERE s.network_code = $1 AND s.receiving_number = $2 AND s.seller_number = $3 AND s.kind = 'data' AND b.size_mb = $4
           AND s.state IN ('awaiting_inbound', 'expired') AND s.expires_at + make_interval(mins => $5) > now()
         ORDER BY s.created_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT 1`,
        [n.network, n.receivingNumber, n.sellerNumber, n.dataMb, grace],
      )
    : await db.query<Sellback>(
        `SELECT * FROM sellbacks
         WHERE network_code = $1 AND receiving_number = $2 AND seller_number = $3 AND kind = 'airtime'
           AND state IN ('awaiting_inbound', 'expired') AND expires_at + make_interval(mins => $5) > now()
         ORDER BY (face_kobo = $4) DESC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [n.network, n.receivingNumber, n.sellerNumber, n.amountKobo, grace],
      );
  const candidate = candidates.rows[0];
  if (!candidate) return undefined;
  return bookSellback(db, actor, candidate, n.amountKobo, n.notificationId);
}

// The value is on our SIM. It is booked at the price we sell it for, what we
// owe the seller is booked against us, and the difference is our margin on
// the deal. The rate is the one quoted, whatever the setting says now.
async function bookSellback(db: Client, actor: string, candidate: Sellback, amountKobo: number, notificationId: number): Promise<Sellback | undefined> {
  const [min, max] = await getSettingValues(db, ["sellback.min_kobo", "sellback.max_kobo"] as const);
  const pay = applyBasisPoints(amountKobo, candidate.rate_basis_points);
  let holdReason: string | null = null;
  if (candidate.kind === "airtime" && amountKobo < min) holdReason = "amount_below_minimum";
  else if (amountKobo > max) holdReason = "amount_above_maximum";
  else if (pay <= 0) holdReason = "too_small_to_pay";
  else if (await isBlocked(db, candidate.seller_number)) holdReason = "seller_blocked";
  const moved = await claim(db, candidate.id, ["awaiting_inbound", "expired"], holdReason ? "held" : "received", {
    received_kobo: amountKobo,
    pay_kobo: pay,
    received_at: new Date(),
    notification_id: notificationId,
    hold_reason: holdReason,
  });
  if (!moved) return undefined;
  const margin = amountKobo - pay;
  const postings = [
    { account: poolFor(moved), amountKobo },
    { account: "owed:sellers", amountKobo: -pay },
  ];
  if (margin > 0) postings.push({ account: "revenue:sellback_margin", amountKobo: -margin });
  await postJournal(db, {
    idempotencyKey: `sellback:${moved.id}:inbound`,
    description: `${moved.kind === "data" ? "Data" : "Airtime"} worth ${formatNaira(amountKobo)} bought on ${moved.network_code} for ${formatNaira(pay)}, ${moved.reference}`,
    reference: moved.reference,
    postings,
  });
  if (moved.kind === "data" && moved.bundle_id) {
    const bundle = await getBundle(db, moved.bundle_id);
    const assumed = await getSettingValue(db, "sellback.assumed_validity_days");
    // Gifted data keeps the seller's own validity, which the network never
    // tells us, so the lot is recorded on the shorter of what we assume and
    // what the bundle itself carries.
    const validity = Math.min(assumed, bundle?.validity_days ?? assumed);
    if (bundle) await openLot(db, { network: moved.network_code, bundleId: bundle.id, sizeMb: bundle.size_mb, valueKobo: amountKobo, validityDays: validity, source: moved.reference });
  }
  await db.query("UPDATE inbound_notifications SET matched_sellback_id = $1 WHERE id = $2", [moved.id, notificationId]);
  await recordEvent(db, moved.id, candidate.state, moved.state, actor, { received_kobo: amountKobo, pay_kobo: pay, notification_id: notificationId, ...(holdReason ? { hold_reason: holdReason } : {}) });
  // Credit is handed over the moment the value lands. Cash waits for a
  // person, and for the holding time.
  return moved.state === "received" && moved.outcome === "credit" ? settleAsCredit(db, actor, moved) : moved;
}

async function settleAsCredit(db: Client, actor: string, s: Sellback): Promise<Sellback> {
  const note = await issueCredit(db, s);
  const moved = await claim(db, s.id, "received", "settled", { credit_code: note.code, settled_at: new Date(), settled_by: actor });
  if (!moved) return s;
  await recordEvent(db, moved.id, "received", "settled", actor, { credit_code: note.code, amount_kobo: note.amount_kobo });
  return moved;
}

async function issueCredit(db: Queryable, s: Sellback): Promise<CreditNote> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await db.query<CreditNote>(
      "INSERT INTO credit_notes (code, sellback_id, amount_kobo, remaining_kobo) VALUES ($1, $2, $3, $3) ON CONFLICT (code) DO NOTHING RETURNING *",
      [newCreditCode(), s.id, s.pay_kobo!],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error("Could not find a free credit code.");
}

export async function getCreditNote(db: Queryable, codeText: string): Promise<CreditNote | undefined> {
  return (await db.query<CreditNote>("SELECT * FROM credit_notes WHERE code = $1", [codeText.trim().toUpperCase()])).rows[0];
}

// Draws an amount down from a credit note, inside the caller's transaction.
// The row is locked first, so the same code spent twice at the same moment
// cannot pay for two orders out of one balance.
export async function spendCredit(db: Client, codeText: string, amountKobo: number): Promise<CreditNote> {
  const wanted = codeText.trim().toUpperCase();
  const { rows } = await db.query<CreditNote>("SELECT * FROM credit_notes WHERE code = $1 FOR UPDATE", [wanted]);
  const note = rows[0];
  if (!note) throw new UserFacingError("no_such_credit", "That credit code is not one of ours. Check it and try again.");
  if (note.state === "voided") throw new UserFacingError("credit_voided", "That credit code has been stopped. Contact us with your reference.");
  if (note.remaining_kobo <= 0) throw new UserFacingError("credit_spent", "That credit code has nothing left on it.");
  if (note.remaining_kobo < amountKobo) {
    throw new UserFacingError("credit_too_small", `That code holds ${formatNaira(note.remaining_kobo)} and this costs ${formatNaira(amountKobo)}. Buy something of ${formatNaira(note.remaining_kobo)} or less, or pay another way.`);
  }
  const left = note.remaining_kobo - amountKobo;
  const { rows: after } = await db.query<CreditNote>(
    "UPDATE credit_notes SET remaining_kobo = $2, state = CASE WHEN $2::bigint = 0 THEN 'used' ELSE 'open' END, last_used_at = now() WHERE code = $1 RETURNING *",
    [wanted, left],
  );
  return after[0]!;
}

export async function releaseSellback(db: Client, actor: string, id: number): Promise<Sellback> {
  const s = (await db.query<Sellback>("SELECT * FROM sellbacks WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!s) throw new UserFacingError("no_such_sellback", "There is no sale with that id.");
  if (s.state !== "held") throw new UserFacingError("not_held", "This sale is not on hold.");
  const moved = (await claim(db, id, "held", "received", { hold_reason: null }))!;
  await recordEvent(db, id, "held", "received", actor, { released_from: s.hold_reason });
  return moved.outcome === "credit" ? settleAsCredit(db, actor, moved) : moved;
}

// The value goes back to the seller's own line and the deal is undone. A
// person sends it from the SIM and records that here, because sending it
// back is the same network code the seller used, in reverse.
export async function returnSellback(db: Client, actor: string, id: number, note: string): Promise<Sellback> {
  const s = (await db.query<Sellback>("SELECT * FROM sellbacks WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!s) throw new UserFacingError("no_such_sellback", "There is no sale with that id.");
  if (s.state !== "held" && s.state !== "received") throw new UserFacingError("cannot_return", `A sale that is ${s.state} cannot be sent back.`);
  if (s.credit_code) throw new UserFacingError("credit_issued", "Credit was already given for this sale. Void the credit code first.");
  const moved = (await claim(db, id, ["held", "received"], "returned", { settled_at: new Date(), settled_by: actor, payout_reference: note.trim() || null }))!;
  const margin = moved.received_kobo! - moved.pay_kobo!;
  const postings = [
    { account: poolFor(moved), amountKobo: -moved.received_kobo! },
    { account: "owed:sellers", amountKobo: moved.pay_kobo! },
  ];
  if (margin > 0) postings.push({ account: "revenue:sellback_margin", amountKobo: margin });
  await postJournal(db, {
    idempotencyKey: `sellback:${moved.id}:return`,
    description: `${formatNaira(moved.received_kobo!)} sent back to ${moved.seller_number} on ${moved.network_code}, ${moved.reference}`,
    reference: moved.reference,
    postings,
  });
  await recordEvent(db, id, s.state, "returned", actor, { note: note.trim() });
  return moved;
}

export type CashCheck = { ok: true } | { ok: false; reason: string };

// Whether a cash payout may be settled now: the switch, the holding time,
// and the day's cash ceiling across every seller.
export async function cashPayoutCheck(db: Queryable, s: Sellback, now = new Date()): Promise<CashCheck> {
  if (s.outcome !== "cash") return { ok: false, reason: "This seller asked for credit, not cash." };
  if (s.state !== "received") return { ok: false, reason: `This sale is ${s.state}, so there is nothing to pay.` };
  const [cashOn, holdHours, dailyCap] = await getSettingValues(db, ["sellback.cash_enabled", "sellback.cash_hold_hours", "sellback.cash_daily_cap_kobo"] as const);
  if (!cashOn) return { ok: false, reason: "Paying sellers in cash is switched off under Settings, Buying back. The seller can be given credit instead." };
  if (dailyCap === 0) return { ok: false, reason: "The most cash we will pay in a day is set to nothing under Settings, Buying back." };
  const ready = new Date(new Date(s.received_at!).getTime() + holdHours * 3_600_000);
  if (now < ready) {
    const hours = Math.ceil((ready.getTime() - now.getTime()) / 3_600_000);
    return { ok: false, reason: `This one is still in its holding time. It can be paid in about ${hours} hour${hours === 1 ? "" : "s"}, from ${ready.toISOString().slice(0, 16).replace("T", " ")} UTC.` };
  }
  const paidToday = (await db.query<{ total: number }>(
    `SELECT coalesce(sum(pay_kobo), 0)::bigint AS total FROM sellbacks WHERE state = 'paid' AND settled_at >= ${START_OF_TODAY}`,
  )).rows[0]!.total;
  if (paidToday + s.pay_kobo! > dailyCap) {
    return { ok: false, reason: `${formatNaira(paidToday)} of cash has been paid today and the day's ceiling is ${formatNaira(dailyCap)}. This one waits for tomorrow, or raise the ceiling under Settings, Buying back.` };
  }
  return { ok: true };
}

// A person has sent the money by bank transfer and records it, once.
export async function paySellbackCash(db: Client, actor: string, id: number, reference: string, now = new Date()): Promise<Sellback> {
  const s = (await db.query<Sellback>("SELECT * FROM sellbacks WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!s) throw new UserFacingError("no_such_sellback", "There is no sale with that id.");
  if (!reference.trim()) throw new UserFacingError("missing_reference", "Put the bank reference in, so the payment can be found again.");
  const check = await cashPayoutCheck(db, s, now);
  if (!check.ok) throw new UserFacingError("cannot_pay", check.reason);
  const moved = (await claim(db, id, "received", "paid", { settled_at: now, settled_by: actor, payout_reference: reference.trim() }))!;
  await postJournal(db, {
    idempotencyKey: `sellback:${moved.id}:cash`,
    description: `${formatNaira(moved.pay_kobo!)} paid to ${moved.seller_number} for ${moved.reference}, bank reference ${reference.trim()}`,
    reference: moved.reference,
    postings: [
      { account: "owed:sellers", amountKobo: moved.pay_kobo! },
      { account: "cash:bank", amountKobo: -moved.pay_kobo! },
    ],
  });
  await recordEvent(db, id, "received", "paid", actor, { pay_kobo: moved.pay_kobo, reference: reference.trim() });
  return moved;
}

// Stopping a credit code. Only for value we should never have bought, and
// never quietly: the reason is required and the money moves in the books.
export async function voidCredit(db: Client, actor: string, codeText: string, reason: string): Promise<CreditNote> {
  if (!reason.trim()) throw new UserFacingError("missing_reason", "Say why the credit is being stopped.");
  const { rows } = await db.query<CreditNote>("SELECT * FROM credit_notes WHERE code = $1 FOR UPDATE", [codeText.trim().toUpperCase()]);
  const note = rows[0];
  if (!note) throw new UserFacingError("no_such_credit", "There is no credit code like that.");
  if (note.state === "voided") throw new UserFacingError("already_voided", "That code is already stopped.");
  const left = note.remaining_kobo;
  const { rows: after } = await db.query<CreditNote>(
    "UPDATE credit_notes SET state = 'voided', remaining_kobo = 0, voided_at = now(), voided_by = $2, void_reason = $3 WHERE code = $1 RETURNING *",
    [note.code, actor, reason.trim()],
  );
  if (left > 0) {
    await postJournal(db, {
      idempotencyKey: `credit:${note.code}:voided`,
      description: `Credit code ${note.code} stopped with ${formatNaira(left)} unspent: ${reason.trim()}`,
      reference: note.code,
      postings: [
        { account: "owed:sellers", amountKobo: left },
        { account: "revenue:voided_credit", amountKobo: -left },
      ],
    });
  }
  return after[0]!;
}

export async function expireSellbacks(db: Queryable, actor = "system"): Promise<number> {
  const { rows } = await db.query<{ id: number }>("UPDATE sellbacks SET state = 'expired' WHERE state = 'awaiting_inbound' AND expires_at < now() RETURNING id");
  for (const r of rows) await recordEvent(db, r.id, "awaiting_inbound", "expired", actor);
  return rows.length;
}

export type SellerHistory = { sales: number; soldKobo: number; paidKobo: number; firstAt: Date | null; blocked: boolean };

// What the command centre needs to judge a cash payout: how often this
// number has sold to us, and how much it has taken.
export async function sellerHistory(db: Queryable, number: string): Promise<SellerHistory> {
  const { rows } = await db.query<{ sales: number; sold: number; paid: number; first_at: Date | null }>(
    `SELECT count(*)::int AS sales,
            coalesce(sum(coalesce(received_kobo, face_kobo)), 0)::bigint AS sold,
            coalesce(sum(CASE WHEN state IN ('paid', 'settled') THEN pay_kobo ELSE 0 END), 0)::bigint AS paid,
            min(created_at) AS first_at
     FROM sellbacks WHERE seller_number = $1 AND state NOT IN ('expired', 'cancelled')`,
    [number],
  );
  const r = rows[0]!;
  return { sales: r.sales, soldKobo: r.sold, paidKobo: r.paid, firstAt: r.first_at, blocked: await isBlocked(db, number) };
}
