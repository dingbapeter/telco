import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { cancelOrder, completeDelivery, failDelivery, getOrder, getOrderByReference, recordPayment, refundOrder, releaseOrderHold, startDelivery, type Order } from "../orders.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, pager, requiredField, stateBadge, when } from "./shared.ts";

const PAGE = 50;
const NEEDS_PERSON = ["held", "delivery_failed"];

async function listPage(req: Request, db: pg.Pool): Promise<string> {
  const pageNo = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
  const needs = req.query.get("needs") === "person";
  const state = req.query.get("state");
  const q = (req.query.get("q") ?? "").trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (needs) where.push(`state = ANY($${params.push(NEEDS_PERSON)})`);
  if (state) where.push(`state = $${params.push(state)}`);
  if (q) where.push(`(reference ILIKE $${params.push("%" + q + "%")} OR recipient_number LIKE $${params.push("%" + q.replace(/\D/g, "") + "%")} OR payment_reference ILIKE $${params.push("%" + q + "%")})`);
  params.push(PAGE + 1, (pageNo - 1) * PAGE);
  const rows = (await db.query<Order>(`SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  const base = `/admin/orders?${needs ? "needs=person&" : ""}${state ? `state=${state}&` : ""}${q ? `q=${encodeURIComponent(q)}&` : ""}`;
  const body = html`<h1>Orders</h1>
    <p class="muted">Airtime sold for money. Bank transfers are confirmed here by hand; online payments confirm themselves.</p>
    <form method="get" action="/admin/orders" class="panel row">
      <div><label for="q">Reference, number or payment reference</label><input id="q" name="q" type="text" value="${q}"></div>
      <div><label for="state">State</label><select id="state" name="state"><option value="">Any</option>
        ${["awaiting_payment", "expired", "paid", "delivering", "delivered", "delivery_failed", "held", "refunded", "cancelled"].map((s) => html`<option value="${s}" ${s === state ? "selected" : ""}>${s.replaceAll("_", " ")}</option>`)}</select></div>
      <div><label>&nbsp;</label><button type="submit">Find</button> <a href="/admin/orders?needs=person">Needs a person</a> <a href="/admin/orders?state=awaiting_payment">Awaiting payment</a></div>
    </form>
    <div class="scroll"><table>
      <tr><th>Reference</th><th>Network</th><th>Number</th><th class="num">Airtime</th><th class="num">Price</th><th>Payment</th><th>State</th><th>Created</th></tr>
      ${rows.slice(0, PAGE).map(
        (o) => html`<tr><td><a href="/admin/orders/${o.id}">${o.reference}</a></td><td>${o.network_code}</td><td>${o.recipient_number}</td>
          <td class="num">${money(o.face_kobo)}</td><td class="num">${money(o.price_kobo)}</td><td>${o.payment_method ?? ""}${o.paid_kobo !== null ? html` ${money(o.paid_kobo)}` : ""}</td>
          <td>${stateBadge(o.state)}${o.hold_reason ? html`<br><span class="muted">${o.hold_reason.replaceAll("_", " ")}</span>` : ""}</td><td>${when(o.created_at)}</td></tr>`,
      )}
      ${rows.length === 0 ? html`<tr><td colspan="8" class="muted">Nothing matches.</td></tr>` : ""}
    </table></div>
    ${pager(base, pageNo, rows.length > PAGE)}`;
  return page({ title: "Orders", admin: req.admin, current: "/admin/orders", body });
}

function actions(req: Request, o: Order): Html {
  const form = (action: string, label: string, cls = "", extra: Html = html``) =>
    html`<form method="post" action="/admin/orders/${o.id}/${action}" class="panel">${csrf(req)}${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const out: Html[] = [];
  if (o.state === "awaiting_payment" || o.state === "expired") {
    out.push(html`<form method="post" action="/admin/orders/${o.id}/payment" class="panel">${csrf(req)}
      <p><strong>Bank transfer received?</strong> Record it once you can see ${money(o.price_kobo)} with narration ${o.reference} on the bank statement.</p>
      <div class="row"><div><label for="amt">Amount received, naira</label><input id="amt" name="amount" type="text" inputmode="decimal" value="${o.price_kobo % 100 === 0 ? o.price_kobo / 100 : (o.price_kobo / 100).toFixed(2)}" required></div>
      <div><label for="pref">Bank reference or narration</label><input id="pref" name="reference" type="text" required></div></div>
      <button type="submit">Payment received</button></form>`);
    out.push(form("cancel", "Cancel unpaid order", "secondary"));
  }
  if (o.state === "held" && o.hold_reason !== "underpaid") out.push(form("release", "Release for delivery", "", html`<p>Held because: ${o.hold_reason?.replaceAll("_", " ")}. Release it once fixed.</p>`));
  if (o.state === "delivery_failed") out.push(form("retry", "Try the provider again now", "secondary"));
  if (o.state === "paid" || o.state === "delivery_failed") out.push(form("delivery/start", "Deliver by hand", "", html`<p>Marks the order as delivering and shows you what to send from our ${o.network_code} SIM.</p>`));
  if (o.state === "delivering") {
    out.push(html`<div class="panel"><p><strong>Send ${money(o.face_kobo)} of ${o.network_code} airtime to ${o.recipient_number}</strong> from our ${o.network_code} SIM, then record it.</p>
      <form method="post" action="/admin/orders/${o.id}/delivery/done">${csrf(req)}<label for="dref">Reference from the network's message</label><input id="dref" name="reference" type="text" required><button type="submit">Airtime sent</button></form>
      <form method="post" action="/admin/orders/${o.id}/delivery/failed">${csrf(req)}<label for="why">What went wrong</label><input id="why" name="reason" type="text" required><button type="submit" class="danger">Could not send</button></form></div>`);
  }
  if (["paid", "delivery_failed", "held"].includes(o.state) && o.paid_kobo !== null) {
    out.push(html`<form method="post" action="/admin/orders/${o.id}/refund" class="panel">${csrf(req)}
      <p>Send ${money(o.paid_kobo)} back to the buyer by bank transfer, then record it here.</p>
      <label for="rref">Bank reference of the refund</label><input id="rref" name="reference" type="text" required>
      <button type="submit" class="danger">Refund recorded</button></form>`);
  }
  return html`${out}`;
}

async function detailPage(req: Request, db: pg.Pool, id: number, message?: Html): Promise<string> {
  const o = await getOrder(db, id);
  if (!o) throw new UserFacingError("no_such_order", "There is no order with that id.");
  const events = (await db.query<{ at: Date; from_state: string | null; to_state: string; actor: string; detail: Record<string, unknown> }>("SELECT at, from_state, to_state, actor, detail FROM order_events WHERE order_id = $1 ORDER BY id", [id])).rows;
  const body = html`<h1>${o.reference} ${stateBadge(o.state)}</h1>${message ?? ""}
    <dl><dt>Airtime</dt><dd>${money(o.face_kobo)} on ${o.network_code} to ${o.recipient_number}</dd>
      <dt>Price</dt><dd>${money(o.price_kobo)}${o.discount_kobo > 0 ? html` (${money(o.discount_kobo)} off)` : ""}</dd>
      ${o.buyer_email ? html`<dt>Buyer email</dt><dd>${o.buyer_email}</dd>` : ""}
      ${o.paid_kobo !== null ? html`<dt>Paid</dt><dd>${money(o.paid_kobo)} by ${o.payment_method}, reference ${o.payment_reference}, fee ${money(o.payment_fee_kobo ?? 0)}, at ${when(o.paid_at)}</dd>` : ""}
      <dt>Created</dt><dd>${when(o.created_at)}, pay by ${when(o.expires_at)}</dd>
      ${o.delivered_at ? html`<dt>Delivered</dt><dd>${when(o.delivered_at)} through ${o.delivery_rail}, reference ${o.delivery_reference}</dd>` : ""}
      ${o.delivery_last_error ? html`<dt>Last delivery answer</dt><dd>${o.delivery_last_error}</dd>` : ""}
      ${o.refunded_at ? html`<dt>Refunded</dt><dd>${money(o.refunded_kobo)} at ${when(o.refunded_at)}, reference ${o.refund_reference}</dd>` : ""}
      ${o.hold_reason ? html`<dt>Held because</dt><dd>${o.hold_reason.replaceAll("_", " ")}</dd>` : ""}
      <dt>Delivery attempts</dt><dd>${o.delivery_attempts}</dd></dl>
    ${actions(req, o)}
    <h2>History</h2>
    <div class="scroll"><table><tr><th>When</th><th>Change</th><th>By</th><th>Detail</th></tr>
      ${events.map((e) => html`<tr><td>${when(e.at)}</td><td>${e.from_state ? e.from_state.replaceAll("_", " ") + " to " : ""}${e.to_state.replaceAll("_", " ")}</td><td>${e.actor}</td><td><code>${JSON.stringify(e.detail)}</code></td></tr>`)}
    </table></div>`;
  return page({ title: o.reference, admin: req.admin, current: "/admin/orders", body });
}

export function registerOrders(app: App): void {
  app.get("/admin/orders", async (req, db) => ({ kind: "html", body: await listPage(req, db) }));
  app.get("/admin/orders/:id", async (req, db) => {
    const raw = req.query.get("id")!;
    const byRef = /^rt-/i.test(raw) ? await getOrderByReference(db, raw) : undefined;
    const id = byRef ? byRef.id : Number(raw);
    if (!Number.isInteger(id)) throw new UserFacingError("no_such_order", "There is no order with that reference.");
    return { kind: "html", body: await detailPage(req, db, id) };
  });

  const act = (path: string, fn: (req: Request, db: pg.Pool, id: number) => Promise<Html>) =>
    app.post(`/admin/orders/:id/${path}`, async (req, db) => {
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

  act("payment", async (req, db, id) => {
    const amount = nairaField(req.form, "amount", "Amount received");
    const reference = requiredField(req.form, "reference", "Bank reference");
    const r = await withActor(actor(req.admin), (c) => recordPayment(c, actor(req.admin), id, { method: "bank_transfer", reference, paidKobo: amount, feeKobo: 0, cashAccount: "cash:bank" }), db);
    if (r.outcome === "already") return notice("info", `${r.order.reference} was already ${r.order.state.replaceAll("_", " ")}, so nothing was recorded.`);
    return r.outcome === "paid"
      ? notice("ok", `${money(amount)} recorded. ${r.order.reference} will be delivered on the next automatic run, or deliver it by hand below.`)
      : notice("info", `${money(amount)} recorded, which is less than the price of ${money(r.order.price_kobo)}. The order is held; refund it below.`);
  });
  act("cancel", async (req, db, id) => {
    const o = await withActor(actor(req.admin), (c) => cancelOrder(c, actor(req.admin), id), db);
    return notice("ok", `${o.reference} is cancelled.`);
  });
  act("release", async (req, db, id) => {
    const o = await withActor(actor(req.admin), (c) => releaseOrderHold(c, actor(req.admin), id), db);
    return notice("ok", `${o.reference} is back in the delivery queue.`);
  });
  act("retry", async (req, db, id) => {
    const { rows } = await withActor(actor(req.admin), (c) => c.query<{ reference: string }>("UPDATE orders SET delivery_next_attempt_at = now(), delivery_attempts = 0 WHERE id = $1 AND state = 'delivery_failed' RETURNING reference", [id]), db);
    return rows[0] ? notice("ok", `${rows[0].reference} will be tried again within a minute.`) : notice("problem", "This order is not in a failed state.");
  });
  act("delivery/start", async (req, db, id) => {
    const r = await withActor(actor(req.admin), (c) => startDelivery(c, actor(req.admin), id), db);
    return r.started ? notice("ok", `Now send ${money(r.amountKobo)} of ${r.network} airtime to ${r.number} and record it below.`) : notice("problem", r.reason);
  });
  act("delivery/done", async (req, db, id) => {
    const reference = requiredField(req.form, "reference", "The network's reference");
    const o = await withActor(actor(req.admin), (c) => completeDelivery(c, actor(req.admin), id, reference), db);
    return o ? notice("ok", `${o.reference} is delivered and the sale is booked.`) : notice("problem", "This order was not delivering, so nothing was recorded.");
  });
  act("delivery/failed", async (req, db, id) => {
    const reason = requiredField(req.form, "reason", "What went wrong");
    const o = await withActor(actor(req.admin), (c) => failDelivery(c, actor(req.admin), id, reason), db);
    return o ? notice("info", `${o.reference} is marked as failed. Try again or refund the buyer.`) : notice("problem", "This order was not delivering, so nothing was recorded.");
  });
  act("refund", async (req, db, id) => {
    const reference = requiredField(req.form, "reference", "Bank reference of the refund");
    const o = await withActor(actor(req.admin), (c) => refundOrder(c, actor(req.admin), id, reference), db);
    return notice("ok", `${o.reference} is refunded: ${money(o.refunded_kobo)} returned to the buyer.`);
  });
}
