import { createHash, randomInt } from "node:crypto";
import type pg from "pg";
import type { Agent } from "./agents.ts";
import { agentPrice } from "./agents.ts";
import { listBundles, parseSizeMb, type Bundle } from "./bundles.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { formatNaira, parseNaira } from "./money.ts";
import { normaliseNigerianNumber, prefixOf } from "./phone.ts";
import { createOrder, type Order } from "./orders.ts";
import { NETWORK_CODES, type NetworkCode } from "./settings.ts";

// A shop buys for twenty customers at once, from a list typed or pasted
// into one box. One line per customer, the way a shopkeeper writes it:
//
//   08031234567 500
//   0803 123 4567, 1GB
//   08161234567 airtel 200
//
// The network is worked out from the number and only needs saying when the
// customer has ported and the prefix would be wrong.
export const MAX_BULK_LINES = 200;

export type BulkRequest = {
  lineNo: number;
  raw: string;
  number: string;
  network?: NetworkCode | undefined;
  amountKobo?: number | undefined;
  bundleText?: string | undefined;
};

const NETWORK_WORDS: Record<string, NetworkCode> = {
  MTN: "MTN",
  AIRTEL: "AIRTEL",
  GLO: "GLO",
  GLOBACOM: "GLO",
  "9MOBILE": "9MOBILE",
  "9M": "9MOBILE",
  ETISALAT: "9MOBILE",
};

// A field that is plainly an amount of money: digits, with a naira sign,
// thousands commas or kobo allowed. Kept tighter than parseNaira so a
// bundle code that happens to start with a digit is not read as money.
const LOOKS_LIKE_MONEY = /^[N₦]?\d[\d,]*(?:\.\d{1,2})?$/i;

// A number as it is pasted from a message: "0803 123 4567", "+234 803 123
// 4567", "08031234567". The digits of the amount that follows must not be
// swallowed into it, so the longest leading run of digits and spaces is
// tried at thirteen digits, then eleven, then ten, and the first length
// that is a real Nigerian mobile number wins.
function takeNumber(line: string): { number: string; rest: string } | undefined {
  const run = /^[+\d\s-]+/.exec(line)?.[0] ?? "";
  const digits = run.replace(/\D/g, "");
  for (const length of [13, 11, 10]) {
    if (digits.length < length) continue;
    const number = normaliseNigerianNumber(digits.slice(0, length));
    if (!number) continue;
    // Walk the original text again to find where those digits ended, so
    // the spaces inside the number are not mistaken for separators.
    let taken = 0;
    let at = 0;
    while (at < run.length && taken < length) {
      if (/\d/.test(run[at]!)) taken += 1;
      at += 1;
    }
    return { number, rest: line.slice(at) };
  }
  return undefined;
}

// Fields are separated by spaces, semicolons, or commas. A comma between
// two digits is a thousands separator, so "1,000" stays one field.
function splitFields(rest: string): string[] {
  return rest.replace(/(?<!\d),|,(?!\d)/g, " ").split(/[\s;]+/).filter(Boolean);
}

export function parseBulkText(text: string): { requests: BulkRequest[]; problems: string[] } {
  const requests: BulkRequest[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    const lineNo = i + 1;
    // A blank line is spacing, and a line starting with # is the agent's
    // own note to themselves.
    if (raw === "" || raw.startsWith("#")) continue;
    const head = takeNumber(raw);
    if (!head) {
      problems.push(`Line ${lineNo}: "${raw}" does not start with a Nigerian mobile number like 08031234567.`);
      continue;
    }
    const request: BulkRequest = { lineNo, raw, number: head.number };
    const fields = splitFields(head.rest);
    let bad = false;
    for (const field of fields) {
      const word = field.toUpperCase();
      if (NETWORK_WORDS[word]) {
        if (request.network) {
          problems.push(`Line ${lineNo}: two networks named. Put one, or none at all.`);
          bad = true;
          break;
        }
        request.network = NETWORK_WORDS[word];
        continue;
      }
      if (LOOKS_LIKE_MONEY.test(field)) {
        const amount = parseNaira(field);
        if (amount === undefined) {
          problems.push(`Line ${lineNo}: "${field}" is not an amount in naira.`);
          bad = true;
          break;
        }
        if (request.amountKobo !== undefined || request.bundleText !== undefined) {
          problems.push(`Line ${lineNo}: say either an amount of airtime or one data bundle, not both.`);
          bad = true;
          break;
        }
        request.amountKobo = amount;
        continue;
      }
      if (request.bundleText !== undefined || request.amountKobo !== undefined) {
        problems.push(`Line ${lineNo}: say either an amount of airtime or one data bundle, not both.`);
        bad = true;
        break;
      }
      request.bundleText = field;
    }
    if (bad) continue;
    if (request.amountKobo === undefined && request.bundleText === undefined) {
      problems.push(`Line ${lineNo}: "${raw}" says a number but not what to buy. Add an amount like 500, or a bundle like 1GB.`);
      continue;
    }
    requests.push(request);
  }
  return { requests, problems };
}

// The reference is made when the form is opened and comes back with it, so
// a second tap on a slow phone lands on the batch that already exists.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newBatchReference(): string {
  let s = "BK-";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

// An agent's own software sends its own reference instead. The batch
// reference is worked out from it, so the same request asked twice lands on
// the same batch without us keeping a second table of what was asked.
export function batchReferenceFor(agentId: number, clientReference: string): string {
  const digest = createHash("sha256").update(`${agentId}:${clientReference}`).digest();
  let s = "BK-";
  for (let i = 0; i < 12; i++) s += ALPHABET[digest[i]! % ALPHABET.length];
  return s;
}

export type Batch = { id: number; reference: string; agent_id: number; lines: number; total_kobo: number; created_at: Date; created_by: string };

export async function getBatch(db: Queryable, reference: string): Promise<Batch | undefined> {
  return (await db.query<Batch>("SELECT * FROM agent_batches WHERE reference = $1", [reference.trim().toUpperCase()])).rows[0];
}

export async function batchOrders(db: Queryable, batchId: number): Promise<Order[]> {
  return (await db.query<Order>("SELECT * FROM orders WHERE batch_id = $1 ORDER BY id", [batchId])).rows;
}

export async function recentBatches(db: Queryable, agentId: number, limit = 10): Promise<(Batch & { delivered: number; failed: number })[]> {
  const { rows } = await db.query<Batch & { delivered: number; failed: number }>(
    `SELECT b.*,
            (SELECT count(*)::int FROM orders o WHERE o.batch_id = b.id AND o.state = 'delivered') AS delivered,
            (SELECT count(*)::int FROM orders o WHERE o.batch_id = b.id AND o.state IN ('delivery_failed', 'held', 'refunded')) AS failed
     FROM agent_batches b WHERE b.agent_id = $1 ORDER BY b.id DESC LIMIT $2`,
    [agentId, limit],
  );
  return rows;
}

async function networkFor(db: Queryable, request: BulkRequest): Promise<NetworkCode> {
  if (request.network) return request.network;
  const { rows } = await db.query<{ network_code: NetworkCode }>("SELECT network_code FROM network_prefixes WHERE prefix = $1", [prefixOf(request.number)]);
  const found = rows[0]?.network_code;
  if (!found) {
    throw new UserFacingError("unknown_prefix", `Line ${request.lineNo}: we do not know which network ${request.number} is on. Put the network on the line, like "${request.number} MTN 500".`);
  }
  return found;
}

// "1GB" and "1.5GB" are how a shop writes it; the bundle's own code works
// too. Anything that matches more than one bundle is refused by name so
// the agent picks, rather than us guessing which they meant.
function bundleFor(request: BulkRequest, network: NetworkCode, bundles: Bundle[]): Bundle {
  const text = request.bundleText!;
  const onNetwork = bundles.filter((b) => b.network_code === network);
  const byCode = onNetwork.filter((b) => b.code.toUpperCase() === text.toUpperCase());
  if (byCode.length === 1) return byCode[0]!;
  const mb = parseSizeMb(text);
  const bySize = mb === undefined ? [] : onNetwork.filter((b) => b.size_mb === mb);
  if (bySize.length === 1) return bySize[0]!;
  if (bySize.length > 1) {
    throw new UserFacingError("ambiguous_bundle", `Line ${request.lineNo}: ${network} has more than one ${text} bundle (${bySize.map((b) => b.code).join(", ")}). Put the code you want on the line instead.`);
  }
  throw new UserFacingError("no_such_bundle", `Line ${request.lineNo}: ${network} has no bundle called ${text}. The bundles on offer are on the buy page.`);
}

export type BulkResult = { batch: Batch; orders: Order[]; created: boolean };

// Every line or none. One transaction, so a wallet that runs out halfway
// leaves no half bought batch and the agent sees exactly which line stopped
// it.
export async function buyInBulk(db: pg.PoolClient, agent: Agent, actor: string, input: { reference: string; text: string }): Promise<BulkResult> {
  const reference = input.reference.trim().toUpperCase();
  if (!/^BK-[A-Z0-9]{8,12}$/.test(reference)) throw new UserFacingError("bad_batch_reference", "That list reference is not one of yours. Reload the page and paste the list again.");
  const { requests, problems } = parseBulkText(input.text);
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join(" ");
    throw new UserFacingError("bad_bulk_lines", `${shown}${problems.length > 5 ? ` And ${problems.length - 5} more like it.` : ""} Nothing was bought.`);
  }
  if (requests.length === 0) throw new UserFacingError("empty_bulk", "Put one customer on each line, like 08031234567 500.");
  if (requests.length > MAX_BULK_LINES) throw new UserFacingError("bulk_too_long", `That is ${requests.length} lines and ${MAX_BULK_LINES} is the most in one go. Split it and send the rest after.`);

  const existing = (await db.query<Batch>("INSERT INTO agent_batches (reference, agent_id, lines, total_kobo, created_by) VALUES ($1, $2, $3, 0, $4) ON CONFLICT (reference) DO NOTHING RETURNING *", [reference, agent.id, requests.length, actor])).rows[0];
  if (!existing) {
    const already = await getBatch(db, reference);
    // Somebody else's reference is not ours to show.
    if (!already || already.agent_id !== agent.id) throw new UserFacingError("bad_batch_reference", "That list reference is not one of yours. Reload the page and paste the list again.");
    return { batch: already, orders: await batchOrders(db, already.id), created: false };
  }

  const bundles = await listBundles(db, { activeOnly: true });
  const orders: Order[] = [];
  let total = 0;
  for (const request of requests) {
    const network = await networkFor(db, request);
    const bundle = request.bundleText === undefined ? undefined : bundleFor(request, network, bundles);
    try {
      const order = await createOrder(db, actor, {
        network,
        recipientNumber: request.number,
        faceKobo: bundle ? undefined : request.amountKobo,
        bundleId: bundle?.id,
        agentId: agent.id,
        fromWallet: true,
        batchId: existing.id,
      });
      orders.push(order);
      total += order.price_kobo;
    } catch (err) {
      // Which line stopped it, in the agent's words, with the whole batch
      // rolled back by the caller's transaction.
      if (err instanceof UserFacingError) throw new UserFacingError(err.code, `Line ${request.lineNo} (${request.number}${bundle ? ` ${bundle.name}` : ` ${formatNaira(request.amountKobo!)}`}): ${err.message} Nothing in this list was bought.`);
      throw err;
    }
  }
  const batch = (await db.query<Batch>("UPDATE agent_batches SET total_kobo = $2 WHERE id = $1 RETURNING *", [existing.id, total])).rows[0]!;
  return { batch, orders, created: true };
}

// Named networks in one place so the pages and the interface agree.
export const BULK_NETWORK_WORDS = Object.keys(NETWORK_WORDS);
