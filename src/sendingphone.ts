import type pg from "pg";
import { describeBundle, getBundle, type Bundle } from "./bundles.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { formatNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import type { PayoutRail, ProviderBundle, RailHealth, SendInput, SendResult } from "./rails/rail.ts";
import { getSettingValue, getSettingValues, type NetworkCode } from "./settings.ts";

export type CommandState = "queued" | "fetched" | "dialled" | "confirmed" | "failed" | "unknown";

export type PhoneCommand = {
  id: number;
  device_id: number;
  network_code: NetworkCode;
  kind: "send_airtime" | "gift_data";
  number: string;
  amount_kobo: number;
  bundle_id: number | null;
  code: string;
  purpose: string;
  state: CommandState;
  created_at: Date;
  fetched_at: Date | null;
  dialled_at: Date | null;
  response_text: string | null;
  failure: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
};

// The built-in reading of a network's "you have sent" reply: a word for
// success and the number it went to.
const BUILT_IN_SENT = /(?:sent|transferr?ed|successful|gifted|shared|top-?up)[\s\S]{0,80}?(?<number>\+?(?:234|0)(?:[\s-]?\d){10})/i;

export function readSentConfirmation(text: string, pattern: string): { number: string } | { problem: string } {
  let re: RegExp;
  if (pattern.trim() === "") re = BUILT_IN_SENT;
  else {
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return { problem: `The sent pattern is not valid: ${(err as Error).message}` };
    }
  }
  const m = re.exec(text.replace(/\s+/g, " "));
  if (!m || !m.groups?.["number"]) return { problem: "The reply does not read as a confirmation." };
  const number = normaliseNigerianNumber(m.groups["number"]);
  if (!number) return { problem: `"${m.groups["number"]}" is not a Nigerian mobile number.` };
  return { number };
}

// Failures the phone's dialler reports, in the network's own terms, that
// mean try again later rather than stop.
const RETRYABLE_REPLY = /(busy|try again|later|timeout|not available|unavailable|network error|failed to connect|temporarily)/i;
const FINAL_REPLY = /(invalid|incorrect|wrong pin|not allowed|not eligible|does not exist|blocked|barred|insufficient|not enough|limit)/i;

export async function sendingPhoneFor(db: Queryable, network: NetworkCode): Promise<{ id: number; label: string } | undefined> {
  const { rows } = await db.query<{ id: number; label: string }>(
    "SELECT id, label FROM bridge_devices WHERE network_code = $1 AND active AND can_send AND pin_set AND last_seen_at > now() - interval '30 minutes' ORDER BY last_seen_at DESC LIMIT 1",
    [network],
  );
  return rows[0];
}

export type QueueInput = { network: NetworkCode; number: string; amountKobo: number; bundle?: Bundle | undefined; purpose: string };

// Starts with one star, ends with a hash, and nothing in between but the
// characters a top-up code is made of. Two stars, or a star and a hash, at
// the front is the shape of a code that changes the phone itself.
export function looksLikeTopUpCode(code: string): boolean {
  const filled = code.replaceAll("{pin}", "0000");
  return /^\*(?![*#])[0-9*#A-Za-z ]{1,60}#$/.test(filled);
}

// Asks the sending phone on a network to send airtime or gift a bundle. The
// code comes from the settings with the amount and number filled in and the
// PIN left for the phone.
export async function queueCommand(db: Queryable, input: QueueInput): Promise<PhoneCommand> {
  const phone = await sendingPhoneFor(db, input.network);
  if (!phone) throw new UserFacingError("no_sending_phone", `No phone on ${input.network} can send right now. It needs the app allowed to make calls, its PIN entered, and to have reported in the last 30 minutes.`);
  const [transferCodes, giftCodes] = await getSettingValues(db, ["network.transfer_code", "network.data_gift_code"] as const);
  const template = input.bundle ? giftCodes[input.network] : transferCodes[input.network];
  if (!template) throw new UserFacingError("no_code", `No ${input.bundle ? "data gifting" : "transfer"} code is set for ${input.network} under Settings, Networks.`);
  const amountNaira = input.amountKobo % 100 === 0 ? String(input.amountKobo / 100) : (input.amountKobo / 100).toFixed(2);
  const code = template.replace("{amount}", amountNaira).replace("{number}", input.number).replace("{size}", input.bundle ? input.bundle.name : "");
  // A phone is only ever asked to dial a top-up code. A code beginning
  // with two stars or a star and a hash is how a phone is told to forward
  // its calls or change its own settings, and no top-up code looks like
  // that. The phone keeps the same rule, so neither side alone decides it.
  if (!looksLikeTopUpCode(code)) {
    throw new UserFacingError("bad_code", `The ${input.network} code does not read as a top-up code once filled in: ${code}. Check it under Settings, Networks.`);
  }
  const { rows } = await db.query<PhoneCommand>(
    `INSERT INTO phone_commands (device_id, network_code, kind, number, amount_kobo, bundle_id, code, purpose, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued') RETURNING *`,
    [phone.id, input.network, input.bundle ? "gift_data" : "send_airtime", input.number, input.amountKobo, input.bundle?.id ?? null, code, input.purpose],
  );
  return rows[0]!;
}

// The phone asks for work. Each command is handed out once.
export async function fetchCommands(db: Queryable, deviceId: number, limit = 5): Promise<PhoneCommand[]> {
  const { rows } = await db.query<PhoneCommand>(
    `UPDATE phone_commands SET state = 'fetched', fetched_at = now()
     WHERE id IN (SELECT id FROM phone_commands WHERE device_id = $1 AND state = 'queued' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [deviceId, limit],
  );
  return rows;
}

export async function getCommand(db: Queryable, id: number): Promise<PhoneCommand | undefined> {
  return (await db.query<PhoneCommand>("SELECT * FROM phone_commands WHERE id = $1", [id])).rows[0];
}

// The phone reports what happened when it dialled. A reply that reads as a
// confirmation for the right number completes the command; one that reads
// as a final refusal fails it; anything else waits for the network's text
// message or for the timeout.
export async function reportResult(db: Queryable, deviceId: number, commandId: number, result: { ok: boolean; response?: string | undefined; failure?: string | undefined }): Promise<PhoneCommand | undefined> {
  const c = (await db.query<PhoneCommand>("SELECT * FROM phone_commands WHERE id = $1 AND device_id = $2 FOR UPDATE", [commandId, deviceId])).rows[0];
  if (!c) return undefined;
  if (c.state !== "fetched" && c.state !== "dialled") return c;
  const response = result.response ?? "";
  if (!result.ok) {
    const failure = result.failure ?? "The phone could not dial the code.";
    const retryable = RETRYABLE_REPLY.test(failure) || /USSD|dial/i.test(failure);
    return (await db.query<PhoneCommand>("UPDATE phone_commands SET state = 'failed', dialled_at = coalesce(dialled_at, now()), failure = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1 RETURNING *", [c.id, `${retryable ? "retry:" : "final:"} ${failure}`, "phone"])).rows[0];
  }
  const patterns = await getSettingValue(db, "network.sent_pattern");
  const read = readSentConfirmation(response, patterns[c.network_code]);
  if (!("problem" in read) && read.number === c.number) {
    return (await db.query<PhoneCommand>("UPDATE phone_commands SET state = 'confirmed', dialled_at = coalesce(dialled_at, now()), response_text = $2, resolved_at = now(), resolved_by = 'phone' WHERE id = $1 RETURNING *", [c.id, response])).rows[0];
  }
  if (FINAL_REPLY.test(response)) {
    return (await db.query<PhoneCommand>("UPDATE phone_commands SET state = 'failed', dialled_at = coalesce(dialled_at, now()), response_text = $2, failure = $3, resolved_at = now(), resolved_by = 'phone' WHERE id = $1 RETURNING *", [c.id, response, `final: ${response.slice(0, 200)}`])).rows[0];
  }
  return (await db.query<PhoneCommand>("UPDATE phone_commands SET state = 'dialled', dialled_at = coalesce(dialled_at, now()), response_text = $2 WHERE id = $1 RETURNING *", [c.id, response])).rows[0];
}

// A text message from the network on the sending phone may be the
// confirmation for a command still waiting. Returns the command it settled.
export async function confirmFromMessage(db: Queryable, deviceId: number, body: string): Promise<PhoneCommand | undefined> {
  const waiting = (await db.query<PhoneCommand>("SELECT * FROM phone_commands WHERE device_id = $1 AND state IN ('fetched', 'dialled') ORDER BY id", [deviceId])).rows;
  if (waiting.length === 0) return undefined;
  const patterns = await getSettingValue(db, "network.sent_pattern");
  const read = readSentConfirmation(body, patterns[waiting[0]!.network_code]);
  if ("problem" in read) return undefined;
  const c = waiting.find((w) => w.number === read.number);
  if (!c) return undefined;
  return (await db.query<PhoneCommand>("UPDATE phone_commands SET state = 'confirmed', dialled_at = coalesce(dialled_at, now()), response_text = coalesce(response_text, '') || $2, resolved_at = now(), resolved_by = 'network message' WHERE id = $1 AND state IN ('fetched', 'dialled') RETURNING *", [c.id, `\n${body}`])).rows[0];
}

// Nothing is ever dialled twice on a guess: a command that got no
// confirmation in time is left for a person, who reads the phone.
export async function expireCommands(db: Queryable, timeoutMinutes: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "UPDATE phone_commands SET state = 'unknown', failure = 'No confirmation from the network in time. Check the phone.', resolved_at = now(), resolved_by = 'timeout' WHERE state IN ('fetched', 'dialled') AND coalesce(dialled_at, fetched_at) < now() - make_interval(mins => $1) RETURNING id",
    [timeoutMinutes],
  );
  return rows.length;
}

export async function resolveByHand(db: Queryable, actor: string, commandId: number, outcome: "confirmed" | "failed", note: string): Promise<PhoneCommand> {
  const { rows } = await db.query<PhoneCommand>(
    "UPDATE phone_commands SET state = $2, failure = CASE WHEN $2 = 'failed' THEN $3 ELSE failure END, response_text = coalesce(response_text, '') || $4, resolved_at = now(), resolved_by = $5 WHERE id = $1 AND state IN ('fetched', 'dialled', 'unknown') RETURNING *",
    [commandId, outcome, `final: ${note}`, `\n[by hand] ${note}`, actor],
  );
  if (!rows[0]) throw new UserFacingError("not_open", "That command is already settled.");
  return rows[0];
}

// The sending phone as a rail: send queues a command, check reads it.
export class PhoneRail implements PayoutRail {
  readonly name = "phone";
  readonly fundingAccount = "pool:MTN";
  private db: pg.Pool;
  constructor(db: pg.Pool) {
    this.db = db;
  }
  fundingAccountFor(network: NetworkCode, bundle?: { id: number } | undefined): string {
    return bundle ? `datapool:${network}` : `pool:${network}`;
  }
  async available(network: NetworkCode): Promise<boolean> {
    return (await sendingPhoneFor(this.db, network)) !== undefined;
  }
  async send(input: SendInput): Promise<SendResult> {
    try {
      const bundle = input.bundle ? (await this.db.query<Bundle>("SELECT * FROM data_bundles WHERE provider_variation_code = $1 OR code = $1 ORDER BY id LIMIT 1", [input.bundle.variationCode])).rows[0] : undefined;
      const c = await queueCommand(this.db, { network: input.network, number: input.number, amountKobo: input.amountKobo, bundle, purpose: input.requestId });
      await this.db.query("UPDATE phone_commands SET purpose = $2 WHERE id = $1", [c.id, input.requestId]);
      return { kind: "processing", message: `Queued for the ${input.network} sending phone as command ${c.id}.` };
    } catch (err) {
      return { kind: "retry", message: err instanceof UserFacingError ? err.message : `Could not queue for the phone: ${(err as Error).message}` };
    }
  }
  async check(requestId: string): Promise<SendResult> {
    const c = (await this.db.query<PhoneCommand>("SELECT * FROM phone_commands WHERE purpose = $1 ORDER BY id DESC LIMIT 1", [requestId])).rows[0];
    if (!c) return { kind: "failed", message: "No phone command exists for this item; nothing was dialled." };
    switch (c.state) {
      case "confirmed":
        return { kind: "delivered", reference: `phone:${c.id}`, chargedKobo: c.amount_kobo, commissionKobo: 0, message: "The network confirmed it." };
      case "failed":
        return c.failure?.startsWith("retry:") ? { kind: "retry", message: c.failure.slice(6).trim() } : { kind: "failed", message: (c.failure ?? "The phone reported a failure.").replace(/^final:\s*/, "") };
      case "unknown":
        return { kind: "failed", message: `${c.failure ?? "No confirmation."} Command ${c.id} on the Phone bridge page: read the phone and settle it by hand.` };
      default:
        return { kind: "processing", message: `Waiting for the ${c.network_code} phone to dial and the network to confirm (command ${c.id}).` };
    }
  }
  async listDataBundles(): Promise<ProviderBundle[]> {
    return [];
  }
  async health(): Promise<RailHealth> {
    const { rows } = await this.db.query<{ network_code: string; label: string }>("SELECT network_code, label FROM bridge_devices WHERE active AND can_send AND pin_set AND last_seen_at > now() - interval '30 minutes'");
    return rows.length === 0 ? { ok: false, message: "No phone can send right now." } : { ok: true, message: `Sending phones: ${rows.map((r) => `${r.network_code} (${r.label})`).join(", ")}.` };
  }
}

export function describeCommand(c: PhoneCommand, bundle?: Bundle | undefined): string {
  return c.kind === "gift_data" ? `gift ${bundle ? describeBundle(bundle) : "a bundle"} to ${c.number}` : `send ${formatNaira(c.amount_kobo)} to ${c.number}`;
}

export { getBundle };
