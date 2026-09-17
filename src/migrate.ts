import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "./db.ts";
import { closePool, getPool } from "./db.ts";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function listMigrations(): Promise<string[]> {
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  return names;
}

// Applies every migration not yet recorded, each in its own transaction, in
// name order. Migrations are written to be safe to run twice, and the record
// in schema_migrations means they normally run once.
export async function migrate(db: Queryable, log: (line: string) => void = () => undefined): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const name of await listMigrations()) {
    if (applied.has(name)) continue;
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw new Error(`Migration ${name} failed and was rolled back: ${(err as Error).message}`);
    }
    ran.push(name);
    log(`applied ${name}`);
  }
  return ran;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = await getPool().connect();
  try {
    const ran = await migrate(client, console.log);
    console.log(ran.length === 0 ? "Database is up to date." : `Applied ${ran.length} migration(s).`);
  } finally {
    client.release();
    await closePool();
  }
}
