import type pg from "pg";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { balance, postJournal } from "./ledger.ts";
import { formatNaira, parseNaira } from "./money.ts";
import { queueBalanceCheck, type PhoneCommand } from "./sendingphone.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "./settings.ts";
import { committedAgainst } from "./transfers.ts";

// Checking our own books against the network.
//
// A pool is what our ledger believes is on a SIM. This asks the network
// what it says is on that SIM, and puts the two side by side. The gap is
// the thing worth knowing: a SIM barred with airtime on it, a send the rail
// swore had worked, airtime spent on an ordinary phone call, or our own
// arithmetic going wrong.

export type BalanceCheckState = "asked" | "answered" | "unreadable" | "failed";

export type BalanceCheck = {
  id: number;
  network_code: NetworkCode;
  device_id: number;
  command_id: number;
  state: BalanceCheckState;
  asked_at: Date;
  asked_by: string;
  answered_at: Date | null;
  reported_kobo: number | null;
  ledger_kobo: number | null;
  committed_kobo: number | null;
  difference_kobo: number | null;
  raw_text: string | null;
  accepted_at: Date | null;
  accepted_by: string | null;
  accepted_note: string | null;
};

// What the networks say when you ask: "Your balance is N1,234.56", "Bal:
// N50.00", "Airtime balance N0.00 valid till...". The first amount after
// the word balance, in any of its usual shortenings.
const BUILT_IN_BALANCE = /\bbal(?:ance)?\b[^0-9]{0,24}(?:NGN|N|₦)?\s*(?<amount>\d[\d,]*(?:\.\d{1,2})?)/i;

export function readBalance(text: string, pattern: string): { kobo: number } | { problem: string } {
  let re: RegExp;
  if (pattern.trim() === "") re = BUILT_IN_BALANCE;
  else {
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return { problem: `The balance pattern is not valid: ${(err as Error).message}` };
    }
  }
  const m = re.exec(text.replace(/\s+/g, " "));
  if (!m?.groups?.["amount"]) return { problem: "The reply does not say a balance we can read." };
  const kobo = parseNaira(m.groups["amount"]);
  if (kobo === undefined) return { problem: `"${m.groups["amount"]}" is not an amount in naira.` };
  return { kobo };
}

// What the SIM should be holding if the books are right: what the pool says
// it holds, less whatever has left the SIM on its way to somebody and has
// not yet been posted.
export async function expectedOnSim(db: Queryable, network: NetworkCode): Promise<{ ledgerKobo: number; committedKobo: number; expectedKobo: number }> {
  const ledgerKobo = await balance(db, `pool:${network}`);
  const committedKobo = await committedAgainst(db, `pool:${network}`);
  return { ledgerKobo, committedKobo, expectedKobo: ledgerKobo - committedKobo };
}

export async function askForBalance(db: pg.PoolClient, actor: string, network: string): Promise<{ check: BalanceCheck; command: PhoneCommand }> {
  const code = network.toUpperCase();
  if (!(NETWORK_CODES as readonly string[]).includes(code)) throw new UserFacingError("unknown_network", "Choose a network.");
  const command = await queueBalanceCheck(db, code as NetworkCode);
  const { rows } = await db.query<BalanceCheck>(
    "INSERT INTO balance_checks (network_code, device_id, command_id, asked_by) VALUES ($1, $2, $3, $4) RETURNING *",
    [code, command.device_id, command.id, actor],
  );
  return { check: rows[0]!, command };
}

// The phone has answered. What the network said is read, the books are read
// at the same moment, and the two are written down together so the figure
// can be looked at again later without being worked out again.
export async function recordBalanceAnswer(db: pg.PoolClient, command: PhoneCommand): Promise<BalanceCheck | undefined> {
  const existing = (await db.query<BalanceCheck>("SELECT * FROM balance_checks WHERE command_id = $1 FOR UPDATE", [command.id])).rows[0];
  if (!existing || existing.state !== "asked") return existing;
  // Only a command the phone has actually finished with says anything. A
  // result posted for a command nobody dialled leaves the check waiting
  // rather than writing down an answer that was never given.
  if (command.state !== "confirmed" && command.state !== "failed" && command.state !== "unknown") return existing;
  const text = command.response_text ?? "";
  if (command.state === "failed" || command.state === "unknown") {
    const { rows } = await db.query<BalanceCheck>(
      "UPDATE balance_checks SET state = 'failed', answered_at = now(), raw_text = $2 WHERE id = $1 RETURNING *",
      [existing.id, command.failure ?? text],
    );
    return rows[0]!;
  }
  const patterns = await getSettingValue(db, "network.balance_pattern");
  const read = readBalance(text, patterns[existing.network_code]);
  if ("problem" in read) {
    const { rows } = await db.query<BalanceCheck>(
      "UPDATE balance_checks SET state = 'unreadable', answered_at = now(), raw_text = $2 WHERE id = $1 RETURNING *",
      [existing.id, text],
    );
    return rows[0]!;
  }
  const { ledgerKobo, committedKobo, expectedKobo } = await expectedOnSim(db, existing.network_code);
  const { rows } = await db.query<BalanceCheck>(
    `UPDATE balance_checks SET state = 'answered', answered_at = now(), reported_kobo = $2, ledger_kobo = $3,
       committed_kobo = $4, difference_kobo = $5, raw_text = $6 WHERE id = $1 RETURNING *`,
    [existing.id, read.kobo, ledgerKobo, committedKobo, read.kobo - expectedKobo, text],
  );
  return rows[0]!;
}

export async function getBalanceCheck(db: Queryable, id: number): Promise<BalanceCheck | undefined> {
  return (await db.query<BalanceCheck>("SELECT * FROM balance_checks WHERE id = $1", [id])).rows[0];
}

// The last check on each network, which is what the Pools page shows.
export async function latestChecks(db: Queryable): Promise<Partial<Record<NetworkCode, BalanceCheck>>> {
  const { rows } = await db.query<BalanceCheck>(
    `SELECT DISTINCT ON (network_code) * FROM balance_checks ORDER BY network_code, id DESC`,
  );
  return Object.fromEntries(rows.map((r) => [r.network_code, r]));
}

export async function recentChecks(db: Queryable, limit = 20): Promise<BalanceCheck[]> {
  return (await db.query<BalanceCheck>("SELECT * FROM balance_checks ORDER BY id DESC LIMIT $1", [limit])).rows;
}

// Networks whose SIM has not been asked for longer than the founder set,
// and which can actually be asked right now.
export async function dueForCheck(db: Queryable, now = new Date()): Promise<NetworkCode[]> {
  const [minutes, codes] = await getSettingValues(db, ["phone.balance_check_minutes", "network.balance_code"] as const);
  if (minutes === 0) return [];
  const { rows } = await db.query<{ network_code: NetworkCode }>(
    `SELECT n.code AS network_code FROM networks n
     WHERE n.active
       AND EXISTS (SELECT 1 FROM bridge_devices d WHERE d.network_code = n.code AND d.active AND d.can_send AND d.pin_set AND d.last_seen_at > now() - interval '30 minutes')
       AND NOT EXISTS (SELECT 1 FROM balance_checks b WHERE b.network_code = n.code AND b.asked_at > $1::timestamptz - make_interval(mins => $2))
     ORDER BY n.code`,
    [now, minutes],
  );
  return rows.filter((r) => codes[r.network_code] !== "").map((r) => r.network_code);
}

// Queues the checks that are due. Runs on the minute, so it must never
// throw: a network that cannot be asked is simply not asked.
export async function queueDueChecks(db: pg.Pool, now = new Date()): Promise<NetworkCode[]> {
  const done: NetworkCode[] = [];
  for (const network of await dueForCheck(db, now)) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor', 'worker:balances', true)");
      await askForBalance(client, "worker:balances", network);
      await client.query("COMMIT");
      done.push(network);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!(err instanceof UserFacingError)) throw err;
    } finally {
      client.release();
    }
  }
  return done;
}

// The founder has looked at a difference and says it is real: the ledger is
// moved to where the network says we are, once, with a reason in the books.
export async function acceptDifference(db: pg.PoolClient, actor: string, id: number, note: string): Promise<BalanceCheck> {
  if (!note.trim()) throw new UserFacingError("missing_note", "Say what the difference was, so the books explain themselves later.");
  const c = (await db.query<BalanceCheck>("SELECT * FROM balance_checks WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!c) throw new UserFacingError("no_such_check", "There is no balance check with that id.");
  if (c.state !== "answered") throw new UserFacingError("not_answered", "That check has no readable balance to accept.");
  if (c.accepted_at) throw new UserFacingError("already_accepted", "That difference has already been put through the books.");
  const difference = c.difference_kobo!;
  if (difference === 0) throw new UserFacingError("no_difference", "There is no difference to put through: the SIM and the ledger agree.");
  const account = `pool:${c.network_code}`;
  // The SIM holding less than the books say is a loss. Holding more is
  // airtime the books never knew about, and it is not the founder's float,
  // so it goes to its own line rather than quietly into equity.
  await postJournal(db, {
    idempotencyKey: `balance:${c.id}:accepted`,
    description:
      difference < 0
        ? `${formatNaira(-difference)} missing from the ${c.network_code} SIM against the ledger, accepted by ${actor}: ${note.trim()}`
        : `${formatNaira(difference)} found on the ${c.network_code} SIM that the ledger did not know about, accepted by ${actor}: ${note.trim()}`,
    reference: `balance:${c.id}`,
    postings:
      difference < 0
        ? [{ account: "expense:losses", amountKobo: -difference }, { account, amountKobo: difference }]
        : [{ account, amountKobo: difference }, { account: "revenue:adjustments", amountKobo: -difference }],
  });
  const { rows } = await db.query<BalanceCheck>(
    "UPDATE balance_checks SET accepted_at = now(), accepted_by = $2, accepted_note = $3 WHERE id = $1 RETURNING *",
    [c.id, actor, note.trim()],
  );
  return rows[0]!;
}

export function describeDifference(c: BalanceCheck): string {
  if (c.state === "failed") return "The phone could not get an answer.";
  if (c.state === "unreadable") return "The network answered and we could not read a balance in it.";
  if (c.state === "asked") return "Waiting for the phone to dial.";
  const d = c.difference_kobo ?? 0;
  if (d === 0) return "The SIM and the ledger agree exactly.";
  return d < 0
    ? `The SIM is ${formatNaira(-d)} short of what the books expect.`
    : `The SIM holds ${formatNaira(d)} more than the books expect.`;
}
