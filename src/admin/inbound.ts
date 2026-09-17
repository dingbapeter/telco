import type pg from "pg";
import { parseSizeMb } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { NETWORK_CODES } from "../settings.ts";
import { attachNotification, getTransferByReference, recordInbound } from "../transfers.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, pager, requiredField, when } from "./shared.ts";

const PAGE = 50;

async function inboundPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const pageNo = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
  const [unmatched, recent, numbers] = await Promise.all([
    db.query<{ id: number; network_code: string; receiving_number: string; sender_number: string; amount_kobo: number; raw_text: string; source: string; received_at: Date }>(
      "SELECT id, network_code, receiving_number, sender_number, amount_kobo, raw_text, source, received_at FROM inbound_notifications WHERE matched_transfer_id IS NULL ORDER BY received_at DESC LIMIT 100",
    ),
    db.query<{ id: number; network_code: string; sender_number: string; amount_kobo: number; source: string; received_at: Date; reference: string | null; transfer_id: number | null }>(
      `SELECT n.id, n.network_code, n.sender_number, n.amount_kobo, n.source, n.received_at, t.reference, t.id AS transfer_id
       FROM inbound_notifications n LEFT JOIN transfers t ON t.id = n.matched_transfer_id
       ORDER BY n.received_at DESC LIMIT $1 OFFSET $2`,
      [PAGE + 1, (pageNo - 1) * PAGE],
    ),
    db.query<{ number: string; network_code: string }>("SELECT number, network_code FROM receiving_numbers WHERE active ORDER BY network_code, number"),
  ]);
  const hasMore = recent.rows.length > PAGE;
  const body = html`<h1>Airtime in</h1>
    ${message ?? ""}
    <h2>Record airtime received by hand</h2>
    <p class="muted">Use this when the phone bridge is offline and you can see the network's message on the phone. Copy the message exactly. If a transfer is waiting for it, it is matched at once.</p>
    <form method="post" action="/admin/inbound" class="panel">${csrf(req)}
      <div class="row">
        <div><label for="network">Network</label><select id="network" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
        <div><label for="receiving">Our number it arrived on</label>
          <select id="receiving" name="receiving">${numbers.rows.map((n) => html`<option value="${n.number}">${n.network_code} ${n.number}</option>`)}</select></div>
      </div>
      <div class="row">
        <div><label for="sender">Sender's number <span class="hint">as shown in the message</span></label><input id="sender" name="sender" type="text" inputmode="tel" required></div>
        <div><label for="amount">Airtime amount in naira <span class="hint">leave empty for gifted data</span></label><input id="amount" name="amount" type="text" inputmode="decimal"></div>
        <div><label for="data">Gifted data size <span class="hint">like 1GB, only for data</span></label><input id="data" name="data" type="text"></div>
      </div>
      <label for="raw">The network's message, word for word</label><textarea id="raw" name="raw" required></textarea>
      <button type="submit">Record it</button>
    </form>
    <h2>Unmatched (${unmatched.rows.length})</h2>
    <p class="muted">Airtime that arrived with no quote waiting for it. Match each one to the transfer it was meant for by typing the reference, or leave it here.</p>
    ${unmatched.rows.length === 0 ? html`<p class="muted">Nothing unmatched.</p>` : ""}
    ${unmatched.rows.map(
      (n) => html`<form method="post" action="/admin/inbound/${n.id}/attach" class="panel">${csrf(req)}
        <strong>${money(n.amount_kobo)} on ${n.network_code}</strong> from ${n.sender_number} to ${n.receiving_number}, ${when(n.received_at)}, via ${n.source}
        <p><code>${n.raw_text}</code></p>
        <div class="row"><div><label for="ref-${n.id}">Transfer reference</label><input id="ref-${n.id}" name="reference" type="text" placeholder="TX-..." required></div>
        <div><label>&nbsp;</label><button type="submit">Match to this transfer</button></div></div>
      </form>`,
    )}
    <h2>All airtime received</h2>
    <div class="scroll"><table>
      <tr><th>When</th><th>Network</th><th>From</th><th class="num">Amount</th><th>Via</th><th>Transfer</th></tr>
      ${recent.rows.slice(0, PAGE).map(
        (n) => html`<tr><td>${when(n.received_at)}</td><td>${n.network_code}</td><td>${n.sender_number}</td><td class="num">${money(n.amount_kobo)}</td><td>${n.source}</td>
          <td>${n.reference ? html`<a href="/admin/transfers/${n.transfer_id}">${n.reference}</a>` : html`<span class="muted">unmatched</span>`}</td></tr>`,
      )}
      ${recent.rows.length === 0 ? html`<tr><td colspan="6" class="muted">Nothing yet.</td></tr>` : ""}
    </table></div>
    ${pager("/admin/inbound?", pageNo, hasMore)}`;
  return { kind: "html", status, body: page({ title: "Airtime in", admin: req.admin, current: "/admin/inbound", body }) };
}

export function registerInbound(app: App): void {
  app.get("/admin/inbound", (req, db) => inboundPage(req, db));

  app.post("/admin/inbound", async (req, db) => {
    try {
      const network = requiredField(req.form, "network", "Network");
      const dataText = (req.form.get("data") ?? "").trim();
      let amountKobo: number;
      let dataMb: number | undefined;
      if (dataText !== "") {
        dataMb = parseSizeMb(dataText);
        if (!dataMb) throw new UserFacingError("bad_size", "Write the data size like 1GB or 500MB.");
        const bundle = (await db.query<{ price_kobo: number }>("SELECT price_kobo FROM data_bundles WHERE network_code = $1 AND size_mb = $2 AND giftable AND active ORDER BY price_kobo LIMIT 1", [network.toUpperCase(), dataMb])).rows[0];
        if (!bundle) throw new UserFacingError("no_bundle", `No giftable ${network.toUpperCase()} bundle of ${dataText} is in the catalogue, so it cannot be valued. Add one under Data bundles first.`);
        amountKobo = bundle.price_kobo;
      } else amountKobo = nairaField(req.form, "amount", "Airtime amount");
      const outcome = await withActor(actor(req.admin), (c) =>
        recordInbound(c, actor(req.admin), {
          networkCode: network,
          receivingNumber: requiredField(req.form, "receiving", "Our number"),
          senderNumber: requiredField(req.form, "sender", "Sender's number"),
          amountKobo,
          rawText: requiredField(req.form, "raw", "The network's message"),
          source: "manual",
          dataMb,
        }),
        db,
      );
      const msg =
        outcome.outcome === "matched"
          ? notice("ok", html`Recorded and matched to <a href="/admin/transfers/${outcome.transfer.id}">${outcome.transfer.reference}</a>. It is now waiting for payout.`)
          : outcome.outcome === "held"
            ? notice("info", html`Recorded and matched to <a href="/admin/transfers/${outcome.transfer.id}">${outcome.transfer.reference}</a>, but held: ${outcome.reason.replaceAll("_", " ")}. Open it to decide.`)
            : outcome.outcome === "duplicate"
              ? notice("info", "That exact message was already recorded, so nothing was added.")
              : notice("info", "Recorded. No transfer was waiting for it, so it is in the unmatched list below.");
      return inboundPage(req, db, msg);
    } catch (err) {
      if (err instanceof UserFacingError) return inboundPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/inbound/:id/attach", async (req, db) => {
    try {
      const reference = requiredField(req.form, "reference", "Transfer reference");
      const t = await getTransferByReference(db, reference);
      if (!t) throw new UserFacingError("no_such_transfer", `There is no transfer with reference ${reference.toUpperCase()}.`);
      const updated = await withActor(actor(req.admin), (c) => attachNotification(c, actor(req.admin), Number(req.query.get("id")), t.id), db);
      return inboundPage(req, db, notice("ok", html`Matched to <a href="/admin/transfers/${updated.id}">${updated.reference}</a>, now ${updated.state.replaceAll("_", " ")}.`));
    } catch (err) {
      if (err instanceof UserFacingError) return inboundPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });
}
