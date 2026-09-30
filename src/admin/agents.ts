import type pg from "pg";
import { agentTerms, createAgent, getAgent, listAgents, resetAgentPassword, setAgentTerms, settleWithdrawal, spendable, topUpWallet, walletBalance, type Withdrawal } from "../agents.ts";
import { listApiKeys, revokeApiKey } from "../agentkeys.ts";
import { buildStatement, movementsCsv, purchasesCsv, statementFileName } from "../agentstatement.ts";
import { recentBatches } from "../bulkorders.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { getSettingValues } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request, Response } from "../web/http.ts";
import { actor, csrf, money, nairaField, requiredField, when } from "./shared.ts";

// A rate typed as a percentage, kept as basis points, and an empty box
// meaning "use the rate in Settings" rather than zero.
function percentField(form: URLSearchParams, name: string, label: string): number | null {
  const raw = (form.get(name) ?? "").trim().replace(/%$/, "");
  if (raw === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new UserFacingError("bad_percent", `${label} should be a percentage like 2 or 2.5, or empty to use the rate in Settings.`);
  const [whole, fraction = ""] = raw.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

const percentText = (bp: number | null): string => (bp === null ? "" : (bp / 100).toFixed(2).replace(/\.?0+$/, ""));

async function agentsPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const agents = await listAgents(db);
  const withdrawals = (await db.query<Withdrawal & { name: string; code: string }>("SELECT w.*, a.name, a.code FROM agent_withdrawals w JOIN agents a ON a.id = w.agent_id WHERE w.state = 'requested' ORDER BY w.id")).rows;
  const owed = agents.filter((a) => a.balance_kobo < 0);
  const exposure = owed.reduce((n, a) => n - a.balance_kobo, 0);
  const [creditOn, creditCeiling] = await getSettingValues(db, ["agent.credit_enabled", "agent.credit_max_kobo"] as const);
  const body = html`<h1>Agents</h1>${message ?? ""}
    <p class="muted">Agents bring senders with their link and earn a share of our fee, and buy for customers from a prepaid wallet at a discount. Each wallet is its own account in the ledger. Turn agents on under Settings, Agents.</p>
    <div class="cards"><div class="card"><div class="label">Agents</div><div class="value">${agents.filter((a) => a.active).length}</div></div>
      <div class="card"><div class="label">Money held in wallets</div><div class="value">${money(agents.reduce((n, a) => n + Math.max(0, a.balance_kobo), 0))}</div></div>
      <div class="card"><div class="label">Owed to us on credit</div><div class="value">${money(exposure)}</div></div>
      <div class="card"><div class="label">Credit lines given</div><div class="value">${money(agents.reduce((n, a) => n + a.credit_limit_kobo, 0))}</div></div></div>
    ${creditOn && creditCeiling === 0 ? notice("info", "Credit lines are switched on but the largest one an agent may have is still zero, so no credit can be given. Set it under Settings, Agents.") : ""}
    ${!creditOn && agents.some((a) => a.credit_limit_kobo > 0) ? notice("info", "Credit lines are switched off, so the limits below are not being lent against. Anything already owed stands.") : ""}
    <h2>Withdrawals waiting to be paid (${withdrawals.length})</h2>
    ${withdrawals.length === 0 ? html`<p class="muted">None.</p>` : ""}
    ${withdrawals.map(
      (w) => html`<form method="post" action="/admin/agents/withdrawals/${w.id}" class="panel">${csrf(req)}
        <strong>${money(w.amount_kobo)}</strong> to ${w.name} (${w.code}), requested ${when(w.requested_at)}. Pay to: ${w.bank_details}
        <div class="row"><div><label for="ref-${w.id}">Bank reference once sent</label><input id="ref-${w.id}" name="reference" type="text"></div>
        <div><label>&nbsp;</label><button type="submit" name="outcome" value="paid">Paid</button> <button type="submit" name="outcome" value="declined" class="danger">Decline</button></div></div></form>`,
    )}
    <h2>All agents</h2>
    <div class="scroll"><table><tr><th>Code</th><th>Name</th><th>Phone</th><th class="num">Wallet</th><th class="num">Discount</th><th class="num">Credit line</th><th>Active</th><th>Since</th><th></th></tr>
      ${agents.map((a) => html`<tr><td><a href="/admin/agents/${a.id}">${a.code}</a></td><td>${a.name}</td><td>${a.phone}</td><td class="num">${money(a.balance_kobo)}</td>
        <td class="num">${a.discount_basis_points === null ? html`<span class="muted">default</span>` : `${percentText(a.discount_basis_points)}%`}</td>
        <td class="num">${a.credit_limit_kobo > 0 ? money(a.credit_limit_kobo) : ""}</td>
        <td>${a.active ? "yes" : "no"}</td><td>${when(a.created_at)}</td>
        <td><form method="post" action="/admin/agents/${a.id}/toggle" class="inline">${csrf(req)}<button type="submit" class="secondary">${a.active ? "Pause" : "Activate"}</button></form></td></tr>`)}
      ${agents.length === 0 ? html`<tr><td colspan="9" class="muted">No agents yet.</td></tr>` : ""}
    </table></div>
    <h2>Add an agent</h2>
    <form method="post" action="/admin/agents" class="panel">${csrf(req)}
      <div class="row"><div><label for="name">Name</label><input id="name" name="name" type="text" required></div><div><label for="phone">Phone, their login</label><input id="phone" name="phone" type="text" inputmode="tel" required></div></div>
      <label for="email">Email <span class="hint">optional, for payment receipts</span></label><input id="email" name="email" type="email">
      <button type="submit">Create agent and show their first password</button></form>`;
  return { kind: "html", status, body: page({ title: "Agents", admin: req.admin, current: "/admin/agents", body }) };
}

async function agentPage(req: Request, db: pg.Pool, id: number, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const a = await getAgent(db, id);
  if (!a) throw new UserFacingError("no_such_agent", "There is no agent with that id.");
  const have = await walletBalance(db, id);
  const terms = await agentTerms(db, id);
  const room = await spendable(db, id);
  const keys = await listApiKeys(db, id);
  const batches = await recentBatches(db, id, 5);
  const [globalDiscount, globalCommission, creditCeiling] = await getSettingValues(db, ["agent.discount_basis_points", "agent.commission_basis_points", "agent.credit_max_kobo"] as const);
  const transfers = (await db.query<{ reference: string; id: number; state: string; received_kobo: number | null; agent_commission_kobo: number | null; created_at: Date }>("SELECT id, reference, state, received_kobo, agent_commission_kobo, created_at FROM transfers WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 30", [id])).rows;
  const orders = (await db.query<{ id: number; reference: string; state: string; price_kobo: number; payment_method: string | null; created_at: Date }>("SELECT id, reference, state, price_kobo, payment_method, created_at FROM orders WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 30", [id])).rows;
  const journal = (await db.query<{ posted_at: Date; description: string; amount_kobo: number }>("SELECT j.posted_at, j.description, -p.amount_kobo AS amount_kobo FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id WHERE p.account_code = $1 ORDER BY j.id DESC LIMIT 50", [`agent:${id}`])).rows;
  const body = html`<h1>${a.name} <span class="state">${a.code}</span></h1>${message ?? ""}
    <dl><dt>Phone</dt><dd>${a.phone}</dd><dt>Email</dt><dd>${a.email ?? ""}</dd><dt>Wallet</dt><dd><strong>${money(have)}</strong></dd>
      <dt>Free for them to spend</dt><dd>${money(room.freeKobo)}</dd>
      ${room.owedKobo > 0 ? html`<dt>Owed to us</dt><dd><strong>${money(room.owedKobo)}</strong>${room.owingSince ? ` since ${when(room.owingSince)}` : ""}</dd>` : ""}
      <dt>Link</dt><dd>/a/${a.code}</dd></dl>
    ${room.creditClosed ? notice("info", `Their credit line is closed at the moment. They are told: ${room.creditClosed}`) : ""}
    <h2>What this agent buys at</h2>
    <form method="post" action="/admin/agents/${a.id}/terms" class="panel">${csrf(req)}
      <p>Leave a rate empty to use the rate in Settings, which is ${percentText(globalDiscount)}% off purchases and ${percentText(globalCommission)}% of our fee. A rate here is the deal you signed with this agent alone, and it is written to the audit log.</p>
      <div class="row">
        <div><label for="discount">Discount on purchases, percent</label><input id="discount" name="discount" type="text" inputmode="decimal" value="${percentText(a.discount_basis_points)}" placeholder="${percentText(globalDiscount)}"></div>
        <div><label for="commission">Share of our fee, percent</label><input id="commission" name="commission" type="text" inputmode="decimal" value="${percentText(a.commission_basis_points)}" placeholder="${percentText(globalCommission)}"></div>
        <div><label for="credit">Credit line, naira</label><input id="credit" name="credit" type="text" inputmode="decimal" value="${a.credit_limit_kobo === 0 ? "" : (a.credit_limit_kobo / 100).toFixed(2).replace(/\.?0+$/, "")}" placeholder="0"></div>
      </div>
      <p class="muted">A credit line lets them buy up to that much beyond what their wallet holds. ${creditCeiling === 0 ? "No credit line can be given until you set the largest one an agent may have, under Settings, Agents." : `The most you can give one agent is ${formatNaira(creditCeiling)}. They must clear what they owe within ${terms.creditDays} days or the line closes itself.`}</p>
      <button type="submit">Save this agent's terms</button></form>
    <h2>Statement</h2>
    <form method="get" action="/admin/agents/${a.id}/statement" class="panel">
      <div class="row"><div><label for="from">From</label><input id="from" name="from" type="date"></div>
        <div><label for="to">To</label><input id="to" name="to" type="date"></div>
        <div><label for="what">What</label><select id="what" name="what"><option value="movements">Wallet movements</option><option value="purchases">Purchases</option></select></div></div>
      <p class="muted">Leave the dates empty for this month so far. The file opens in any spreadsheet.</p>
      <button type="submit" class="secondary">Download the statement</button></form>
    <form method="post" action="/admin/agents/${a.id}/topup" class="panel">${csrf(req)}
      <p><strong>Bank transfer received from this agent?</strong> Record it and it goes into their wallet.</p>
      <div class="row"><div><label for="amt">Amount received, naira</label><input id="amt" name="amount" type="text" inputmode="decimal" required></div><div><label for="ref">Bank reference or narration</label><input id="ref" name="reference" type="text" required></div></div>
      <button type="submit">Add to wallet</button></form>
    <form method="post" action="/admin/agents/${a.id}/reset" class="panel">${csrf(req)}<p>Give the agent a new password if they have lost theirs. It is shown once.</p><button type="submit" class="secondary">Reset password</button></form>
    <h2>Wallet movements</h2>
    <div class="scroll"><table><tr><th>When</th><th>Entry</th><th class="num">Change</th></tr>${journal.map((j) => html`<tr><td>${when(j.posted_at)}</td><td>${j.description}</td><td class="num">${money(j.amount_kobo)}</td></tr>`)}${journal.length === 0 ? html`<tr><td colspan="3" class="muted">Nothing yet.</td></tr>` : ""}</table></div>
    <h2>Transfers brought</h2>
    <div class="scroll"><table><tr><th>Reference</th><th>State</th><th class="num">Moved</th><th class="num">Commission</th><th>When</th></tr>${transfers.map((t) => html`<tr><td><a href="/admin/transfers/${t.id}">${t.reference}</a></td><td>${t.state.replaceAll("_", " ")}</td><td class="num">${money(t.received_kobo)}</td><td class="num">${money(t.agent_commission_kobo)}</td><td>${when(t.created_at)}</td></tr>`)}${transfers.length === 0 ? html`<tr><td colspan="5" class="muted">None yet.</td></tr>` : ""}</table></div>
    <h2>Purchases</h2>
    <div class="scroll"><table><tr><th>Reference</th><th>State</th><th class="num">Paid</th><th>How</th><th>When</th></tr>${orders.map((o) => html`<tr><td><a href="/admin/orders/${o.id}">${o.reference}</a></td><td>${o.state.replaceAll("_", " ")}</td><td class="num">${money(o.price_kobo)}</td><td>${o.payment_method ?? ""}</td><td>${when(o.created_at)}</td></tr>`)}${orders.length === 0 ? html`<tr><td colspan="5" class="muted">None yet.</td></tr>` : ""}</table></div>
    <h2>Lists bought in one go</h2>
    <div class="scroll"><table><tr><th>List</th><th class="num">Lines</th><th class="num">Paid</th><th class="num">Delivered</th><th class="num">Needs a look</th><th>When</th></tr>${batches.map((b) => html`<tr><td>${b.reference}</td><td class="num">${b.lines}</td><td class="num">${money(b.total_kobo)}</td><td class="num">${b.delivered}</td><td class="num">${b.failed}</td><td>${when(b.created_at)}</td></tr>`)}${batches.length === 0 ? html`<tr><td colspan="6" class="muted">None yet.</td></tr>` : ""}</table></div>
    <h2>Keys their own software uses</h2>
    <p class="muted">Made by the agent in their portal. We keep only a fingerprint of each key, so none of them can be read here. Revoke one if a machine is lost.</p>
    <div class="scroll"><table><tr><th>Name</th><th>Key id</th><th>Made</th><th>By</th><th>Last used</th><th>State</th><th></th></tr>
      ${keys.map((k) => html`<tr><td>${k.label}</td><td>${k.key_id}</td><td>${when(k.created_at)}</td><td>${k.created_by}</td><td>${k.last_used_at ? when(k.last_used_at) : "never"}</td><td>${k.active ? "in use" : "revoked"}</td>
        <td>${k.active ? html`<form method="post" action="/admin/agents/${a.id}/keys/${k.id}/revoke" class="inline">${csrf(req)}<button type="submit" class="danger">Revoke</button></form>` : ""}</td></tr>`)}
      ${keys.length === 0 ? html`<tr><td colspan="7" class="muted">None made.</td></tr>` : ""}</table></div>`;
  return { kind: "html", status, body: page({ title: a.name, admin: req.admin, current: "/admin/agents", body }) };
}

export function registerAgentsAdmin(app: App): void {
  app.get("/admin/agents", (req, db) => agentsPage(req, db));
  app.get("/admin/agents/:id", (req, db) => agentPage(req, db, Number(req.query.get("id"))));

  app.post("/admin/agents", async (req, db) => {
    try {
      const { agent, password } = await withActor(actor(req.admin), (c) => createAgent(c, { name: req.form.get("name") ?? "", phone: req.form.get("phone") ?? "", email: req.form.get("email") ?? undefined }), db);
      return agentsPage(req, db, notice("ok", html`<p><strong>${agent.name}</strong> is agent <strong>${agent.code}</strong>. Their link is /a/${agent.code}. Give them this first password to log in at /agent/login with their phone number; it is shown once and they should change it:</p><p><code>${password}</code></p>`));
    } catch (err) {
      if (err instanceof UserFacingError) return agentsPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/agents/:id/toggle", async (req, db) => {
    const { rows } = await withActor(actor(req.admin), (c) => c.query<{ active: boolean; name: string }>("UPDATE agents SET active = NOT active WHERE id = $1 RETURNING active, name", [Number(req.query.get("id"))]), db);
    if (!rows[0]) return agentsPage(req, db, notice("problem", "That agent is not in the list."), 404);
    return agentsPage(req, db, notice("ok", `${rows[0].name} is now ${rows[0].active ? "active" : "paused"}.`));
  });

  app.post("/admin/agents/:id/topup", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const amount = nairaField(req.form, "amount", "Amount received");
      const reference = requiredField(req.form, "reference", "Bank reference");
      const r = await withActor(actor(req.admin), (c) => topUpWallet(c, id, { reference, paidKobo: amount, feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" }), db);
      return agentPage(req, db, id, r.posted ? notice("ok", `${money(amount)} added to the wallet.`) : notice("info", "A top-up with that reference was already recorded, so nothing was added twice."));
    } catch (err) {
      if (err instanceof UserFacingError) return agentPage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/agents/:id/terms", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const credit = (req.form.get("credit") ?? "").trim();
      const creditKobo = credit === "" ? 0 : parseNaira(credit);
      if (creditKobo === undefined) throw new UserFacingError("bad_amount", "The credit line should be an amount in naira, like 50000, or empty for none.");
      const input = {
        discountBasisPoints: percentField(req.form, "discount", "The discount on purchases"),
        commissionBasisPoints: percentField(req.form, "commission", "The share of our fee"),
        creditLimitKobo: creditKobo,
      };
      const saved = await withActor(actor(req.admin), (c) => setAgentTerms(c, id, input), db);
      return agentPage(
        req,
        db,
        id,
        notice(
          "ok",
          `Saved. ${saved.name} buys at ${saved.discount_basis_points === null ? "the rate in Settings" : `${percentText(saved.discount_basis_points)}% below face value`}, earns ${saved.commission_basis_points === null ? "the share in Settings" : `${percentText(saved.commission_basis_points)}% of our fee`}, and has ${saved.credit_limit_kobo === 0 ? "no credit line" : `a credit line of ${money(saved.credit_limit_kobo)}`}.`,
        ),
      );
    } catch (err) {
      if (err instanceof UserFacingError) return agentPage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.get("/admin/agents/:id/statement", async (req, db): Promise<Response> => {
    const id = Number(req.query.get("id"));
    const a = await getAgent(db, id);
    if (!a) throw new UserFacingError("no_such_agent", "There is no agent with that id.");
    const what = req.query.get("what") === "purchases" ? "purchases" : "movements";
    try {
      const statement = await buildStatement(db, a, { from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined });
      return {
        kind: "text",
        body: what === "purchases" ? purchasesCsv(statement) : movementsCsv(statement),
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="${statementFileName(statement, what)}"` },
      };
    } catch (err) {
      if (err instanceof UserFacingError) return agentPage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/agents/:id/keys/:key/revoke", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const key = await withActor(actor(req.admin), (c) => revokeApiKey(c, id, Number(req.query.get("key"))), db);
      return agentPage(req, db, id, notice("ok", `The key ${key.key_id} for ${key.label} is revoked. Anything still using it will be refused.`));
    } catch (err) {
      if (err instanceof UserFacingError) return agentPage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/agents/:id/reset", async (req, db) => {
    const id = Number(req.query.get("id"));
    const password = await withActor(actor(req.admin), (c) => resetAgentPassword(c, id), db);
    return agentPage(req, db, id, notice("ok", html`New password, shown once: <code>${password}</code>. The agent is logged out everywhere.`));
  });

  app.post("/admin/agents/withdrawals/:id", async (req, db) => {
    try {
      const outcome = req.form.get("outcome") === "paid" ? "paid" : "declined";
      const reference = outcome === "paid" ? requiredField(req.form, "reference", "Bank reference") : (req.form.get("reference") ?? "");
      const w = await withActor(actor(req.admin), (c) => settleWithdrawal(c, actor(req.admin), Number(req.query.get("id")), outcome, reference), db);
      return agentsPage(req, db, notice("ok", outcome === "paid" ? `Recorded ${money(w.amount_kobo)} paid to the agent.` : "Declined. The money stays in the agent's wallet."));
    } catch (err) {
      if (err instanceof UserFacingError) return agentsPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });
}
