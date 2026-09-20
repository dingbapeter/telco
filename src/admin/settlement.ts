import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { balance, lockAccount, postJournal } from "../ledger.ts";
import { getSettingValue, NETWORK_CODES } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, requiredField } from "./shared.ts";

// The statement a network's finance team will ask for: what left their
// network through us, the fees, their share, and what we have paid them.
async function settlementPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const shares = await getSettingValue(db, "fee.network_share_basis_points");
  const months = (
    await db.query<{ network: string; month: string; transfers: number; volume: number; fees: number; share: number }>(
      `SELECT from_network AS network, to_char(date_trunc('month', paid_out_at AT TIME ZONE 'Africa/Lagos'), 'YYYY-MM') AS month,
              count(*)::int AS transfers, sum(received_kobo)::bigint AS volume, sum(fee_kobo)::bigint AS fees, sum(network_share_kobo)::bigint AS share
       FROM transfers WHERE state = 'completed' GROUP BY 1, 2 ORDER BY 1, 2 DESC`,
    )
  ).rows;
  const paid = (
    await db.query<{ network: string; paid: number }>(
      `SELECT substring(p.account_code from 6) AS network, coalesce(sum(p.amount_kobo), 0)::bigint AS paid
       FROM ledger_postings p WHERE p.account_code LIKE 'owed:%' AND p.account_code <> 'owed:senders' AND p.account_code <> 'owed:buyers' AND p.amount_kobo > 0 GROUP BY 1`,
    )
  ).rows;
  const sections: Html[] = [];
  for (const c of NETWORK_CODES) {
    const owed = await balance(db, `owed:${c}`);
    const rows = months.filter((m) => m.network === c);
    const paidTotal = paid.find((p) => p.network === c)?.paid ?? 0;
    sections.push(html`<h2>${c}</h2>
      <div class="cards">
        <div class="card"><div class="label">Share of fee</div><div class="value">${(shares[c] / 100).toFixed(2)} percent</div>${shares[c] === 0 ? html`<span class="muted">no agreement yet</span>` : ""}</div>
        <div class="card"><div class="label">Accrued, all time</div><div class="value">${money(rows.reduce((s, m) => s + m.share, 0))}</div></div>
        <div class="card"><div class="label">Paid to ${c}</div><div class="value">${money(paidTotal)}</div></div>
        <div class="card ${owed > 0 ? "bad" : "ok"}"><div class="label">Owed now</div><div class="value">${money(owed)}</div></div>
      </div>
      <div class="scroll"><table><tr><th>Month</th><th class="num">Transfers out of ${c}</th><th class="num">Airtime moved</th><th class="num">Fees</th><th class="num">${c}'s share</th></tr>
        ${rows.map((m) => html`<tr><td>${m.month}</td><td class="num">${m.transfers}</td><td class="num">${money(m.volume)}</td><td class="num">${money(m.fees)}</td><td class="num">${money(m.share)}</td></tr>`)}
        ${rows.length === 0 ? html`<tr><td colspan="5" class="muted">No completed transfers out of ${c} yet.</td></tr>` : ""}
      </table></div>`);
  }
  const body = html`<h1>Network settlement</h1>${message ?? ""}
    <p class="muted">Every figure is read from the ledger as the page opens. A network's share accrues on each completed transfer out of that network at the percentage set under Settings, Fees. Zero until the network signs.</p>
    ${sections}
    <h2>Record a payment to a network</h2>
    <form method="post" action="/admin/settlement/pay" class="panel">${csrf(req)}
      <div class="row"><div><label for="net">Network</label><select id="net" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
      <div><label for="amt">Amount paid, naira</label><input id="amt" name="amount" type="text" inputmode="decimal" required></div></div>
      <label for="ref">Bank reference</label><input id="ref" name="reference" type="text" required>
      <button type="submit">Record payment</button></form>`;
  return { kind: "html", status, body: page({ title: "Network settlement", admin: req.admin, current: "/admin/settlement", body }) };
}

export function registerSettlement(app: App): void {
  app.get("/admin/settlement", (req, db) => settlementPage(req, db));
  app.post("/admin/settlement/pay", async (req, db) => {
    try {
      const network = requiredField(req.form, "network", "Network");
      if (!(NETWORK_CODES as readonly string[]).includes(network)) throw new UserFacingError("unknown_network", "Choose a network.");
      const amount = nairaField(req.form, "amount", "Amount paid");
      const reference = requiredField(req.form, "reference", "Bank reference");
      const r = await withActor(actor(req.admin), async (c) => {
        // Read what is owed under the same lock that the posting takes, so
        // two people pressing Pay at the same moment cannot each see the
        // whole amount and between them pay the network twice.
        await lockAccount(c, `owed:${network}`);
        const owed = await balance(c, `owed:${network}`);
        if (amount > owed) throw new UserFacingError("overpaid", `${money(amount)} is more than the ${money(owed)} owed to ${network}. Nothing was recorded.`);
        return postJournal(c, {
          // The key names the payment itself, not a number the form carried,
          // so the same bank reference cannot be recorded twice under two
          // different keys.
          idempotencyKey: `settlement:${network}:${reference.trim().toLowerCase()}`,
          description: `Settlement paid to ${network}, bank reference ${reference}`,
          reference,
          postings: [
            { account: `owed:${network}`, amountKobo: amount },
            { account: "cash:bank", amountKobo: -amount },
          ],
        });
      }, db);
      return settlementPage(req, db, r.posted ? notice("ok", `Recorded ${money(amount)} paid to ${network}.`) : notice("info", "That payment was already recorded."));
    } catch (err) {
      if (err instanceof UserFacingError) return settlementPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });
}
