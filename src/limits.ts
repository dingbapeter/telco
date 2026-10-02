import type { Queryable } from "./db.ts";
import { formatNaira } from "./money.ts";
import { START_OF_TODAY } from "./receiving.ts";
import { getSettingValues } from "./settings.ts";

// The caps that exist to stop the service being used to wash money, in one
// place because both sides of the business need the same ones and because a
// cap nobody can find is a cap nobody can check.
//
// Every cap is counted on a phone number, which is all we have: nothing here
// knows about people. Two things follow. A cap must be checked again when
// value actually arrives, not only when a quote is asked for, because
// anybody can send airtime to one of our SIMs without asking us anything
// first. And a sender must never be told how much somebody else's number
// has already taken today, so the messages about a receiving number say
// that the cap is reached and nothing more.

// Monday in Lagos. Postgres weeks start on Monday, which is also how a week
// is counted in Nigeria, so the two agree without any arithmetic here.
export const START_OF_WEEK = "(date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

// A cap that has been reached: the short name recorded in the books and the
// events, and the words the person who hit it reads.
export type Cap = { reason: string; message: string };

type Tally = { dayValue: number; dayCount: number; weekValue: number; weekCount: number };

// One row of arithmetic for both windows. The day always falls inside the
// week, so a single scan from Monday answers both and the day's figures are
// a filter over the same rows.
async function tally(db: Queryable, table: "transfers" | "sellbacks", column: string, number: string, excludeId: number): Promise<Tally> {
  const value = table === "transfers" ? "coalesce(received_kobo, requested_kobo)" : "coalesce(received_kobo, face_kobo)";
  // An expired quote moved nothing, and value we sent back we never had, so
  // neither counts against the number that asked for it.
  const dead = table === "transfers" ? "('expired', 'refunding', 'refunded')" : "('expired', 'cancelled', 'returning', 'returned')";
  const { rows } = await db.query<{ day_value: number; day_count: number; week_value: number; week_count: number }>(
    `SELECT coalesce(sum(${value}) FILTER (WHERE created_at >= ${START_OF_TODAY}), 0)::bigint AS day_value,
            count(*) FILTER (WHERE created_at >= ${START_OF_TODAY})::int AS day_count,
            coalesce(sum(${value}), 0)::bigint AS week_value,
            count(*)::int AS week_count
     FROM ${table}
     WHERE ${column} = $1 AND created_at >= ${START_OF_WEEK} AND state NOT IN ${dead} AND id <> $2`,
    [number, excludeId],
  );
  const r = rows[0]!;
  return { dayValue: r.day_value, dayCount: r.day_count, weekValue: r.week_value, weekCount: r.week_count };
}

// A zero means the cap is off, which is said in every one of their
// descriptions in the command centre.
function overValue(cap: number, already: number, adding: number): boolean {
  return cap > 0 && already + adding > cap;
}
function overCount(cap: number, already: number): boolean {
  return cap > 0 && already + 1 > cap;
}

export type TransferCapInput = {
  senderNumber: string;
  recipientNumber: string;
  amountKobo: number;
  // The transfer being checked, when it is already in the table: its own row
  // must not be counted against itself.
  excludeTransferId?: number | undefined;
};

// Takes the locks the cap arithmetic needs, in one fixed order so that two
// quotes asked for at the same moment can never wait on each other. Held to
// the end of the caller's transaction and taken on the numbers themselves,
// so nobody else is ever delayed by them.
export async function lockForCaps(db: Queryable, senderNumber: string, recipientNumber: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cap:recipient:${recipientNumber}`]);
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cap:sender:${senderNumber}`]);
}

// The first cap this transfer would break, or nothing if it breaks none.
// The order is deliberate: the sender's own limits first, because they are
// the ones the sender can do something about.
export async function transferCapBreach(db: Queryable, input: TransferCapInput): Promise<Cap | undefined> {
  const [dayMax, weekMax, dayCount, weekCount, toDayMax, toDayCount] = await getSettingValues(db, [
    "transfer.sender_daily_max_kobo",
    "transfer.sender_weekly_max_kobo",
    "transfer.sender_daily_max_count",
    "transfer.sender_weekly_max_count",
    "transfer.recipient_daily_max_kobo",
    "transfer.recipient_daily_max_count",
  ] as const);
  const exclude = input.excludeTransferId ?? 0;
  const from = await tally(db, "transfers", "sender_number", input.senderNumber, exclude);
  if (overValue(dayMax, from.dayValue, input.amountKobo)) {
    return { reason: "over_daily_limit", message: `This number can move ${formatNaira(dayMax)} a day and has ${formatNaira(Math.max(0, dayMax - from.dayValue))} left today.` };
  }
  if (overValue(weekMax, from.weekValue, input.amountKobo)) {
    return { reason: "over_weekly_limit", message: `This number can move ${formatNaira(weekMax)} a week and has ${formatNaira(Math.max(0, weekMax - from.weekValue))} left until Monday.` };
  }
  if (overCount(dayCount, from.dayCount)) {
    return { reason: "over_daily_count", message: `This number can make ${dayCount} transfer${dayCount === 1 ? "" : "s"} a day and has made ${from.dayCount} today. The next one can go tomorrow.` };
  }
  if (overCount(weekCount, from.weekCount)) {
    return { reason: "over_weekly_count", message: `This number can make ${weekCount} transfers a week and has made ${from.weekCount} since Monday. The next one can go on Monday.` };
  }
  const to = await tally(db, "transfers", "recipient_number", input.recipientNumber, exclude);
  // Said without any figures for the receiving number. Anybody can type any
  // number in here, and what another line has been sent today is not theirs
  // to learn.
  if (overValue(toDayMax, to.dayValue, input.amountKobo)) {
    return { reason: "recipient_over_daily_limit", message: `One number can only be sent ${formatNaira(toDayMax)} a day, and this one has reached it. Send to another number, or try tomorrow.` };
  }
  if (overCount(toDayCount, to.dayCount)) {
    return { reason: "recipient_over_daily_count", message: `One number can only be sent ${toDayCount} transfer${toDayCount === 1 ? "" : "s"} a day, and this one has reached that. Send to another number, or try tomorrow.` };
  }
  return undefined;
}

export type SellerCapInput = {
  sellerNumber: string;
  faceKobo: number;
  excludeSellbackId?: number | undefined;
};

// The same arithmetic for somebody selling value to us. The money cap for
// one day was the first one built, so its words are the ones sellers have
// already been reading and they are kept.
export async function sellerCapBreach(db: Queryable, input: SellerCapInput): Promise<Cap | undefined> {
  const [dayMax, weekMax, dayCount, weekCount] = await getSettingValues(db, [
    "sellback.seller_daily_max_kobo",
    "sellback.seller_weekly_max_kobo",
    "sellback.seller_daily_max_count",
    "sellback.seller_weekly_max_count",
  ] as const);
  const t = await tally(db, "sellbacks", "seller_number", input.sellerNumber, input.excludeSellbackId ?? 0);
  if (overValue(dayMax, t.dayValue, input.faceKobo)) {
    return { reason: "over_daily_limit", message: `This number can sell ${formatNaira(dayMax)} a day and has ${formatNaira(Math.max(0, dayMax - t.dayValue))} left today.` };
  }
  if (overValue(weekMax, t.weekValue, input.faceKobo)) {
    return { reason: "over_weekly_limit", message: `This number can sell ${formatNaira(weekMax)} a week and has ${formatNaira(Math.max(0, weekMax - t.weekValue))} left until Monday.` };
  }
  if (overCount(dayCount, t.dayCount)) {
    return { reason: "over_daily_count", message: `This number can make ${dayCount} sale${dayCount === 1 ? "" : "s"} a day and has made ${t.dayCount} today. The next one can go tomorrow.` };
  }
  if (overCount(weekCount, t.weekCount)) {
    return { reason: "over_weekly_count", message: `This number can make ${weekCount} sales a week and has made ${t.weekCount} since Monday. The next one can go on Monday.` };
  }
  return undefined;
}

// The hold reasons that mean a cap was broken. Value held for one of these
// is value we have decided not to take, so it goes back to the line it came
// from rather than waiting for somebody to decide again.
export const CAP_REASONS: readonly string[] = [
  "over_daily_limit",
  "over_weekly_limit",
  "over_daily_count",
  "over_weekly_count",
  "recipient_over_daily_limit",
  "recipient_over_daily_count",
];

export function isCapReason(reason: string | null): boolean {
  return reason !== null && CAP_REASONS.includes(reason);
}

// What the person waiting on the page is told, for each cap. Kept beside the
// caps themselves so a new cap cannot be added without words for it.
export function explainCap(reason: string | null): string | undefined {
  switch (reason) {
    case "over_daily_limit":
      return "This is more than your number may move in a day";
    case "over_weekly_limit":
      return "This is more than your number may move in a week";
    case "over_daily_count":
      return "Your number has made as many transfers as it may make today";
    case "over_weekly_count":
      return "Your number has made as many transfers as it may make this week";
    case "recipient_over_daily_limit":
      return "The number you sent to has taken as much as one number may take in a day";
    case "recipient_over_daily_count":
      return "The number you sent to has had as many transfers as one number may have in a day";
    default:
      return undefined;
  }
}
