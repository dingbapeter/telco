import type { Queryable } from "./db.ts";
import { postJournal } from "./ledger.ts";
import { formatNaira } from "./money.ts";
import type { NetworkCode } from "./settings.ts";

export type DataLot = {
  id: number;
  network_code: NetworkCode;
  bundle_id: number | null;
  size_mb: number;
  value_kobo: number;
  remaining_value_kobo: number;
  received_at: Date;
  expires_at: Date | null;
  source: string;
  state: "open" | "used" | "expired";
  written_off_at: Date | null;
};

// A bundle has landed on our SIM. It is worth its catalogue value until it
// expires, which is the bundle's validity from today.
export async function openLot(db: Queryable, input: { network: NetworkCode; bundleId: number | null; sizeMb: number; valueKobo: number; validityDays: number | null; source: string }): Promise<DataLot> {
  const { rows } = await db.query<DataLot>(
    `INSERT INTO data_lots (network_code, bundle_id, size_mb, value_kobo, remaining_value_kobo, expires_at, source)
     VALUES ($1, $2, $3, $4, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5) END, $6) RETURNING *`,
    [input.network, input.bundleId, input.sizeMb, input.valueKobo, input.validityDays, input.source],
  );
  return rows[0]!;
}

// Data going out of a pool comes from the lots that expire soonest, so the
// oldest gift is always the one spent. Returns what could not be matched to
// a lot, which happens when a pool was funded by hand.
export async function consumeLots(db: Queryable, network: NetworkCode, valueKobo: number): Promise<number> {
  let left = valueKobo;
  const { rows } = await db.query<DataLot>("SELECT * FROM data_lots WHERE network_code = $1 AND state = 'open' ORDER BY expires_at NULLS LAST, id FOR UPDATE", [network]);
  for (const lot of rows) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remaining_value_kobo);
    const remaining = lot.remaining_value_kobo - take;
    await db.query("UPDATE data_lots SET remaining_value_kobo = $2::bigint, state = CASE WHEN $2::bigint = 0 THEN 'used' ELSE 'open' END WHERE id = $1", [lot.id, remaining]);
    left -= take;
  }
  return left;
}

// Expired data is a loss, booked once per lot and never quietly.
export async function writeOffExpired(db: Queryable, now = new Date()): Promise<{ lots: number; valueKobo: number }> {
  const { rows } = await db.query<DataLot>("SELECT * FROM data_lots WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at < $1 AND remaining_value_kobo > 0 FOR UPDATE SKIP LOCKED", [now]);
  let value = 0;
  for (const lot of rows) {
    await postJournal(db, {
      idempotencyKey: `lot:${lot.id}:expiry`,
      description: `${lot.size_mb}MB on ${lot.network_code} from ${lot.source} expired unused, ${formatNaira(lot.remaining_value_kobo)} written off`,
      reference: lot.source,
      postings: [
        { account: "expense:losses", amountKobo: lot.remaining_value_kobo },
        { account: `datapool:${lot.network_code}`, amountKobo: -lot.remaining_value_kobo },
      ],
    });
    await db.query("UPDATE data_lots SET state = 'expired', written_off_at = now() WHERE id = $1", [lot.id]);
    value += lot.remaining_value_kobo;
  }
  return { lots: rows.length, valueKobo: value };
}

export async function openLots(db: Queryable): Promise<DataLot[]> {
  return (await db.query<DataLot>("SELECT * FROM data_lots WHERE state = 'open' ORDER BY expires_at NULLS LAST, id")).rows;
}

export async function expiringSoon(db: Queryable, days: number): Promise<{ network_code: string; value: number; lots: number }[]> {
  return (
    await db.query<{ network_code: string; value: number; lots: number }>(
      "SELECT network_code, sum(remaining_value_kobo)::bigint AS value, count(*)::int AS lots FROM data_lots WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at < now() + make_interval(days => $1) GROUP BY network_code",
      [days],
    )
  ).rows;
}
