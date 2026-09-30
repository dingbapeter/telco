import { createHash, randomBytes, randomInt } from "node:crypto";
import { type Agent } from "./agents.ts";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";

// Keys for an agent's own till or POS software. Only the hash of a key is
// kept, the way the phone bridge keeps its tokens: a key we cannot read is
// a key nobody can take from us. The short id is kept in clear so a person
// can see which key is which without ever seeing the key.

export type ApiKey = { id: number; agent_id: number; label: string; key_id: string; active: boolean; created_at: Date; created_by: string; last_used_at: Date | null; revoked_at: Date | null };

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const MAX_KEYS_PER_AGENT = 5;

function newKeyId(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The id sits inside the key so a person reading a key in their own
// configuration file can match it to the row in their portal.
export function newApiToken(): { token: string; keyId: string } {
  const keyId = newKeyId();
  return { token: `tk_${keyId}_${randomBytes(24).toString("base64url")}`, keyId };
}

export async function createApiKey(db: Queryable, agentId: number, label: string, createdBy: string): Promise<{ key: ApiKey; token: string }> {
  const name = label.trim();
  if (!name) throw new UserFacingError("missing_label", "Give the key a name, so you know which machine it is for.");
  if (name.length > 60) throw new UserFacingError("long_label", "Keep the name under sixty characters.");
  const { rows: existing } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_api_keys WHERE agent_id = $1 AND active", [agentId]);
  if (existing[0]!.n >= MAX_KEYS_PER_AGENT) throw new UserFacingError("too_many_keys", `You already have ${MAX_KEYS_PER_AGENT} keys in use, which is the most allowed. Revoke one you no longer need first.`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { token, keyId } = newApiToken();
    const { rows } = await db.query<ApiKey>(
      `INSERT INTO agent_api_keys (agent_id, label, key_id, token_hash, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key_id) DO NOTHING RETURNING id, agent_id, label, key_id, active, created_at, created_by, last_used_at, revoked_at`,
      [agentId, name, keyId, hashToken(token), createdBy],
    );
    if (rows[0]) return { key: rows[0], token };
  }
  throw new Error("Could not find a free key id.");
}

export async function listApiKeys(db: Queryable, agentId: number): Promise<ApiKey[]> {
  const { rows } = await db.query<ApiKey>(
    "SELECT id, agent_id, label, key_id, active, created_at, created_by, last_used_at, revoked_at FROM agent_api_keys WHERE agent_id = $1 ORDER BY id DESC",
    [agentId],
  );
  return rows;
}

export async function revokeApiKey(db: Queryable, agentId: number, id: number): Promise<ApiKey> {
  // The agent id is in the condition, not just the row, so one agent can
  // never revoke another's key by guessing a number.
  const { rows } = await db.query<ApiKey>(
    `UPDATE agent_api_keys SET active = false, revoked_at = now() WHERE id = $1 AND agent_id = $2 AND active
     RETURNING id, agent_id, label, key_id, active, created_at, created_by, last_used_at, revoked_at`,
    [id, agentId],
  );
  const key = rows[0];
  if (!key) throw new UserFacingError("no_such_key", "That key is not one of yours, or it was revoked already.");
  return key;
}

// Who is calling. A key that is revoked, or whose agent is paused, gets the
// same answer as one that never existed.
export async function agentFromApiKey(db: Queryable, token: string | undefined): Promise<{ agent: Agent; key: ApiKey } | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<Agent & { key_pk: number; label: string; key_id: string; key_created_at: Date; created_by: string; last_used_at: Date | null }>(
    `SELECT a.id, a.code, a.name, a.phone, a.email, a.active, a.created_at, a.discount_basis_points, a.commission_basis_points, a.credit_limit_kobo,
            k.id AS key_pk, k.label, k.key_id, k.created_at AS key_created_at, k.created_by, k.last_used_at
     FROM agent_api_keys k JOIN agents a ON a.id = k.agent_id
     WHERE k.token_hash = $1 AND k.active AND a.active`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return undefined;
  // Written at most once a minute, so a busy till does not turn every
  // purchase into two writes.
  await db.query("UPDATE agent_api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [r.key_pk]);
  return {
    agent: { id: r.id, code: r.code, name: r.name, phone: r.phone, email: r.email, active: r.active, created_at: r.created_at, discount_basis_points: r.discount_basis_points, commission_basis_points: r.commission_basis_points, credit_limit_kobo: r.credit_limit_kobo },
    key: { id: r.key_pk, agent_id: r.id, label: r.label, key_id: r.key_id, active: true, created_at: r.key_created_at, created_by: r.created_by, last_used_at: r.last_used_at, revoked_at: null },
  };
}
