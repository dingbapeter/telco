import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { closePool, getPool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { expireQuotes } from "./transfers.ts";

const config = loadConfig();
const db = getPool();

// Migrations run at start so a deploy is a pull and a restart, never a
// separate step someone can forget.
const client = await db.connect();
try {
  const ran = await migrate(client, console.log);
  if (ran.length > 0) console.log(`Applied ${ran.length} migration(s).`);
} finally {
  client.release();
}

const app = buildApp(db, { secureCookies: config.secureCookies });
const server = app.listen(config.port, config.host);
console.log(`Command centre listening on http://${config.host}:${config.port}/admin`);

const timer = setInterval(() => {
  expireQuotes(db).catch((err: unknown) => console.error("expiring quotes failed", err));
}, 60_000);

const shutdown = () => {
  clearInterval(timer);
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
