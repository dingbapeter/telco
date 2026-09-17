import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { parseNaira } from "./money.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import { getSettingValue, NETWORK_CODES, type NetworkCode } from "./settings.ts";
import { recordInbound, type InboundOutcome } from "./transfers.ts";

export type Device = {
  id: number;
  label: string;
  network_code: NetworkCode;
  active: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  app_version: string | null;
  battery: number | null;
  queue_size: number | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The token is shown once, on the screen of the person who created the
// device, and typed into the phone. Only its hash is stored.
export async function createDevice(db: Queryable, label: string, network: string): Promise<{ device: Device; token: string }> {
  const code = network.toUpperCase();
  if (!(NETWORK_CODES as readonly string[]).includes(code)) throw new UserFacingError("unknown_network", "Choose the network whose SIM this phone holds.");
  if (!label.trim()) throw new UserFacingError("missing_label", "Give the phone a label you will recognise, like MTN phone in the office.");
  const token = "brg_" + randomBytes(24).toString("base64url");
  const { rows } = await db.query<Device>(
    "INSERT INTO bridge_devices (label, network_code, token_hash) VALUES ($1, $2, $3) RETURNING id, label, network_code, active, created_at, last_seen_at, app_version, battery, queue_size",
    [label.trim(), code, hashToken(token)],
  );
  return { device: rows[0]!, token };
}

export async function deviceFromToken(db: Queryable, token: string | undefined): Promise<Device | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<Device>(
    "SELECT id, label, network_code, active, created_at, last_seen_at, app_version, battery, queue_size FROM bridge_devices WHERE token_hash = $1 AND active",
    [hashToken(token)],
  );
  return rows[0];
}

export async function heartbeat(db: Queryable, deviceId: number, status: { appVersion?: string | undefined; battery?: number; queueSize?: number }): Promise<void> {
  await db.query("UPDATE bridge_devices SET last_seen_at = now(), app_version = coalesce($2, app_version), battery = coalesce($3, battery), queue_size = coalesce($4, queue_size) WHERE id = $1", [
    deviceId,
    status.appVersion ?? null,
    Number.isInteger(status.battery) ? status.battery : null,
    Number.isInteger(status.queueSize) ? status.queueSize : null,
  ]);
}

export async function listDevices(db: Queryable): Promise<Device[]> {
  const { rows } = await db.query<Device>("SELECT id, label, network_code, active, created_at, last_seen_at, app_version, battery, queue_size FROM bridge_devices ORDER BY network_code, id");
  return rows;
}

// The built-in reading of a network's message: the first amount after the
// word "received", and the first Nigerian phone number that is not our own.
const BUILT_IN = /receiv\w*\D{0,40}?(?:N|NGN|₦)?\s*(?<amount>\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)[\s\S]*?(?<sender>\+?(?:234|0)(?:[\s-]?\d){10})/i;

export type Parsed = { amountKobo: number; senderNumber: string } | { problem: string };

export function parseNetworkMessage(body: string, pattern: string): Parsed {
  let re: RegExp;
  if (pattern.trim() === "") re = BUILT_IN;
  else {
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return { problem: `The pattern is not valid: ${(err as Error).message}` };
    }
  }
  const m = re.exec(body.replace(/\s+/g, " "));
  if (!m || !m.groups) return { problem: "The pattern did not match the message." };
  const amountText = m.groups["amount"];
  const senderText = m.groups["sender"];
  if (!amountText) return { problem: "The pattern matched but has no (?<amount>...) group." };
  if (!senderText) return { problem: "The pattern matched but has no (?<sender>...) group." };
  const amountKobo = parseNaira(amountText);
  if (amountKobo === undefined || amountKobo <= 0) return { problem: `"${amountText}" is not an amount in naira.` };
  const senderNumber = normaliseNigerianNumber(senderText);
  if (!senderNumber) return { problem: `"${senderText}" is not a Nigerian mobile number.` };
  return { amountKobo, senderNumber };
}

export type IncomingMessage = { from: string; body: string; receivedAt?: string | undefined };

export type MessageResult = { outcome: string; messageId: number; transferReference?: string };

// Takes one text message from a phone. Records it whatever happens, and
// when it reads as airtime received on our number, records that as an
// inbound notification, which matches a waiting transfer if there is one.
export async function ingestMessage(db: pg.PoolClient, device: Device, receivingNumber: string | undefined, msg: IncomingMessage): Promise<MessageResult> {
  const receivedOnPhone = msg.receivedAt ? new Date(msg.receivedAt) : undefined;
  const validDate = receivedOnPhone && !Number.isNaN(receivedOnPhone.getTime()) ? receivedOnPhone : null;
  const hash = createHash("sha256").update([device.id, msg.from, msg.body, validDate?.toISOString() ?? ""].join("|")).digest("hex");
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO bridge_messages (device_id, from_address, body, received_on_phone_at, dedupe_hash, outcome)
     VALUES ($1, $2, $3, $4, $5, 'ignored') ON CONFLICT (dedupe_hash) DO NOTHING RETURNING id`,
    [device.id, msg.from, msg.body, validDate, hash],
  );
  const row = inserted.rows[0];
  if (!row) {
    const existing = await db.query<{ id: number }>("SELECT id FROM bridge_messages WHERE dedupe_hash = $1", [hash]);
    return { outcome: "duplicate", messageId: existing.rows[0]!.id };
  }
  const finish = async (outcome: string, notificationId: number | null, note: string | null, transferReference?: string): Promise<MessageResult> => {
    await db.query("UPDATE bridge_messages SET outcome = $2, notification_id = $3, note = $4 WHERE id = $1", [row.id, outcome, notificationId, note]);
    return transferReference ? { outcome, messageId: row.id, transferReference } : { outcome, messageId: row.id };
  };

  if (!receivingNumber) return finish("unparsed", null, `No active receiving number on ${device.network_code} is known for this phone. Add one under Receiving numbers.`);
  const patterns = await getSettingValue(db, "network.inbound_pattern");
  const parsed = parseNetworkMessage(msg.body, patterns[device.network_code]);
  if ("problem" in parsed) {
    // Most messages a phone gets are not airtime arriving. Only keep the
    // ones that look like they might be, so a person is not buried.
    const looksLikeAirtime = /receiv|credit|airtime|transfer/i.test(msg.body);
    return finish(looksLikeAirtime ? "unparsed" : "ignored", null, parsed.problem);
  }
  const outcome: InboundOutcome = await recordInbound(db, `bridge:${device.label}`, {
    networkCode: device.network_code,
    receivingNumber,
    senderNumber: parsed.senderNumber,
    amountKobo: parsed.amountKobo,
    rawText: msg.body,
    source: "bridge",
    ...(validDate ? { occurredAt: validDate } : {}),
  });
  const ref = "transfer" in outcome ? outcome.transfer.reference : undefined;
  return finish(outcome.outcome, outcome.notificationId, "reason" in outcome ? outcome.reason : null, ref);
}

// The receiving number a phone's messages belong to: the active number on
// that network. With more than one, the phone's label must name it.
export async function receivingNumberFor(db: Queryable, device: Device): Promise<string | undefined> {
  const { rows } = await db.query<{ number: string; label: string }>("SELECT number, label FROM receiving_numbers WHERE network_code = $1 AND active ORDER BY number", [device.network_code]);
  if (rows.length === 0) return undefined;
  const named = rows.find((r) => device.label.includes(r.number) || (r.label !== "" && device.label === r.label));
  return (named ?? rows[0])!.number;
}
