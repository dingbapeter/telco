import type { Queryable } from "./db.ts";
import type { NetworkCode } from "./settings.ts";

// Our own SIMs and how much has landed on them today. This sits in its own
// module because both sides of the business compete for the same SIMs:
// transfers waiting to be moved on, and airtime or data we are buying back.
// Keeping it here means neither of those two modules has to import the
// other.

// Lagos midnight, because every daily limit in the product is a Nigerian day.
export const START_OF_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

// A cap that counted only transfers would let what we buy back walk past it,
// and the network's own daily limit applies to the SIM, not to our reasons.
const USED_ON_NUMBER_TODAY = `(
  coalesce((SELECT sum(coalesce(t.received_kobo, t.requested_kobo)) FROM transfers t
            WHERE t.receiving_number = r.number AND t.created_at >= ${START_OF_TODAY} AND t.state NOT IN ('expired', 'refunded')), 0)
  + coalesce((SELECT sum(coalesce(s.received_kobo, s.face_kobo)) FROM sellbacks s
            WHERE s.receiving_number = r.number AND s.created_at >= ${START_OF_TODAY} AND s.state NOT IN ('expired', 'cancelled', 'returned')), 0)
)::bigint`;

// The receiving number with the most room left today takes the next job.
export async function chooseReceivingNumber(db: Queryable, network: NetworkCode, amountKobo: number): Promise<string | undefined> {
  const { rows } = await db.query<{ number: string }>(
    `SELECT r.number FROM receiving_numbers r
     LEFT JOIN LATERAL (SELECT ${USED_ON_NUMBER_TODAY} AS used) u ON true
     WHERE r.network_code = $1 AND r.active AND (r.daily_cap_kobo = 0 OR u.used + $2 <= r.daily_cap_kobo)
     ORDER BY CASE WHEN r.daily_cap_kobo = 0 THEN 0 ELSE u.used END ASC, r.number ASC LIMIT 1`,
    [network, amountKobo],
  );
  return rows[0]?.number;
}
