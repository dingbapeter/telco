import type { Queryable } from "./db.ts";
import { normaliseNigerianNumber } from "./phone.ts";
import type { NetworkCode } from "./settings.ts";

// One box for the question a person always asks first: what happened to
// this number, this reference, this code? Everything a customer could read
// out over the phone is looked up in one place, because making somebody
// try six pages while a customer waits is how mistakes are made.

export type Hit = {
  kind: "transfer" | "order" | "sale" | "credit" | "agent" | "message" | "command" | "list";
  title: string;
  detail: string;
  state: string;
  when: Date;
  href: string;
};

export type Found = { q: string; number: string | undefined; hits: Hit[]; looked: number };

const LIMIT = 10;

export async function find(db: Queryable, raw: string): Promise<Found> {
  const q = raw.trim();
  const hits: Hit[] = [];
  if (q === "") return { q, number: undefined, hits, looked: 0 };
  // A number may be typed any way a person says it, so it is looked up in
  // the form we store as well as the digits as typed.
  const number = normaliseNigerianNumber(q);
  const digits = q.replace(/\D/g, "");
  const like = `%${q}%`;
  const numberLike = digits.length >= 4 ? `%${digits}%` : null;
  const text = q.toUpperCase();

  const transfers = await db.query<{ id: number; reference: string; state: string; from_network: string; to_network: string; sender_number: string; recipient_number: string; requested_kobo: number; received_kobo: number | null; created_at: Date }>(
    `SELECT id, reference, state, from_network, to_network, sender_number, recipient_number, requested_kobo, received_kobo, created_at
     FROM transfers WHERE reference ILIKE $1 OR sender_number LIKE coalesce($2, 'x') OR recipient_number LIKE coalesce($2, 'x') OR receiving_number LIKE coalesce($2, 'x')
     ORDER BY id DESC LIMIT ${LIMIT}`,
    [like, numberLike],
  );
  for (const t of transfers.rows) {
    hits.push({
      kind: "transfer",
      title: t.reference,
      detail: `${t.from_network} ${t.sender_number} to ${t.to_network} ${t.recipient_number}, ${((t.received_kobo ?? t.requested_kobo) / 100).toLocaleString("en-NG")} naira`,
      state: t.state,
      when: t.created_at,
      href: `/admin/transfers/${t.id}`,
    });
  }

  const orders = await db.query<{ id: number; reference: string; state: string; network_code: NetworkCode; recipient_number: string; price_kobo: number; created_at: Date }>(
    `SELECT id, reference, state, network_code, recipient_number, price_kobo, created_at FROM orders
     WHERE reference ILIKE $1 OR payment_reference ILIKE $1 OR client_reference ILIKE $1 OR credit_code ILIKE $1 OR recipient_number LIKE coalesce($2, 'x')
     ORDER BY id DESC LIMIT ${LIMIT}`,
    [like, numberLike],
  );
  for (const o of orders.rows) {
    hits.push({ kind: "order", title: o.reference, detail: `${(o.price_kobo / 100).toLocaleString("en-NG")} naira of ${o.network_code} to ${o.recipient_number}`, state: o.state, when: o.created_at, href: `/admin/orders/${o.id}` });
  }

  const sales = await db.query<{ id: number; reference: string; state: string; network_code: NetworkCode; seller_number: string; face_kobo: number; received_kobo: number | null; created_at: Date; credit_code: string | null }>(
    `SELECT id, reference, state, network_code, seller_number, face_kobo, received_kobo, created_at, credit_code FROM sellbacks
     WHERE reference ILIKE $1 OR credit_code ILIKE $1 OR seller_number LIKE coalesce($2, 'x')
     ORDER BY id DESC LIMIT ${LIMIT}`,
    [like, numberLike],
  );
  for (const s of sales.rows) {
    hits.push({ kind: "sale", title: s.reference, detail: `${s.network_code} from ${s.seller_number}, ${((s.received_kobo ?? s.face_kobo) / 100).toLocaleString("en-NG")} naira${s.credit_code ? `, credit ${s.credit_code}` : ""}`, state: s.state, when: s.created_at, href: `/admin/sellbacks/${s.id}` });
  }

  const credits = await db.query<{ code: string; sellback_id: number; state: string; amount_kobo: number; remaining_kobo: number; created_at: Date }>(
    `SELECT code, sellback_id, state, amount_kobo, remaining_kobo, created_at FROM credit_notes WHERE code ILIKE $1 ORDER BY created_at DESC LIMIT ${LIMIT}`,
    [like],
  );
  for (const c of credits.rows) {
    hits.push({ kind: "credit", title: c.code, detail: `${(c.amount_kobo / 100).toLocaleString("en-NG")} naira issued, ${(c.remaining_kobo / 100).toLocaleString("en-NG")} left`, state: c.state, when: c.created_at, href: `/admin/sellbacks/${c.sellback_id}` });
  }

  const agents = await db.query<{ id: number; code: string; name: string; phone: string; active: boolean; created_at: Date }>(
    `SELECT id, code, name, phone, active, created_at FROM agents
     WHERE code ILIKE $1 OR name ILIKE $1 OR email ILIKE $1 OR phone LIKE coalesce($2, 'x') ORDER BY id DESC LIMIT ${LIMIT}`,
    [like, numberLike],
  );
  for (const a of agents.rows) {
    hits.push({ kind: "agent", title: `${a.name} (${a.code})`, detail: a.phone, state: a.active ? "active" : "paused", when: a.created_at, href: `/admin/agents/${a.id}` });
  }

  const batches = await db.query<{ reference: string; agent_id: number; lines: number; total_kobo: number; created_at: Date }>(
    `SELECT reference, agent_id, lines, total_kobo, created_at FROM agent_batches WHERE reference ILIKE $1 ORDER BY id DESC LIMIT ${LIMIT}`,
    [like],
  );
  for (const b of batches.rows) {
    hits.push({ kind: "list", title: b.reference, detail: `${b.lines} customers, ${(b.total_kobo / 100).toLocaleString("en-NG")} naira`, state: "bought", when: b.created_at, href: `/admin/agents/${b.agent_id}` });
  }

  const messages = await db.query<{ id: number; network_code: string; sender_number: string; amount_kobo: number; raw_text: string; received_at: Date; matched_transfer_id: number | null; matched_sellback_id: number | null }>(
    `SELECT id, network_code, sender_number, amount_kobo, raw_text, received_at, matched_transfer_id, matched_sellback_id FROM inbound_notifications
     WHERE sender_number LIKE coalesce($1, 'x') OR raw_text ILIKE $2 ORDER BY id DESC LIMIT ${LIMIT}`,
    [numberLike, like],
  );
  for (const m of messages.rows) {
    hits.push({
      kind: "message",
      title: `${m.network_code} message from ${m.sender_number}`,
      detail: m.raw_text.slice(0, 120),
      state: m.matched_transfer_id ? "matched to a transfer" : m.matched_sellback_id ? "matched to a sale" : "unmatched",
      when: m.received_at,
      href: m.matched_transfer_id ? `/admin/transfers/${m.matched_transfer_id}` : m.matched_sellback_id ? `/admin/sellbacks/${m.matched_sellback_id}` : "/admin/inbound",
    });
  }

  const commands = await db.query<{ id: number; network_code: string; kind: string; number: string; amount_kobo: number; state: string; created_at: Date; purpose: string }>(
    `SELECT id, network_code, kind, number, amount_kobo, state, created_at, purpose FROM phone_commands
     WHERE number LIKE coalesce($1, 'x') OR purpose ILIKE $2 ORDER BY id DESC LIMIT ${LIMIT}`,
    [numberLike, like],
  );
  for (const c of commands.rows) {
    hits.push({
      kind: "command",
      title: `${c.network_code} phone command ${c.id}`,
      detail: c.kind === "check_balance" ? "asked the network for this SIM's balance" : `${c.kind.replace("_", " ")} ${(c.amount_kobo / 100).toLocaleString("en-NG")} naira to ${c.number}`,
      state: c.state,
      when: c.created_at,
      href: "/admin/bridge",
    });
  }

  // Also look up a number as we store it, not only as it was typed.
  if (number && number !== digits) {
    const more = await find(db, number);
    for (const hit of more.hits) if (!hits.some((h) => h.kind === hit.kind && h.title === hit.title)) hits.push(hit);
  }

  hits.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
  return { q, number, hits, looked: 8 };
}

export const KIND_WORDS: Record<Hit["kind"], string> = {
  transfer: "Transfer",
  order: "Purchase from us",
  sale: "Sold to us",
  credit: "Credit code",
  agent: "Agent",
  message: "Network message",
  command: "Phone command",
  list: "Agent's list",
};
