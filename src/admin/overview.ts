import type pg from "pg";
import { balances } from "../ledger.ts";
import { getSettingValue, NETWORK_CODES } from "../settings.ts";
import { html, page } from "../web/html.ts";
import type { App } from "../web/http.ts";
import { money, stateBadge, when } from "./shared.ts";

const START_OF_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

// Every number on this page is a query run when the page is opened.
export async function liveNumbers(db: pg.Pool) {
  const [ledger, today, states, unmatched, floors] = await Promise.all([
    balances(db),
    db.query<{ transfers: number; volume: number; fees: number }>(
      `SELECT count(*) FILTER (WHERE state = 'completed')::int AS transfers,
              coalesce(sum(received_kobo) FILTER (WHERE state = 'completed'), 0)::bigint AS volume,
              coalesce(sum(platform_share_kobo) FILTER (WHERE state = 'completed'), 0)::bigint AS fees
       FROM transfers WHERE created_at >= ${START_OF_TODAY}`,
    ),
    db.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM transfers GROUP BY state"),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM inbound_notifications WHERE matched_transfer_id IS NULL"),
    getSettingValue(db, "pool.floor_kobo"),
  ]);
  const byCode = Object.fromEntries(ledger.map((a) => [a.code, a.balanceKobo]));
  const stateCount = Object.fromEntries(states.rows.map((r) => [r.state, r.n]));
  return {
    pools: NETWORK_CODES.map((c) => ({ network: c, balanceKobo: byCode[`pool:${c}`] ?? 0, floorKobo: floors[c] })),
    owedToSenders: byCode["owed:senders"] ?? 0,
    owedToNetworks: NETWORK_CODES.map((c) => ({ network: c, kobo: byCode[`owed:${c}`] ?? 0 })),
    revenueAllTime: byCode["revenue:fees"] ?? 0,
    today: today.rows[0]!,
    needsAPerson: (stateCount["held"] ?? 0) + (stateCount["awaiting_approval"] ?? 0) + (stateCount["payout_failed"] ?? 0),
    inFlight: (stateCount["inbound_confirmed"] ?? 0) + (stateCount["paying_out"] ?? 0) + (stateCount["refunding"] ?? 0),
    waitingForAirtime: stateCount["awaiting_inbound"] ?? 0,
    unmatched: unmatched.rows[0]!.n,
    stateCount,
  };
}

export function registerOverview(app: App): void {
  app.get("/admin", async (req, db) => {
    const n = await liveNumbers(db);
    const recent = await db.query<{ id: number; reference: string; state: string; from_network: string; to_network: string; received_kobo: number | null; requested_kobo: number; created_at: Date }>(
      "SELECT id, reference, state, from_network, to_network, received_kobo, requested_kobo, created_at FROM transfers ORDER BY created_at DESC LIMIT 10",
    );
    const body = html`<h1>Overview</h1>
      <p class="muted">Every figure here is read from the database as the page opens. Times are Lagos time.</p>
      <div class="cards">
        <div class="card ${n.needsAPerson > 0 ? "bad" : "ok"}"><div class="label">Needs a person</div><div class="value">${n.needsAPerson}</div><a href="/admin/transfers?needs=person">Held, failed or awaiting approval</a></div>
        <div class="card ${n.unmatched > 0 ? "bad" : ""}"><div class="label">Airtime in, unmatched</div><div class="value">${n.unmatched}</div><a href="/admin/inbound">Look at them</a></div>
        <div class="card"><div class="label">Waiting for airtime</div><div class="value">${n.waitingForAirtime}</div></div>
        <div class="card"><div class="label">In flight</div><div class="value">${n.inFlight}</div></div>
        <div class="card"><div class="label">Completed today</div><div class="value">${n.today.transfers}</div></div>
        <div class="card"><div class="label">Moved today</div><div class="value">${money(n.today.volume)}</div></div>
        <div class="card"><div class="label">Our fees today</div><div class="value">${money(n.today.fees)}</div></div>
        <div class="card"><div class="label">Our fees, all time</div><div class="value">${money(n.revenueAllTime)}</div></div>
        <div class="card ${n.owedToSenders > 0 ? "" : "ok"}"><div class="label">Owed to senders right now</div><div class="value">${money(n.owedToSenders)}</div></div>
      </div>
      <h2>Pools</h2>
      <div class="cards">
        ${n.pools.map(
          (p) => html`<div class="card ${p.floorKobo > 0 && p.balanceKobo < p.floorKobo ? "bad" : ""}">
            <div class="label">${p.network} pool</div><div class="value">${money(p.balanceKobo)}</div>
            ${p.floorKobo > 0 ? html`<span class="muted">warns below ${money(p.floorKobo)}</span>` : html`<span class="muted">no warning level set</span>`}
          </div>`,
        )}
      </div>
      <h2>Owed to networks</h2>
      <div class="cards">${n.owedToNetworks.map((o) => html`<div class="card"><div class="label">${o.network}</div><div class="value">${money(o.kobo)}</div></div>`)}</div>
      <h2>Latest transfers</h2>
      <div class="scroll"><table>
        <tr><th>Reference</th><th>Route</th><th class="num">Amount</th><th>State</th><th>Created</th></tr>
        ${recent.rows.map(
          (t) => html`<tr>
            <td><a href="/admin/transfers/${t.id}">${t.reference}</a></td>
            <td>${t.from_network} to ${t.to_network}</td>
            <td class="num">${money(t.received_kobo ?? t.requested_kobo)}</td>
            <td>${stateBadge(t.state)}</td><td>${when(t.created_at)}</td>
          </tr>`,
        )}
        ${recent.rows.length === 0 ? html`<tr><td colspan="5" class="muted">No transfers yet.</td></tr>` : ""}
      </table></div>`;
    return { kind: "html", body: page({ title: "Overview", admin: req.admin, current: "/admin", body }) };
  });
}
