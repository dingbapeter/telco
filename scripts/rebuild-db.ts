// Rebuilds a database from nothing using only the migration history, so a
// fresh server can be brought up on demand. Never drops anything: it applies
// whatever is missing. Point DATABASE_URL at an empty database to prove the
// history still builds.
import { closePool, getPool } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";

const client = await getPool().connect();
try {
  const ran = await migrate(client, console.log);
  console.log(ran.length === 0 ? "Nothing to apply; the database already matches the migration history." : `Applied ${ran.length} migration(s).`);
} finally {
  client.release();
  await closePool();
}
