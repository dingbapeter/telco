import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { clearLoginFailures, loginWait, recordLoginFailure } from "./throttle.ts";

type ScryptOptions = { N: number; r: number; p: number };
const scrypt = promisify(
  (password: string, salt: Buffer, keylen: number, options: ScryptOptions, cb: (err: Error | null, key: Buffer) => void) =>
    scryptCallback(password, salt, keylen, options, cb),
);

export type Role = "founder" | "staff";

export type Admin = { id: number; email: string; name: string; active: boolean; role: Role };

// What only a founder may do. Everything else a person can log in for is
// the ordinary day's work: releasing a hold, paying somebody what they are
// owed, refunding, answering a customer.
//
// The rule lives here as data rather than being repeated in each page, so
// there is one place to read and one place to change. A path is matched by
// its start, and a rule with no method covers every method.
export type FounderRule = { method?: string; path: string; suffix?: string; why: string };

export const FOUNDER_ONLY: FounderRule[] = [
  { path: "/admin/people", why: "adding people and changing what they may do" },
  { method: "POST", path: "/admin/settings", why: "changing fees, rates, limits and switches" },
  { method: "POST", path: "/admin/pools/fund", why: "recording money or airtime put into the business" },
  { method: "POST", path: "/admin/pools/loss", why: "writing value off the books" },
  { method: "POST", path: "/admin/pools/balance/", why: "putting a difference between a SIM and the books through the ledger" },
  { method: "POST", path: "/admin/sellbacks/credit/void", why: "stopping credit somebody is holding" },
  { method: "POST", path: "/admin/bridge", suffix: "/admin/bridge", why: "setting up a phone, which hands out a token" },
  { method: "POST", path: "/admin/agents/", suffix: "/terms", why: "setting an agent's rates and credit line" },
];

// Why this person may not do this, or nothing when they may.
export function founderOnly(method: string, path: string): string | undefined {
  for (const rule of FOUNDER_ONLY) {
    if (rule.method && rule.method !== method) continue;
    if (!path.startsWith(rule.path)) continue;
    if (rule.suffix && !path.endsWith(rule.suffix)) continue;
    return rule.why;
  }
  return undefined;
}

export const SESSION_DAYS = 14;

// A real stored password, for a password nobody has. Checked when the email
// is unknown so that answer takes as long as a real one.
export const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

// scrypt with a per-password salt. The stored form names its own parameters
// so they can change later without invalidating old passwords.
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new UserFacingError("weak_password", "Use a password of at least 12 characters. A short sentence works well.");
  }
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })) as Buffer;
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = (await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) })) as Buffer;
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function createAdmin(db: Queryable, input: { email: string; name: string; password: string; role?: Role }): Promise<Admin> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserFacingError("bad_email", "That does not look like an email address.");
  const hash = await hashPassword(input.password);
  const { rows } = await db.query<Admin>(
    `INSERT INTO admins (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, active = true, role = EXCLUDED.role
     RETURNING id, email, name, active, role`,
    [email, input.name.trim() || email, hash, input.role ?? "founder"],
  );
  // A new password ends every session that was opened with the old one.
  // Resetting a password is what a person does when they fear someone else
  // is inside, so it has to put that person out.
  await db.query("DELETE FROM admin_sessions WHERE admin_id = $1", [rows[0]!.id]);
  return rows[0]!;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function loginDelay(email: string, now = Date.now()): number {
  return loginWait(email.trim().toLowerCase(), "", now);
}

export async function login(db: Queryable, email: string, password: string, now = Date.now(), from = ""): Promise<{ token: string; csrfToken: string; admin: Admin }> {
  const key = email.trim().toLowerCase();
  const wait = loginWait(key, from, now);
  if (wait > 0) {
    throw new UserFacingError("too_many_attempts", `Too many wrong passwords. Wait ${Math.ceil(wait / 1000)} seconds and try again.`);
  }
  const { rows } = await db.query<Admin & { password_hash: string }>("SELECT id, email, name, active, role, password_hash FROM admins WHERE email = $1", [key]);
  const admin = rows[0];
  const ok = admin !== undefined && admin.active && (await verifyPassword(password, admin.password_hash));
  if (!ok) {
    // An address nobody has an account for costs the same to try as one
    // that does, so nobody can learn who has an account by timing the
    // answer.
    if (admin === undefined) await verifyPassword(password, DUMMY_HASH);
    recordLoginFailure(key, from, now);
    throw new UserFacingError("bad_login", "That email and password do not match. Check both, or ask the founder to reset your password from the server.");
  }
  clearLoginFailures(key);
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(16).toString("base64url");
  await db.query(
    "INSERT INTO admin_sessions (token_hash, admin_id, expires_at, csrf_token) VALUES ($1, $2, now() + make_interval(days => $3), $4)",
    [hashToken(token), admin!.id, SESSION_DAYS, csrfToken],
  );
  const { password_hash: _ignored, ...safe } = admin!;
  return { token, csrfToken, admin: safe };
}

export async function sessionFromToken(db: Queryable, token: string | undefined): Promise<{ admin: Admin; csrfToken: string } | undefined> {
  if (!token) return undefined;
  const { rows } = await db.query<Admin & { csrf_token: string }>(
    `UPDATE admin_sessions s SET last_seen = now() FROM admins a
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.id = s.admin_id AND a.active
     RETURNING a.id, a.email, a.name, a.active, a.role, s.csrf_token`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { admin: { id: row.id, email: row.email, name: row.name, active: row.active, role: row.role }, csrfToken: row.csrf_token };
}

export async function logout(db: Queryable, token: string | undefined): Promise<void> {
  if (token) await db.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hashToken(token)]);
}

// Sessions that have run out are deleted rather than left lying about. A
// row nobody can use is still a row someone could steal a token hash from.
export async function forgetOldSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM admin_sessions WHERE expires_at < now()");
  return rowCount ?? 0;
}

export async function listAdmins(db: Queryable): Promise<(Admin & { created_at: Date; last_seen: Date | null })[]> {
  const { rows } = await db.query<Admin & { created_at: Date; last_seen: Date | null }>(
    `SELECT a.id, a.email, a.name, a.active, a.role, a.created_at,
            (SELECT max(s.last_seen) FROM admin_sessions s WHERE s.admin_id = a.id) AS last_seen
     FROM admins a ORDER BY a.created_at`,
  );
  return rows;
}

// Nobody may take their own powers away or put themselves out: a founder
// alone in the building could otherwise lock the door from the inside.
export async function setAdminRole(db: Queryable, actorId: number, id: number, role: Role): Promise<Admin> {
  if (actorId === id) throw new UserFacingError("not_yourself", "You cannot change what you yourself may do. Ask another founder.");
  const { rows } = await db.query<Admin>("UPDATE admins SET role = $2 WHERE id = $1 RETURNING id, email, name, active, role", [id, role]);
  if (!rows[0]) throw new UserFacingError("no_such_admin", "There is nobody with that id.");
  return rows[0];
}

export async function toggleAdmin(db: Queryable, actorId: number, id: number): Promise<Admin> {
  if (actorId === id) throw new UserFacingError("not_yourself", "You cannot pause your own login. Ask another founder.");
  const { rows } = await db.query<Admin>("UPDATE admins SET active = NOT active WHERE id = $1 RETURNING id, email, name, active, role", [id]);
  if (!rows[0]) throw new UserFacingError("no_such_admin", "There is nobody with that id.");
  // Pausing somebody puts them out of the building at once, not when their
  // session happens to run out.
  if (!rows[0].active) await db.query("DELETE FROM admin_sessions WHERE admin_id = $1", [id]);
  return rows[0];
}

export async function resetAdminPassword(db: Queryable, id: number): Promise<{ admin: Admin; password: string }> {
  const password = randomBytes(9).toString("base64url");
  const { rows } = await db.query<Admin>("UPDATE admins SET password_hash = $2 WHERE id = $1 RETURNING id, email, name, active, role", [id, await hashPassword(password)]);
  if (!rows[0]) throw new UserFacingError("no_such_admin", "There is nobody with that id.");
  await db.query("DELETE FROM admin_sessions WHERE admin_id = $1", [id]);
  return { admin: rows[0], password };
}

export async function countAdmins(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admins WHERE active");
  return rows[0]!.n;
}
