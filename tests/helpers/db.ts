import pg from "pg";
import { withActor } from "../../src/db.ts";

// Each test file shares one pool and starts from empty tables. Reference
// data (networks, prefixes, ledger accounts) stays; it comes from migrations.
export const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 5 });

export async function clean(): Promise<void> {
  await pool.query(
    "TRUNCATE transfer_events, inbound_notifications, transfers, ledger_postings, ledger_journals, receiving_numbers, settings, audit_log RESTART IDENTITY CASCADE",
  );
}

export function as<T>(actor: string, fn: Parameters<typeof withActor<T>>[1]): Promise<T> {
  return withActor(actor, fn, pool);
}

export async function addReceivingNumber(number: string, network: string, dailyCapKobo = 0): Promise<void> {
  await as("founder", (c) =>
    c.query("INSERT INTO receiving_numbers (number, network_code, label, daily_cap_kobo) VALUES ($1, $2, $3, $4)", [
      number,
      network,
      `${network} phone`,
      dailyCapKobo,
    ]),
  );
}

// Puts airtime into a pool the way the founder does: from their own pocket.
export async function fundPool(network: string, kobo: number): Promise<void> {
  const { postJournal } = await import("../../src/ledger.ts");
  await as("founder", (c) =>
    postJournal(c, {
      idempotencyKey: `test-fund:${network}:${kobo}:${Math.random()}`,
      description: `Founder funds ${network} pool`,
      postings: [
        { account: `pool:${network}`, amountKobo: kobo },
        { account: "equity:float", amountKobo: -kobo },
      ],
    }),
  );
}
