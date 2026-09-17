import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { getSettingValue } from "../settings.ts";
import {
  approvePayout,
  completePayout,
  completeRefund,
  failPayout,
  getTransfer,
  getTransferByReference,
  releaseHold,
  startPayout,
  startRefund,
  type Transfer,
} from "../transfers.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, pager, requiredField, stateBadge, when } from "./shared.ts";

const PAGE = 50;

const NEEDS_PERSON = ["held", "awaiting_approval", "payout_failed"];

async function listPage(req: Request, db: pg.Pool): Promise<string> {
  const pageNo = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
  const needs = req.query.get("needs") === "person";
  const state = req.query.get("state");
  const reference = (req.query.get("q") ?? "").trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (needs) where.push(`state = ANY($${params.push(NEEDS_PERSON)})`);
  if (state) where.push(`state = $${params.push(state)}`);
  if (reference) where.push(`(reference ILIKE $${params.push("%" + reference + "%")} OR sender_number LIKE $${params.push("%" + reference.replace(/\D/g, "") + "%")})`);
  params.push(PAGE + 1, (pageNo - 1) * PAGE);
  const rows = (
    await db.query<Transfer>(
      `SELECT * FROM transfers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
  ).rows;
  const hasMore = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const base = `/admin/transfers?${needs ? "needs=person&" : ""}${state ? `state=${state}&` : ""}${reference ? `q=${encodeURIComponent(reference)}&` : ""}`;
  const body = html`<h1>Transfers</h1>
    <form method="get" action="/admin/transfers" class="panel row">
      <div><label for="q">Reference or sender number</label><input id="q" name="q" type="text" value="${reference}"></div>
      <div><label for="state">State</label>
        <select id="state" name="state">
          <option value="">Any</option>
          ${["awaiting_inbound", "expired", "inbound_confirmed", "awaiting_approval", "paying_out", "completed", "payout_failed", "held", "refunding", "refunded"].map(
            (s) => html`<option value="${s}" ${s === state ? "selected" : ""}>${s.replaceAll("_", " ")}</option>`,
          )}
        </select></div>
      <div><label>&nbsp;</label><button type="submit">Find</button> <a href="/admin/transfers?needs=person">Needs a person</a></div>
    </form>
    <div class="scroll"><table>
      <tr><th>Reference</th><th>Route</th><th>Sender</th><th>Recipient</th><th class="num">Received</th><th class="num">Payout</th><th>State</th><th>Created</th></tr>
      ${shown.map(
        (t) => html`<tr>
          <td><a href="/admin/transfers/${t.id}">${t.reference}</a></td>
          <td>${t.from_network} to ${t.to_network}</td><td>${t.sender_number}</td><td>${t.recipient_number}</td>
          <td class="num">${money(t.received_kobo ?? t.requested_kobo)}${t.received_kobo === null ? html`<span class="muted"> expected</span>` : ""}</td>
          <td class="num">${money(t.payout_kobo ?? t.quoted_payout_kobo)}</td>
          <td>${stateBadge(t.state)}${t.hold_reason ? html`<br><span class="muted">${t.hold_reason.replaceAll("_", " ")}</span>` : ""}</td>
          <td>${when(t.created_at)}</td>
        </tr>`,
      )}
      ${shown.length === 0 ? html`<tr><td colspan="8" class="muted">Nothing matches.</td></tr>` : ""}
    </table></div>
    ${pager(base, pageNo, hasMore)}`;
  return page({ title: "Transfers", admin: req.admin, current: "/admin/transfers", body });
}

// What a person can do to a transfer in its current state, each a real
// action on the state machine. The manual rails live here: a person sends
// the airtime from our SIM and records the result.
function actions(req: Request, t: Transfer): Html {
  const form = (action: string, label: string, cls = "", extra: Html = html``) =>
    html`<form method="post" action="/admin/transfers/${t.id}/${action}" class="panel">${csrf(req)}${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const out: Html[] = [];
  if (t.state === "awaiting_approval") {
    out.push(form("approve", `Approve payout of ${money(t.payout_kobo)}`, "", html`<p>This payout is above the approval threshold. Approving it puts your name on it.</p>`));
  }
  if (t.state === "held" && t.payout_kobo !== null) {
    out.push(form("release", "Release for payout", "", html`<p>Held because: ${t.hold_reason?.replaceAll("_", " ")}. Release it once you have fixed that.</p>`));
  }
  if (t.state === "payout_failed") {
    out.push(form("payout/retry", "Try the provider again now", "secondary", html`<p>Puts this transfer at the front of the automatic payout queue. Needs automatic payouts to be on and the provider set up.</p>`));
  }
  if (t.state === "inbound_confirmed" || t.state === "payout_failed") {
    out.push(
      form(
        "payout/start",
        "Start payout by hand",
        "",
        html`<p>Marks the transfer as paying out and shows you exactly what to send from our ${t.to_network} SIM. Use this when the automatic rail is down.</p>`,
      ),
    );
  }
  if (t.state === "paying_out") {
    out.push(html`<div class="panel">
      <p><strong>Send ${money(t.payout_kobo)} of ${t.to_network} airtime to ${t.recipient_number}</strong> from our ${t.to_network} SIM, then record the result here.</p>
      <form method="post" action="/admin/transfers/${t.id}/payout/done">${csrf(req)}
        <label for="ref">Reference from the network's confirmation message</label><input id="ref" name="reference" type="text" required>
        <button type="submit">Airtime sent</button>
      </form>
      <form method="post" action="/admin/transfers/${t.id}/payout/failed">${csrf(req)}
        <label for="why">What went wrong</label><input id="why" name="reason" type="text" required>
        <button type="submit" class="danger">Could not send</button>
      </form>
    </div>`);
  }
  if (["payout_failed", "held", "awaiting_approval"].includes(t.state)) {
    out.push(form("refund/start", `Refund ${money(t.received_kobo)} to the sender`, "danger", html`<p>Sends the airtime back to ${t.sender_number} on ${t.from_network}. The next screen tells you what to send.</p>`));
  }
  if (t.state === "refunding") {
    out.push(html`<div class="panel">
      <p><strong>Send ${money(t.received_kobo)} of ${t.from_network} airtime back to ${t.sender_number}</strong> from our ${t.from_network} SIM, then record it here.</p>
      <form method="post" action="/admin/transfers/${t.id}/refund/done">${csrf(req)}
        <label for="rref">Reference from the network's confirmation message</label><input id="rref" name="reference" type="text" required>
        <button type="submit">Refund sent</button>
      </form>
    </div>`);
  }
  return html`${out}`;
}

async function detailPage(req: Request, db: pg.Pool, id: number, message?: Html): Promise<string> {
  const t = await getTransfer(db, id);
  if (!t) throw new UserFacingError("no_such_transfer", "There is no transfer with that id.");
  const [events, notifications, code] = await Promise.all([
    db.query<{ at: Date; from_state: string | null; to_state: string; actor: string; detail: Record<string, unknown> }>(
      "SELECT at, from_state, to_state, actor, detail FROM transfer_events WHERE transfer_id = $1 ORDER BY id",
      [id],
    ),
    db.query<{ id: number; sender_number: string; amount_kobo: number; raw_text: string; source: string; received_at: Date }>(
      "SELECT id, sender_number, amount_kobo, raw_text, source, received_at FROM inbound_notifications WHERE matched_transfer_id = $1 ORDER BY id",
      [id],
    ),
    getSettingValue(db, "network.transfer_code"),
  ]);
  const dial = code[t.from_network];
  const body = html`<h1>${t.reference} ${stateBadge(t.state)}</h1>
    ${message ?? ""}
    <dl>
      <dt>Route</dt><dd>${t.from_network} to ${t.to_network}</dd>
      <dt>Sender</dt><dd>${t.sender_number}</dd>
      <dt>Recipient</dt><dd>${t.recipient_number}</dd>
      <dt>Our receiving number</dt><dd>${t.receiving_number}</dd>
      <dt>Quoted</dt><dd>${money(t.requested_kobo)} in, fee ${money(t.quoted_fee_kobo)}, ${money(t.quoted_payout_kobo)} out</dd>
      ${t.received_kobo !== null ? html`<dt>Actual</dt><dd>${money(t.received_kobo)} in, fee ${money(t.fee_kobo)} (ours ${money(t.platform_share_kobo)}, ${t.from_network}'s ${money(t.network_share_kobo)}), ${money(t.payout_kobo)} out</dd>` : ""}
      <dt>Created</dt><dd>${when(t.created_at)}, quote valid until ${when(t.expires_at)}</dd>
      ${t.inbound_confirmed_at ? html`<dt>Airtime received</dt><dd>${when(t.inbound_confirmed_at)}</dd>` : ""}
      ${t.paid_out_at ? html`<dt>Paid out</dt><dd>${when(t.paid_out_at)}, reference ${t.payout_reference}</dd>` : ""}
      ${t.refunded_at ? html`<dt>Refunded</dt><dd>${when(t.refunded_at)}, reference ${t.payout_reference}</dd>` : ""}
      ${t.approved_by ? html`<dt>Approved by</dt><dd>${t.approved_by} at ${when(t.approved_at)}</dd>` : ""}
      ${t.hold_reason ? html`<dt>Held because</dt><dd>${t.hold_reason.replaceAll("_", " ")}</dd>` : ""}
      <dt>Payout attempts</dt><dd>${t.payout_attempts}${t.payout_rail ? html`, last through ${t.payout_rail}` : ""}${t.payout_request_id ? html`, provider request ${t.payout_request_id}` : ""}</dd>
      ${t.payout_last_error ? html`<dt>Last provider answer</dt><dd>${t.payout_last_error}</dd>` : ""}
      ${t.payout_next_attempt_at && t.state === "payout_failed" ? html`<dt>Next automatic try</dt><dd>${when(t.payout_next_attempt_at)}</dd>` : ""}
      ${t.state === "awaiting_inbound" || t.state === "expired"
        ? html`<dt>Sender was told to dial</dt><dd>${dial ? dial.replace("{amount}", String(t.requested_kobo / 100)).replace("{number}", t.receiving_number).replace("{pin}", "PIN") : html`<span class="muted">no transfer code set for ${t.from_network} in Settings</span>`}</dd>`
        : ""}
    </dl>
    ${actions(req, t)}
    <h2>Airtime received</h2>
    ${notifications.rows.length === 0
      ? html`<p class="muted">None yet.</p>`
      : html`<div class="scroll"><table><tr><th>When</th><th>From</th><th class="num">Amount</th><th>Source</th><th>Message</th></tr>
        ${notifications.rows.map((n) => html`<tr><td>${when(n.received_at)}</td><td>${n.sender_number}</td><td class="num">${money(n.amount_kobo)}</td><td>${n.source}</td><td>${n.raw_text}</td></tr>`)}</table></div>`}
    <h2>History</h2>
    <div class="scroll"><table><tr><th>When</th><th>Change</th><th>By</th><th>Detail</th></tr>
      ${events.rows.map((e) => html`<tr><td>${when(e.at)}</td><td>${e.from_state ? e.from_state.replaceAll("_", " ") + " to " : ""}${e.to_state.replaceAll("_", " ")}</td><td>${e.actor}</td><td><code>${JSON.stringify(e.detail)}</code></td></tr>`)}
    </table></div>`;
  return page({ title: t.reference, admin: req.admin, current: "/admin/transfers", body });
}

export function registerTransfers(app: App): void {
  app.get("/admin/transfers", async (req, db) => ({ kind: "html", body: await listPage(req, db) }));

  app.get("/admin/transfers/:id", async (req, db) => {
    const raw = req.query.get("id")!;
    const byRef = /^tx-/i.test(raw) ? await getTransferByReference(db, raw) : undefined;
    const id = byRef ? byRef.id : Number(raw);
    if (!Number.isInteger(id)) throw new UserFacingError("no_such_transfer", "There is no transfer with that reference.");
    return { kind: "html", body: await detailPage(req, db, id) };
  });

  const act = (path: string, fn: (req: Request, db: pg.Pool, id: number) => Promise<Html>) =>
    app.post(`/admin/transfers/:id/${path}`, async (req, db) => {
      const id = Number(req.query.get("id"));
      let message: Html;
      let status = 200;
      try {
        message = await fn(req, db, id);
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        message = notice("problem", err.message);
        status = 400;
      }
      return { kind: "html", status, body: await detailPage(req, db, id, message) };
    });

  act("approve", async (req, db, id) => {
    const t = await withActor(actor(req.admin), (c) => approvePayout(c, actor(req.admin), id), db);
    return notice("ok", `Approved. ${t.reference} will pay out ${money(t.payout_kobo)} on the next payout run, or start it by hand below.`);
  });
  act("release", async (req, db, id) => {
    const t = await withActor(actor(req.admin), (c) => releaseHold(c, actor(req.admin), id), db);
    return notice("ok", `${t.reference} is back in the payout queue.`);
  });
  act("payout/start", async (req, db, id) => {
    const r = await withActor(actor(req.admin), (c) => startPayout(c, actor(req.admin), id), db);
    return r.started
      ? notice("ok", `Now send ${money(r.instruction.amountKobo)} of ${r.instruction.network} airtime to ${r.instruction.number} and record the result below.`)
      : notice("problem", r.reason);
  });
  act("payout/done", async (req, db, id) => {
    const reference = requiredField(req.form, "reference", "The network's reference");
    const t = await withActor(actor(req.admin), (c) => completePayout(c, actor(req.admin), id, reference), db);
    return t ? notice("ok", `${t.reference} is complete. ${money(t.payout_kobo)} paid on ${t.to_network}, fee ${money(t.fee_kobo)} booked.`) : notice("problem", "This transfer was not paying out, so nothing was recorded. Check its history below.");
  });
  act("payout/retry", async (req, db, id) => {
    const { rows } = await withActor(actor(req.admin), (c) => c.query<{ reference: string }>("UPDATE transfers SET payout_next_attempt_at = now(), payout_attempts = 0 WHERE id = $1 AND state = 'payout_failed' RETURNING reference", [id]), db);
    return rows[0] ? notice("ok", `${rows[0].reference} will be tried again on the next automatic payout run, within a minute.`) : notice("problem", "This transfer is not in a failed state, so there is nothing to retry.");
  });
  act("payout/failed", async (req, db, id) => {
    const reason = requiredField(req.form, "reason", "What went wrong");
    const t = await withActor(actor(req.admin), (c) => failPayout(c, actor(req.admin), id, reason), db);
    return t ? notice("info", `${t.reference} is marked as failed. You can try again or refund the sender.`) : notice("problem", "This transfer was not paying out, so nothing was recorded.");
  });
  act("refund/start", async (req, db, id) => {
    const r = await withActor(actor(req.admin), (c) => startRefund(c, actor(req.admin), id), db);
    return notice("ok", `Now send ${money(r.amountKobo)} of ${r.network} airtime back to ${r.number} and record it below.`);
  });
  act("refund/done", async (req, db, id) => {
    const reference = requiredField(req.form, "reference", "The network's reference");
    const t = await withActor(actor(req.admin), (c) => completeRefund(c, actor(req.admin), id, reference), db);
    return t ? notice("ok", `${t.reference} is refunded. ${money(t.received_kobo)} returned on ${t.from_network}; nothing is owed to the sender.`) : notice("problem", "This transfer was not refunding, so nothing was recorded.");
  });
}
