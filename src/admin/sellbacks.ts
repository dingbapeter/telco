import type pg from "pg";
import { getBundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { balance } from "../ledger.ts";
import { formatNaira } from "../money.ts";
import { START_OF_TODAY } from "../receiving.ts";
import {
  blockSeller,
  cashPayoutCheck,
  getCreditNote,
  getSellback,
  paySellbackCash,
  otherNumbersOnAccount,
  rateFor,
  releaseSellback,
  returnByHand,
  completeSellbackReturn,
  sellerHistory,
  startSellbackReturn,
  unblockSeller,
  voidCredit,
  type CreditNote,
  type Sellback,
} from "../sellbacks.ts";
import { getSettingValues, NETWORK_CODES } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, requiredField, when } from "./shared.ts";

type Row = Sellback & { bundle_name: string | null };

const KIND = (s: Sellback): string => (s.kind === "data" ? "data" : "airtime");

async function rows(db: pg.Pool, where: string, params: unknown[] = [], limit = 50): Promise<Row[]> {
  const { rows: found } = await db.query<Row>(
    `SELECT s.*, b.name AS bundle_name FROM sellbacks s LEFT JOIN data_bundles b ON b.id = s.bundle_id
     WHERE ${where} ORDER BY s.id DESC LIMIT ${limit}`,
    params,
  );
  return found;
}

function stateWord(s: Sellback): string {
  return s.state.replaceAll("_", " ");
}

// The facts a person needs before they pay anybody, in one place so that
// every screen where a payout can be settled shows the same ones: what this
// number has sold us before, and whether the bank account has collected for
// other lines. Shown even when nothing is wrong, because a clean history is
// also information.
async function riskNote(db: pg.Pool, s: Sellback): Promise<Html> {
  const history = await sellerHistory(db, s.seller_number);
  const shared = s.bank_account_digits ? await otherNumbersOnAccount(db, s.bank_account_digits, s.seller_number) : [];
  return html`<p class="muted">This number has sold to us ${history.sales} time${history.sales === 1 ? "" : "s"}, ${money(history.soldKobo)} in all, and has taken ${money(history.paidKobo)}${history.firstAt ? `, first on ${when(history.firstAt)}` : ""}.${history.blocked ? " It is blocked from selling to us." : ""}</p>
    ${shared.length > 0
      ? notice("problem", html`This bank account has also been given for sales from ${shared.length} other number${shared.length === 1 ? "" : "s"}: ${shared.join(", ")}. One account collecting for several lines is how a ring looks. Satisfy yourself before paying.`)
      : ""}`;
}

async function sellbacksPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const [airtimeOn, dataOn, cashOn, cashCap, holdHours] = await getSettingValues(db, [
    "sellback.airtime_enabled",
    "sellback.data_enabled",
    "sellback.cash_enabled",
    "sellback.cash_daily_cap_kobo",
    "sellback.cash_hold_hours",
  ] as const);
  const today = (await db.query<{ bought: number; cash: number }>(
    `SELECT coalesce(sum(CASE WHEN s.state NOT IN ('expired', 'cancelled', 'returned') THEN coalesce(s.received_kobo, 0) ELSE 0 END), 0)::bigint AS bought,
            coalesce(sum(CASE WHEN s.state = 'paid' THEN s.pay_kobo ELSE 0 END), 0)::bigint AS cash
     FROM sellbacks s WHERE s.created_at >= ${START_OF_TODAY}`,
  )).rows[0]!;
  const credit = (await db.query<{ open: number; total: number }>(
    "SELECT count(*)::int AS open, coalesce(sum(remaining_kobo), 0)::bigint AS total FROM credit_notes WHERE state = 'open'",
  )).rows[0]!;
  const owed = await balance(db, "owed:sellers");
  const margin = await balance(db, "revenue:sellback_margin");
  const waitingCash = await rows(db, "s.state = 'received' AND s.outcome = 'cash'");
  const held = await rows(db, "s.state = 'held'");
  const returning = await rows(db, "s.state = 'returning'");
  const recent = await rows(db, "s.state NOT IN ('awaiting_inbound', 'expired')", [], 30);
  const waiting = await rows(db, "s.state IN ('awaiting_inbound', 'expired')", [], 10);
  const blocks = (await db.query<{ number: string; reason: string; added_at: Date; added_by: string }>("SELECT * FROM sellback_blocks ORDER BY added_at DESC")).rows;

  // Any network whose rate is unsafe or unset is named here, because buying
  // back silently refusing every seller is worse than saying why.
  const warnings: string[] = [];
  for (const network of NETWORK_CODES) {
    if (airtimeOn) {
      const r = await rateFor(db, network, "airtime");
      if (!r.ok) warnings.push(r.reason);
    }
    if (dataOn) {
      const r = await rateFor(db, network, "data");
      if (!r.ok) warnings.push(r.reason);
    }
  }

  const sale = (s: Row): Html => html`<tr><td><a href="/admin/sellbacks/${s.id}">${s.reference}</a></td>
    <td>${s.seller_number}</td><td>${s.network_code} ${KIND(s)}${s.bundle_name ? ` (${s.bundle_name})` : ""}</td>
    <td class="num">${money(s.received_kobo ?? s.face_kobo)}</td><td class="num">${money(s.pay_kobo ?? s.quoted_pay_kobo)}</td>
    <td>${s.outcome}</td><td>${stateWord(s)}${s.hold_reason ? ` (${s.hold_reason.replaceAll("_", " ")})` : ""}</td><td>${when(s.created_at)}</td></tr>`;

  const body = html`<h1>Buying back</h1>${message ?? ""}
    <p class="muted">Airtime and data bought from the people holding it. Value is only ever believed from the network's own message. Rates, caps and the cash switch are under Settings, Buying back.</p>
    ${!airtimeOn && !dataOn ? notice("info", "Buying back is switched off, so the public page says we are not buying. Nothing already owed is affected.") : ""}
    ${warnings.map((w) => notice("problem", w))}
    <div class="cards">
      <div class="card"><div class="label">Bought today</div><div class="value">${money(today.bought)}</div></div>
      <div class="card"><div class="label">Cash paid today</div><div class="value">${money(today.cash)}${cashCap > 0 ? html`<span class="muted"> of ${money(cashCap)}</span>` : ""}</div></div>
      <div class="card"><div class="label">Owed to sellers</div><div class="value">${money(owed)}</div></div>
      <div class="card"><div class="label">Credit unspent</div><div class="value">${money(credit.total)}<span class="muted"> on ${credit.open} codes</span></div></div>
      <div class="card"><div class="label">Margin earned</div><div class="value">${money(margin)}</div></div>
    </div>

    <h2>Cash waiting to be paid (${waitingCash.length})</h2>
    ${!cashOn ? notice("info", "Paying in cash is switched off. Sellers waiting here can be given credit instead, or sent their value back.") : ""}
    ${waitingCash.length === 0 ? html`<p class="muted">None.</p>` : ""}
    ${await Promise.all(waitingCash.map(async (s) => {
      const check = await cashPayoutCheck(db, s);
      return html`<form method="post" action="/admin/sellbacks/${s.id}/cash" class="panel">${csrf(req)}
        <p><strong>${money(s.pay_kobo)}</strong> to ${s.seller_number} for ${money(s.received_kobo)} of ${s.network_code} ${KIND(s)}, landed ${when(s.received_at)}. <a href="/admin/sellbacks/${s.id}">${s.reference}</a></p>
        <p>Pay to: <strong>${s.bank_details}</strong></p>
        ${await riskNote(db, s)}
        ${check.ok ? "" : notice("info", check.reason)}
        <div class="row"><div><label for="ref-${s.id}">Bank reference once sent</label><input id="ref-${s.id}" name="reference" type="text" ${check.ok ? "required" : "disabled"}></div>
          <div><label>&nbsp;</label><button type="submit" ${check.ok ? "" : "disabled"}>Paid</button></div></div></form>`;
    }))}

    <h2>Held, waiting for a person (${held.length})</h2>
    ${held.length === 0 ? html`<p class="muted">None.</p>` : ""}
    ${await Promise.all(held.map(async (s) => html`<div class="panel">
      <p><strong>${s.reference}</strong>: ${money(s.received_kobo)} of ${s.network_code} ${KIND(s)} from ${s.seller_number}, held because ${(s.hold_reason ?? "").replaceAll("_", " ")}. We would owe ${money(s.pay_kobo)}.</p>
      <div class="row">
        <form method="post" action="/admin/sellbacks/${s.id}/release" class="inline">${csrf(req)}<button type="submit">Buy it anyway</button></form>
        <form method="post" action="/admin/sellbacks/${s.id}/return" class="inline">${csrf(req)}<button type="submit" class="danger">Send it back</button></form>
      </div>
      ${await riskNote(db, s)}
      <p class="muted">Sending it back puts it on the ${s.network_code} phone, which sends the same value to ${s.seller_number} on its own. If no phone can, it appears below for you to send by hand. Open <a href="/admin/sellbacks/${s.id}">${s.reference}</a> for the whole story.</p></div>`))}

    <h2>On their way back (${returning.length})</h2>
    ${returning.length === 0 ? html`<p class="muted">None.</p>` : ""}
    ${returning.map((s) => html`<div class="panel">
      <p><strong>${s.reference}</strong>: ${money(s.received_kobo)} of ${s.network_code} ${KIND(s)} going back to ${s.seller_number}${s.hold_reason ? `, because ${s.hold_reason.replaceAll("_", " ")}` : ""}.</p>
      ${s.return_last_error ? notice("info", s.return_last_error) : ""}
      ${s.return_rail === "manual"
        ? html`<form method="post" action="/admin/sellbacks/${s.id}/returned">${csrf(req)}
            <p>Send ${money(s.received_kobo)} from our ${s.network_code} SIM to ${s.seller_number}, then record it here.</p>
            <div class="row"><div><label for="note-${s.id}">What you sent and how</label><input id="note-${s.id}" name="note" type="text" required></div>
              <div><label>&nbsp;</label><button type="submit">Sent back</button></div></div></form>`
        : html`<p class="muted">With the ${s.network_code} phone as command ${s.return_request_id ?? "not yet queued"}. The books move when the network confirms it.</p>
            <form method="post" action="/admin/sellbacks/${s.id}/byhand" class="inline">${csrf(req)}<button type="submit" class="secondary">Take it over by hand</button></form>`}</div>`)}

    <h2>Waiting for the seller to send (${waiting.length})</h2>
    <div class="scroll"><table><tr><th>Reference</th><th>Seller</th><th>What</th><th class="num">Worth</th><th class="num">We pay</th><th>Wants</th><th>State</th><th>Started</th></tr>
      ${waiting.map(sale)}${waiting.length === 0 ? html`<tr><td colspan="8" class="muted">Nothing waiting.</td></tr>` : ""}</table></div>

    <h2>Done and in progress</h2>
    <div class="scroll"><table><tr><th>Reference</th><th>Seller</th><th>What</th><th class="num">Worth</th><th class="num">Paid</th><th>Wants</th><th>State</th><th>When</th></tr>
      ${recent.map(sale)}${recent.length === 0 ? html`<tr><td colspan="8" class="muted">Nothing yet.</td></tr>` : ""}</table></div>

    <h2>Find a credit code</h2>
    <form method="post" action="/admin/sellbacks/credit" class="panel">${csrf(req)}
      <div class="row"><div><label for="code">Credit code</label><input id="code" name="code" type="text" autocapitalize="characters"></div>
        <div><label>&nbsp;</label><button type="submit" class="secondary">Look it up</button></div></div></form>

    <h2>Numbers we will not buy from (${blocks.length})</h2>
    <div class="scroll"><table><tr><th>Number</th><th>Why</th><th>Added</th><th>By</th><th></th></tr>
      ${blocks.map((b) => html`<tr><td>${b.number}</td><td>${b.reason}</td><td>${when(b.added_at)}</td><td>${b.added_by}</td>
        <td><form method="post" action="/admin/sellbacks/unblock" class="inline">${csrf(req)}<input type="hidden" name="number" value="${b.number}"><button type="submit" class="secondary">Unblock</button></form></td></tr>`)}
      ${blocks.length === 0 ? html`<tr><td colspan="5" class="muted">None.</td></tr>` : ""}</table></div>
    <form method="post" action="/admin/sellbacks/block" class="panel">${csrf(req)}
      <div class="row"><div><label for="number">Block a number</label><input id="number" name="number" type="text" inputmode="tel" required></div>
        <div><label for="reason">Why</label><input id="reason" name="reason" type="text" required></div>
        <div><label>&nbsp;</label><button type="submit" class="danger">Block</button></div></div>
      <p class="muted">A blocked number is refused a quote, and anything already on its way in is held for you. Credit already given stays until you stop the code.</p></form>
    ${holdHours === 0 && cashOn ? notice("info", "Cash can be paid the moment value lands, because the holding time is set to nothing. A wait of a day is the cheapest fraud control you have.") : ""}`;
  return { kind: "html", status, body: page({ title: "Buying back", admin: req.admin, current: "/admin/sellbacks", body }) };
}

async function salePage(req: Request, db: pg.Pool, id: number, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const s = await getSellback(db, id);
  if (!s) throw new UserFacingError("no_such_sellback", "There is no sale with that id.");
  const bundle = s.bundle_id ? await getBundle(db, s.bundle_id) : undefined;
  const history = await sellerHistory(db, s.seller_number);
  const facts = await riskNote(db, s);
  const note = s.credit_code ? await getCreditNote(db, s.credit_code) : undefined;
  const events = (await db.query<{ at: Date; from_state: string | null; to_state: string; actor: string; detail: unknown }>(
    "SELECT at, from_state, to_state, actor, detail FROM sellback_events WHERE sellback_id = $1 ORDER BY id",
    [id],
  )).rows;
  const check = s.outcome === "cash" && s.state === "received" ? await cashPayoutCheck(db, s) : undefined;
  const body = html`<h1>${s.reference} <span class="state">${stateWord(s)}</span></h1>${message ?? ""}
    <dl><dt>Seller</dt><dd>${s.seller_number}${history.blocked ? " (blocked)" : ""}</dd>
      <dt>What</dt><dd>${s.network_code} ${KIND(s)}${bundle ? `, ${bundle.name}` : ""}</dd>
      <dt>Our number</dt><dd>${s.receiving_number}</dd>
      <dt>Worth</dt><dd>${money(s.received_kobo ?? s.face_kobo)}${s.received_kobo === null ? " (quoted, not yet arrived)" : ""}</dd>
      <dt>Rate</dt><dd>${(s.rate_basis_points / 100).toFixed(2)} percent of face value</dd>
      <dt>We pay</dt><dd><strong>${money(s.pay_kobo ?? s.quoted_pay_kobo)}</strong> as ${s.outcome}</dd>
      ${s.bank_details ? html`<dt>Bank</dt><dd>${s.bank_details}</dd>` : ""}
      ${s.credit_code ? html`<dt>Credit code</dt><dd>${s.credit_code}${note ? ` (${note.state}, ${formatNaira(note.remaining_kobo)} left)` : ""}</dd>` : ""}
      ${s.payout_reference ? html`<dt>Reference</dt><dd>${s.payout_reference}</dd>` : ""}
      <dt>Started</dt><dd>${when(s.created_at)}</dd>
      ${s.received_at ? html`<dt>Landed</dt><dd>${when(s.received_at)}</dd>` : ""}
      ${s.settled_at ? html`<dt>Settled</dt><dd>${when(s.settled_at)} by ${s.settled_by}</dd>` : ""}</dl>
    ${facts}
    ${s.state === "held" ? html`<h2>Held: ${(s.hold_reason ?? "").replaceAll("_", " ")}</h2>
      <form method="post" action="/admin/sellbacks/${s.id}/release" class="panel">${csrf(req)}<p>Buy it anyway at the rate quoted. ${s.outcome === "credit" ? "The seller gets their credit code at once." : "It joins the cash queue."}</p><button type="submit">Buy it anyway</button></form>` : ""}
    ${s.state === "held" || s.state === "received"
      ? html`<form method="post" action="/admin/sellbacks/${s.id}/return" class="panel">${csrf(req)}
          <p>Send the value back to ${s.seller_number} on ${s.network_code}. The phone does it; if no phone can, it comes back to you to send by hand. Nothing will be owed either way.</p>
          <button type="submit" class="danger">Send it back</button></form>`
      : ""}
    ${s.state === "returning"
      ? html`<h2>Going back to ${s.seller_number}</h2>
          ${s.return_last_error ? notice("info", s.return_last_error) : ""}
          ${s.return_rail === "manual"
            ? html`<form method="post" action="/admin/sellbacks/${s.id}/returned" class="panel">${csrf(req)}
                <p>Send ${money(s.received_kobo)} from our ${s.network_code} SIM to ${s.seller_number}, then record it here. The books move when you do.</p>
                <div class="row"><div><label for="note">What you sent and how</label><input id="note" name="note" type="text" required></div>
                  <div><label>&nbsp;</label><button type="submit">Sent back</button></div></div></form>`
            : html`<form method="post" action="/admin/sellbacks/${s.id}/byhand" class="panel">${csrf(req)}
                <p>The ${s.network_code} phone has this one${s.return_request_id ? ` as ${s.return_request_id}` : ""}. Take it over only if the phone cannot send it, or it could go out twice.</p>
                <button type="submit" class="secondary">Take it over by hand</button></form>`}`
      : ""}
    ${s.outcome === "cash" && s.state === "received"
      ? html`<form method="post" action="/admin/sellbacks/${s.id}/cash" class="panel">${csrf(req)}
          <p>Send ${money(s.pay_kobo)} by bank transfer to <strong>${s.bank_details}</strong>, then record it here.</p>
          ${check && !check.ok ? notice("info", check.reason) : ""}
          <div class="row"><div><label for="reference">Bank reference</label><input id="reference" name="reference" type="text" ${check?.ok ? "required" : "disabled"}></div>
            <div><label>&nbsp;</label><button type="submit" ${check?.ok ? "" : "disabled"}>Paid</button></div></div></form>`
      : ""}
    ${note && note.state !== "voided"
      ? html`<form method="post" action="/admin/sellbacks/credit/void" class="panel">${csrf(req)}
          <input type="hidden" name="code" value="${note.code}">
          <p>Stop this credit code. Only for value we should never have bought: the ${formatNaira(note.remaining_kobo)} left on it becomes ours and the seller is told the code was stopped.</p>
          <div class="row"><div><label for="reason">Why</label><input id="reason" name="reason" type="text" required></div>
            <div><label>&nbsp;</label><button type="submit" class="danger">Stop the code</button></div></div></form>`
      : ""}
    ${history.blocked
      ? html`<form method="post" action="/admin/sellbacks/unblock" class="panel">${csrf(req)}<input type="hidden" name="number" value="${s.seller_number}"><p>This number is blocked from selling to us.</p><button type="submit" class="secondary">Unblock it</button></form>`
      : html`<form method="post" action="/admin/sellbacks/block" class="panel">${csrf(req)}<input type="hidden" name="number" value="${s.seller_number}">
          <div class="row"><div><label for="reason">Block ${s.seller_number} from selling to us, because</label><input id="reason" name="reason" type="text" required></div>
            <div><label>&nbsp;</label><button type="submit" class="danger">Block</button></div></div></form>`}
    <h2>What happened</h2>
    <div class="scroll"><table><tr><th>When</th><th>From</th><th>To</th><th>Who</th><th>Detail</th></tr>
      ${events.map((e) => html`<tr><td>${when(e.at)}</td><td>${e.from_state ?? ""}</td><td>${e.to_state}</td><td>${e.actor}</td><td>${JSON.stringify(e.detail)}</td></tr>`)}</table></div>
    <p><a href="/admin/sellbacks">Back to buying back</a></p>`;
  return { kind: "html", status, body: page({ title: s.reference, admin: req.admin, current: "/admin/sellbacks", body }) };
}

function creditPanel(note: CreditNote, req: Request): Html {
  return html`<div class="panel"><p><strong>${note.code}</strong>: ${money(note.amount_kobo)} issued, ${money(note.remaining_kobo)} left, ${note.state}${note.last_used_at ? `, last used ${when(note.last_used_at)}` : ""}.</p>
    <p><a href="/admin/sellbacks/${note.sellback_id}">The sale it came from</a>${note.void_reason ? `. Stopped by ${note.voided_by}: ${note.void_reason}` : ""}</p>
    ${note.state === "voided"
      ? ""
      : html`<form method="post" action="/admin/sellbacks/credit/void" class="inline">${csrf(req)}<input type="hidden" name="code" value="${note.code}">
          <input type="text" name="reason" placeholder="Why it is being stopped" required><button type="submit" class="danger">Stop the code</button></form>`}</div>`;
}

export function registerSellbacksAdmin(app: App): void {
  app.get("/admin/sellbacks", (req, db) => sellbacksPage(req, db));
  app.get("/admin/sellbacks/:id", (req, db) => salePage(req, db, Number(req.query.get("id"))));

  app.post("/admin/sellbacks/:id/cash", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const reference = requiredField(req.form, "reference", "The bank reference");
      const s = await withActor(actor(req.admin), (c) => paySellbackCash(c, actor(req.admin), id, reference), db);
      return sellbacksPage(req, db, notice("ok", `Recorded ${money(s.pay_kobo)} paid to ${s.seller_number} for ${s.reference}.`));
    } catch (err) {
      if (err instanceof UserFacingError) return salePage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/:id/release", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const s = await withActor(actor(req.admin), (c) => releaseSellback(c, actor(req.admin), id), db);
      return salePage(req, db, id, notice("ok", s.credit_code ? `Bought. The seller's credit code is ${s.credit_code}.` : "Bought. It is now in the cash queue."));
    } catch (err) {
      if (err instanceof UserFacingError) return salePage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/:id/return", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const s = await withActor(actor(req.admin), (c) => startSellbackReturn(c, actor(req.admin), id), db);
      return salePage(
        req,
        db,
        id,
        notice(
          "ok",
          s.return_rail === "manual"
            ? `${s.reference} is marked as going back to ${s.seller_number}. Automatic payouts are off, so send it from the ${s.network_code} SIM and record it below.`
            : `${s.reference} is going back to ${s.seller_number}. The ${s.network_code} phone sends it within a minute and the books move when the network confirms it.`,
        ),
      );
    } catch (err) {
      if (err instanceof UserFacingError) return salePage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/:id/returned", async (req, db) => {
    const id = Number(req.query.get("id"));
    try {
      const note = requiredField(req.form, "note", "What you sent");
      const s = await withActor(actor(req.admin), (c) => completeSellbackReturn(c, actor(req.admin), id, note, { byHand: true }), db);
      if (!s) return salePage(req, db, id, notice("problem", "That one is no longer on its way back, so nothing was recorded. Read what happened below."), 400);
      return salePage(req, db, id, notice("ok", `Recorded as sent back to ${s.seller_number}. Nothing is owed on ${s.reference}.`));
    } catch (err) {
      if (err instanceof UserFacingError) return salePage(req, db, id, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/:id/byhand", async (req, db) => {
    const id = Number(req.query.get("id"));
    const took = await withActor(actor(req.admin), (c) => returnByHand(c, actor(req.admin), id), db);
    return salePage(
      req,
      db,
      id,
      took
        ? notice("ok", "This one is yours to send now. Send the value from the SIM and record it below.")
        : notice("problem", "It could not be taken over: a phone has already been given it, or it is no longer going back. Read what happened below."),
      took ? 200 : 400,
    );
  });

  app.post("/admin/sellbacks/credit", async (req, db) => {
    const note = await getCreditNote(db, req.form.get("code") ?? "");
    return sellbacksPage(req, db, note ? creditPanel(note, req) : notice("problem", "There is no credit code like that."), note ? 200 : 404);
  });

  app.post("/admin/sellbacks/credit/void", async (req, db) => {
    try {
      const reason = requiredField(req.form, "reason", "A reason");
      const note = await withActor(actor(req.admin), (c) => voidCredit(c, actor(req.admin), req.form.get("code") ?? "", reason), db);
      return sellbacksPage(req, db, notice("ok", `Credit code ${note.code} is stopped. ${money(note.amount_kobo)} was issued and anything left on it is now ours.`));
    } catch (err) {
      if (err instanceof UserFacingError) return sellbacksPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/block", async (req, db) => {
    try {
      const number = await withActor(actor(req.admin), (c) => blockSeller(c, actor(req.admin), req.form.get("number") ?? "", req.form.get("reason") ?? ""), db);
      return sellbacksPage(req, db, notice("ok", `${number} cannot sell to us from now on. Anything already on its way in will be held for you.`));
    } catch (err) {
      if (err instanceof UserFacingError) return sellbacksPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/sellbacks/unblock", async (req, db) => {
    await withActor(actor(req.admin), (c) => unblockSeller(c, req.form.get("number") ?? ""), db);
    return sellbacksPage(req, db, notice("ok", "That number can sell to us again."));
  });
}
