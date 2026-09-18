import type pg from "pg";
import { registerAgentsAdmin } from "./admin/agents.ts";
import { registerAudit } from "./admin/audit.ts";
import { registerBridgeAdmin } from "./admin/bridge.ts";
import { registerBundles } from "./admin/bundles.ts";
import { registerChecklist } from "./admin/checklist.ts";
import { registerInbound } from "./admin/inbound.ts";
import { registerLogin } from "./admin/login.ts";
import { registerNumbers } from "./admin/numbers.ts";
import { registerOrders } from "./admin/orders.ts";
import { registerOverview } from "./admin/overview.ts";
import { registerSettlement } from "./admin/settlement.ts";
import { registerPools } from "./admin/pools.ts";
import { registerSettings } from "./admin/settings.ts";
import { registerTransfers } from "./admin/transfers.ts";
import { registerAgentPortal } from "./agent/portal.ts";
import { paystackFromEnv, type PaystackProvider } from "./payments/paystack.ts";
import { registerBuy } from "./public/buy.ts";
import { registerPublic } from "./public/pages.ts";
import { registerBridge } from "./web/bridge.ts";
import { App } from "./web/http.ts";

export function buildApp(db: pg.Pool, options: { secureCookies: boolean; publicBaseUrl?: string; paystack?: PaystackProvider | undefined }): App {
  const app = new App(db);
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
  registerBridgeAdmin(app);
  registerBundles(app);
  registerAudit(app);
  registerBridge(app);
  registerOrders(app);
  registerSettlement(app);
  registerPublic(app);
  const paystack = options.paystack ?? paystackFromEnv();
  const publicBaseUrl = options.publicBaseUrl ?? "http://localhost:3000";
  registerBuy(app, { paystack, publicBaseUrl });
  registerAgentsAdmin(app);
  registerAgentPortal(app, { paystack, publicBaseUrl, secureCookies: options.secureCookies });
  return app;
}
