import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";

type ScryptOptions = { N: number; r: number; p: number };
const scrypt = promisify(
  (password: string, salt: Buffer, keylen: number, options: ScryptOptions, cb: (err: Error | null, key: Buffer) => void) =>
    scryptCallback(password, salt, keylen, options, cb),
);

export type Admin = { id: number; email: string; name: string; active: boolean };

export const SESSION_DAYS = 14;

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

export async function createAdmin(db: Queryable, input: { email: string; name: string; password: string }): Promise<Admin> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserFacingError("bad_email", "That does not look like an email address.");
  const hash = await hashPassword(input.password);
  const { rows } = await db.query<Admin>(
    `INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, active = true
     RETURNING id, email, name, active`,
    [email, input.name.trim() || email, hash],
  );
  return rows[0]!;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Failed logins are slowed per email so a stolen list of addresses cannot be
// tried at speed. Kept in memory: a restart clears it, which is fine.
const failures = new Map<string, { count: number; until: number }>();

export function loginDelay(email: string, now = Date.now()): number {
  const f = failures.get(email);
  return f && f.until > now ? f.until - now : 0;
}

export async function login(db: Queryable, email: string, password: string, now = Date.now()): Promise<{ token: string; csrfToken: string; admin: Admin }> {
  const key = email.trim().toLowerCase();
  const wait = loginDelay(key, now);
  if (wait > 0) {
    throw new UserFacingError("too_many_attempts", `Too many wrong passwords. Wait ${Math.ceil(wait / 1000)} seconds and try again.`);
  }
  const { rows } = await db.query<Admin & { password_hash: string }>("SELECT id, email, name, active, password_hash FROM admins WHERE email = $1", [key]);
  const admin = rows[0];
  const ok = admin !== undefined && admin.active && (await verifyPassword(password, admin.password_hash));
  if (!ok) {
    const f = failures.get(key) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = now + Math.min(60_000, 1_000 * 2 ** Math.min(f.count, 6));
    failures.set(key, f);
    throw new UserFacingError("bad_login", "That email and password do not match. Check both, or ask the founder to reset your password from the server.");
  }
  failures.delete(key);
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
     RETURNING a.id, a.email, a.name, a.active, s.csrf_token`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { admin: { id: row.id, email: row.email, name: row.name, active: row.active }, csrfToken: row.csrf_token };
}

export async function logout(db: Queryable, token: string | undefined): Promise<void> {
  if (token) await db.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function countAdmins(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admins WHERE active");
  return rows[0]!.n;
}
