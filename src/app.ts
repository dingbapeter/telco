import type pg from "pg";
import { registerAudit } from "./admin/audit.ts";
import { registerChecklist } from "./admin/checklist.ts";
import { registerInbound } from "./admin/inbound.ts";
import { registerLogin } from "./admin/login.ts";
import { registerNumbers } from "./admin/numbers.ts";
import { registerOverview } from "./admin/overview.ts";
import { registerPools } from "./admin/pools.ts";
import { registerSettings } from "./admin/settings.ts";
import { registerTransfers } from "./admin/transfers.ts";
import { App } from "./web/http.ts";

export function buildApp(db: pg.Pool, options: { secureCookies: boolean }): App {
  const app = new App(db);
  app.get("/", async () => ({ kind: "redirect", to: "/admin" }), false);
  app.get("/health", async (_req, pool) => {
    // Knocks on the database rather than reporting that a connection string exists.
    await pool.query("SELECT 1");
    return { kind: "json", body: { ok: true } };
  }, false);
  registerLogin(app, options.secureCookies);
  registerOverview(app);
  registerTransfers(app);
  registerInbound(app);
  registerPools(app);
  registerNumbers(app);
  registerSettings(app);
  registerChecklist(app);
  registerAudit(app);
  return app;
}
