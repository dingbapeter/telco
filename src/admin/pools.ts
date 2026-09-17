import { randomBytes } from "node:crypto";
import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { balances, postJournal } from "../ledger.ts";
import { NETWORK_CODES } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, requiredField, when } from "./shared.ts";

// Where value can be put in or lost from: a pool of airtime on each
// network's SIM, or money held with the provider.
const FUNDABLE = [
  ...NETWORK_CODES.map((c) => ({ code: `pool:${c}`, label: `${c} pool (airtime on our ${c} SIM)` })),
  { code: "wallet:vtpass", label: "Provider wallet (money with VTpass)" },
];

async function poolsPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const [all, journals] = await Promise.all([
    balances(db),
    db.query<{ id: number; posted_at: Date; description: string; reference: string | null }>(
      "SELECT id, posted_at, description, reference FROM ledger_journals ORDER BY id DESC LIMIT 30",
    ),
  ]);
  const byCode = Object.fromEntries(all.map((a) => [a.code, a]));
  // A fresh key per form render makes a double submit book once.
  const key = randomBytes(8).toString("hex");
  const body = html`<h1>Pools</h1>
    ${message ?? ""}
    <p class="muted">A pool is the airtime we hold on a network, according to our own ledger. It should match the balance on that network's SIM. When it does not, record the difference below so the ledger stays true.</p>
    <div class="cards">${NETWORK_CODES.map((c) => html`<div class="card"><div class="label">${c} pool</div><div class="value">${money(byCode[`pool:${c}`]?.balanceKobo ?? 0)}</div></div>`)}</div>
    <h2>All accounts</h2>
    <table><tr><th>Account</th><th>Kind</th><th class="num">Balance</th></tr>
      ${all.map((a) => html`<tr><td>${a.name}<br><code>${a.code}</code></td><td>${a.kind}</td><td class="num">${money(a.balanceKobo)}</td></tr>`)}
    </table>
    <h2>Record airtime or money you put in</h2>
    <p class="muted">Airtime bought onto a SIM goes into that network's pool. Money paid into the provider's wallet goes into the provider wallet.</p>
    <form method="post" action="/admin/pools/fund" class="panel">${csrf(req)}
      <input type="hidden" name="key" value="${key}">
      <div class="row">
        <div><label for="fnet">Into</label><select id="fnet" name="account">${FUNDABLE.map((a) => html`<option value="${a.code}">${a.label}</option>`)}</select></div>
        <div><label for="famt">Amount in naira</label><input id="famt" name="amount" type="text" inputmode="decimal" required></div>
      </div>
      <label for="fnote">Where it came from <span class="hint">for example "bought from the top-up provider, receipt 1234"</span></label><input id="fnote" name="note" type="text" required>
      <button type="submit">Record float added</button>
    </form>
    <h2>Record airtime lost</h2>
    <form method="post" action="/admin/pools/loss" class="panel">${csrf(req)}
      <input type="hidden" name="key" value="${key}">
      <div class="row">
        <div><label for="lnet">From</label><select id="lnet" name="account">${FUNDABLE.map((a) => html`<option value="${a.code}">${a.label}</option>`)}</select></div>
        <div><label for="lamt">Amount in naira</label><input id="lamt" name="amount" type="text" inputmode="decimal" required></div>
      </div>
      <label for="lnote">What happened <span class="hint">for example "SIM barred by the network with N1,200 on it"</span></label><input id="lnote" name="note" type="text" required>
      <button type="submit" class="danger">Record loss</button>
    </form>
    <h2>Latest ledger entries</h2>
    <table><tr><th>When</th><th>Entry</th><th>Reference</th></tr>
      ${journals.rows.map((j) => html`<tr><td>${when(j.posted_at)}</td><td>${j.description}</td><td>${j.reference ?? ""}</td></tr>`)}
      ${journals.rows.length === 0 ? html`<tr><td colspan="3" class="muted">Nothing yet.</td></tr>` : ""}
    </table>`;
  return { kind: "html", status, body: page({ title: "Pools", admin: req.admin, current: "/admin/pools", body }) };
}

export function registerPools(app: App): void {
  app.get("/admin/pools", (req, db) => poolsPage(req, db));

  const record = (path: string, kind: "fund" | "loss") =>
    app.post(`/admin/pools/${path}`, async (req, db) => {
      try {
        const account = requiredField(req.form, "account", "Where");
        const chosen = FUNDABLE.find((a) => a.code === account);
        if (!chosen) throw new UserFacingError("unknown_account", "Choose a pool or the provider wallet.");
        const amount = nairaField(req.form, "amount", "Amount");
        if (amount <= 0) throw new UserFacingError("bad_amount", "The amount must be more than zero.");
        const note = requiredField(req.form, "note", kind === "fund" ? "Where it came from" : "What happened");
        const key = requiredField(req.form, "key", "Form key");
        const result = await withActor(actor(req.admin), (c) =>
          postJournal(c, {
            idempotencyKey: `admin:${kind}:${key}`,
            description: kind === "fund" ? `Added to ${chosen.label} by ${actor(req.admin)}: ${note}` : `Loss from ${chosen.label} recorded by ${actor(req.admin)}: ${note}`,
            postings:
              kind === "fund"
                ? [{ account, amountKobo: amount }, { account: "equity:float", amountKobo: -amount }]
                : [{ account: "expense:losses", amountKobo: amount }, { account, amountKobo: -amount }],
          }),
          db,
        );
        return poolsPage(req, db, result.posted ? notice("ok", `Recorded ${money(amount)} ${kind === "fund" ? "added to" : "lost from"} the ${chosen.label}.`) : notice("info", "That entry was already recorded, so it was not booked twice."));
      } catch (err) {
        if (err instanceof UserFacingError) return poolsPage(req, db, notice("problem", err.message), 400);
        throw err;
      }
    });
  record("fund", "fund");
  record("loss", "loss");
}
