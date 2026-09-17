import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { closePool, getPool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { railFromEnv } from "./rails/rail.ts";
import { expireQuotes } from "./transfers.ts";
import { expireOrders } from "./orders.ts";
import { runDeliveryCycle, runPayoutCycle } from "./worker.ts";

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

const app = buildApp(db, { secureCookies: config.secureCookies, publicBaseUrl: config.publicBaseUrl });
const server = app.listen(config.port, config.host);
console.log(`Command centre listening on http://${config.host}:${config.port}/admin`);

const timer = setInterval(() => {
  expireQuotes(db).catch((err: unknown) => console.error("expiring quotes failed", err));
  expireOrders(db).catch((err: unknown) => console.error("expiring orders failed", err));
}, 60_000);

// Automatic payouts run only when the provider's keys are in the environment
// and the switch in the command centre is on. One cycle at a time.
const rail = railFromEnv();
console.log(rail ? `Payout provider: ${rail.name}. Automatic payouts follow the command centre setting.` : "No payout provider keys in the environment; payouts are done by hand from the command centre.");
let cycleRunning = false;
const payoutTimer = setInterval(() => {
  if (!rail || cycleRunning) return;
  cycleRunning = true;
  runPayoutCycle(db, rail)
    .then((r) => {
      if (r.sent || r.checked) console.log(`payouts: sent ${r.sent}, checked ${r.checked}, delivered ${r.delivered}, retried ${r.retried}, failed ${r.failed}`);
      return runDeliveryCycle(db, rail);
    })
    .then((r) => {
      if (r.sent || r.checked) console.log(`orders: sent ${r.sent}, checked ${r.checked}, delivered ${r.delivered}, retried ${r.retried}, failed ${r.failed}`);
    })
    .catch((err: unknown) => console.error("payout cycle failed", err))
    .finally(() => {
      cycleRunning = false;
    });
}, 15_000);

const shutdown = () => {
  clearInterval(timer);
  clearInterval(payoutTimer);
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
