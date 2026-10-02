import type pg from "pg";
import { describeBundle, getBundle, listBundles, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { createOrder, getOrderByReference, priceFor, recordPayment, type Order } from "../orders.ts";
import { getCreditNote, spendCredit } from "../sellbacks.ts";
import { describeMethods, type PaymentGateway, type Verification } from "../payments/gateway.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Response } from "../web/http.ts";
import { mask, referringAgent, shell, tooManyQuotes } from "./pages.ts";
import { topUpWallet } from "../agents.ts";

const NAMES: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };

export type PaymentOptions = { gateway?: PaymentGateway | undefined; publicBaseUrl: string };

type Values = { network?: string; number?: string; amount?: string; email?: string; bundle?: string };

async function buyPage(db: pg.Pool, values: Values = {}, problem?: Html, status = 200): Promise<Response> {
  const [enabled, min, max, discounts] = await getSettingValues(db, ["retail.enabled", "retail.min_kobo", "retail.max_kobo", "retail.discount_basis_points"] as const);
  if (!enabled) {
    return { kind: "html", status: 404, body: shell("Not open", html`${notice("info", html`Buying airtime is not open yet. You can still <a href="/">move airtime between networks</a>.`)}`) };
  }
  const deals = NETWORK_CODES.filter((c) => discounts[c] > 0);
  const bundles = await listBundles(db, { activeOnly: true });
  const byNetwork = new Map<string, Bundle[]>();
  for (const b of bundles) byNetwork.set(b.network_code, [...(byNetwork.get(b.network_code) ?? []), b]);
  const body = html`<h1>Buy airtime for any network</h1>
    <p>Pay by bank transfer, card or USSD and the airtime lands on the number you choose. From ${formatNaira(min)} to ${formatNaira(max)}.</p>
    ${deals.length ? html`<p class="deal">Today: ${deals.map((c) => `${NAMES[c]} airtime at ${(discounts[c] / 100).toFixed(discounts[c] % 100 === 0 ? 0 : 2)} percent off`).join(", ")}.</p>` : ""}
    <form method="post" action="/buy" class="panel">
      ${problem ?? ""}
      <div class="field"><label for="number">Number to top up</label><input id="number" name="number" type="tel" inputmode="tel" required value="${values.number ?? ""}" data-network="network"></div>
      <div class="field"><label for="network">Its network</label><select id="network" name="network" required>
        <option value="" ${!values.network ? "selected" : ""}>Choose network</option>
        ${NETWORK_CODES.map((c) => html`<option value="${c}" ${c === values.network ? "selected" : ""}>${NAMES[c]}${discounts[c] > 0 ? ` (${(discounts[c] / 100).toFixed(discounts[c] % 100 === 0 ? 0 : 2)} percent off)` : ""}</option>`)}
      </select></div>
      <div class="field"><label for="amount">Airtime amount, in naira ${bundles.length > 0 ? html`<span class="muted">(leave empty to buy a bundle)</span>` : ""}</label><input id="amount" name="amount" type="text" inputmode="numeric" value="${values.amount ?? ""}" placeholder="500"></div>
      ${bundles.length > 0
        ? html`<div class="field"><label for="bundle">Or a data bundle</label><select id="bundle" name="bundle"><option value="" ${!values.bundle ? "selected" : ""}>No bundle, airtime only</option>
            ${[...byNetwork.entries()].map(([net, list]) => html`<optgroup label="${NAMES[net as NetworkCode]}">${list.map((b) => html`<option value="${b.id}" ${String(b.id) === values.bundle ? "selected" : ""}>${describeBundle(b)}</option>`)}</optgroup>`)}</select></div>`
        : ""}
      <div class="field"><label for="email">Email for a receipt <span class="muted">(optional)</span></label><input id="email" name="email" type="email" value="${values.email ?? ""}"></div>
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">See the price and pay</button>
    </form>
    <script src="/static/public.js" defer></script>`;
  return { kind: "html", status, body: shell("Buy airtime", body) };
}

async function orderPage(db: pg.Pool, o: Order, options: PaymentOptions, message?: Html, status = 200): Promise<Response> {
  const [bankName, accountNumber, accountName, methods] = await getSettingValues(db, ["retail.bank_name", "retail.bank_account_number", "retail.bank_account_name", "retail.payment_methods"] as const);
  const bundle = o.bundle_id ? await getBundle(db, o.bundle_id) : undefined;
  const item = bundle ? `the bundle ${bundle.name}` : `${formatNaira(o.face_kobo)} of ${NAMES[o.network_code]} airtime`;
  const bank = bankName && accountNumber && accountName ? { bankName, accountNumber, accountName } : undefined;
  const net = NAMES[o.network_code];
  let main: Html;
  let refresh: number | undefined;
  switch (o.state) {
    case "awaiting_payment":
    case "expired": {
      const expired = o.state === "expired" || new Date(o.expires_at).getTime() < Date.now();
      main = html`${message ?? ""}
        ${expired ? notice("problem", html`The time to pay has passed. If you already paid by bank transfer, it will still be matched when it arrives. Otherwise <a href="/buy">start again</a>.`) : ""}
        <h1>Pay ${formatNaira(o.price_kobo)} for ${item}</h1>
        <p>For ${mask(o.recipient_number)}.${o.discount_kobo > 0 ? ` That is ${formatNaira(o.discount_kobo)} off.` : ""}</p>
        ${options.gateway && !expired
          ? html`<form method="post" action="/o/${o.reference}/pay"><button type="submit">Pay ${formatNaira(o.price_kobo)} by ${describeMethods(methods)}</button></form>
            <p class="muted">You will be taken to ${options.gateway.label}, who handle the payment, and brought back here.${methods.includes("card") ? " A card issued outside Nigeria works too; your own bank does the conversion." : ""}</p>`
          : ""}
        ${bank
          ? html`<h2>${options.gateway && !expired ? "Or pay by bank transfer" : "Pay by bank transfer"}</h2>
            <p>Transfer exactly <strong>${formatNaira(o.price_kobo)}</strong> to:</p>
            <dl class="ref"><dt>Bank</dt><dd>${bank.bankName}</dd><dt>Account number</dt><dd><strong>${bank.accountNumber}</strong></dd><dt>Account name</dt><dd>${bank.accountName}</dd><dt>Narration or remark</dt><dd><strong>${o.reference}</strong></dd></dl>
            <p>Put the reference in the narration so we can match your transfer. We confirm bank transfers by hand during the day, so this can take a little longer than paying online.</p>`
          : ""}
        ${expired
          ? ""
          : html`<h2>${options.gateway || bank ? "Or pay with a credit code" : "Pay with a credit code"}</h2>
            <p>If you have sold us airtime or data, the code we gave you can pay for this.</p>
            <form method="post" action="/o/${o.reference}/credit" class="panel">
              <div class="field"><label for="code">Your credit code</label><input id="code" name="code" type="text" required autocapitalize="characters" placeholder="CR-ABCD234567"></div>
              <button type="submit" class="secondary">Pay ${formatNaira(o.price_kobo)} with my credit</button></form>`}
        ${!options.gateway && !bank ? notice("info", "Paying by card or bank transfer is not set up yet. A credit code still works.") : ""}`;
      refresh = 30;
      break;
    }
    case "paid":
    case "delivering":
      main = html`${notice("ok", html`${o.payment_method === "credit" ? `Paid with credit code ${o.credit_code}.` : `Payment of ${formatNaira(o.paid_kobo!)} received.`}`)}<h1>Sending ${item} to ${mask(o.recipient_number)}</h1><p>This usually takes a minute. This page updates itself.</p>`;
      refresh = 20;
      break;
    case "delivered":
      main = html`${notice("ok", html`Done. ${item.charAt(0).toUpperCase() + item.slice(1)} was sent to ${mask(o.recipient_number)}.`)}<h1>Order complete</h1><p><a class="button" href="/buy">Buy more</a></p>`;
      break;
    case "delivery_failed":
    case "held":
      main = html`${notice("info", html`We have your payment and a person is looking at this order.`)}<h1>Being checked</h1><p>${o.hold_reason === "underpaid" ? `The amount received (${formatNaira(o.paid_kobo!)}) was less than the price. It will be refunded.` : "The airtime could not be delivered on the first try. It will be sent, or your money returned. Nothing is lost."} Keep this reference: ${o.reference}.</p>`;
      refresh = 60;
      break;
    case "refunded":
      main = html`${notice("info", html`${formatNaira(o.refunded_kobo!)} has been returned to you.`)}<h1>Refunded</h1>`;
      break;
    case "cancelled":
      main = html`${notice("info", "This order was cancelled and nothing was paid.")}<h1>Cancelled</h1><p><a href="/buy">Start again</a></p>`;
      break;
  }
  const body = html`${main}<dl class="ref"><dt>Reference</dt><dd><strong>${o.reference}</strong></dd></dl>`;
  return { kind: "html", status, body: shell("Your order", body, refresh ? { refreshSeconds: refresh } : {}) };
}

export function registerBuy(app: App, options: PaymentOptions): void {
  app.get("/buy", async (_req, db) => buyPage(db), false);

  app.post(
    "/buy",
    async (req, db) => {
      const values: Values = { network: req.form.get("network") ?? "", number: req.form.get("number") ?? "", amount: req.form.get("amount") ?? "", email: req.form.get("email") ?? "", bundle: req.form.get("bundle") ?? "" };
      if ((req.form.get("website") ?? "") !== "") return buyPage(db, values, notice("problem", "Something went wrong with the form. Please try again."), 400);
      const bundleId = values.bundle ? Number(values.bundle) : undefined;
      const face = bundleId ? undefined : parseNaira(values.amount ?? "");
      if (!bundleId && face === undefined) return buyPage(db, values, notice("problem", "Enter the amount in naira, like 500, or pick a bundle."), 400);
      if (tooManyQuotes(`buy:${req.ip}`)) return buyPage(db, values, notice("problem", "You have started several orders in the last few minutes. Pay for one of them, or wait ten minutes."), 429);
      try {
        const agentId = await referringAgent(req, db);
        const order = await withActor("buyer", (c) => createOrder(c, "buyer", { network: values.network ?? "", recipientNumber: values.number ?? "", faceKobo: face, bundleId, email: values.email, agentId }), db);
        return { kind: "redirect", to: `/o/${order.reference}` };
      } catch (err) {
        if (err instanceof UserFacingError) return buyPage(db, values, notice("problem", err.message), 400);
        throw err;
      }
    },
    false,
  );

  app.get(
    "/o/:reference",
    async (req, db) => {
      const o = await getOrderByReference(db, req.query.get("reference") ?? "");
      if (!o) return { kind: "html", status: 404, body: shell("Not found", html`${notice("problem", html`There is no order with that reference. <a href="/buy">Start a new one</a>.`)}`) };
      return orderPage(db, o, options);
    },
    false,
  );

  // Paying with a credit code somebody was given for airtime or data they
  // sold us. The code is drawn down and the order is paid, both inside one
  // transaction, so a code can never be spent without the order being paid.
  app.post(
    "/o/:reference/credit",
    async (req, db) => {
      const o = await getOrderByReference(db, req.query.get("reference") ?? "");
      if (!o) return { kind: "redirect", to: "/buy" };
      const code = (req.form.get("code") ?? "").trim().toUpperCase();
      try {
        if (o.state !== "awaiting_payment" && o.state !== "expired") throw new UserFacingError("already_paid", "This order is not waiting for payment.");
        await withActor("credit", async (c) => {
          const note = await spendCredit(c, code, o.price_kobo);
          // The reference carries the order as well as the code, because a
          // code may pay for more than one purchase and one payment may
          // only ever pay one order.
          const paid = await recordPayment(c, "credit", o.id, { method: "credit", reference: `${note.code}:${o.reference}`, paidKobo: o.price_kobo, feeKobo: 0, cashAccount: "owed:sellers" });
          if (paid.outcome === "already") throw new UserFacingError("already_paid", "This order had already been paid, so your code was not touched.");
          await c.query("UPDATE orders SET credit_code = $2 WHERE id = $1", [o.id, note.code]);
        }, db);
        return { kind: "redirect", to: `/o/${o.reference}` };
      } catch (err) {
        if (err instanceof UserFacingError) {
          const left = await getCreditNote(db, code);
          return orderPage(db, o, options, notice("problem", left ? `${err.message}${left.state === "open" && left.remaining_kobo > 0 ? ` The code still holds ${formatNaira(left.remaining_kobo)}.` : ""}` : err.message), 400);
        }
        throw err;
      }
    },
    false,
  );

  // Sends the buyer to the gateway. Our own reference is the gateway's too,
  // so whatever comes back can be matched without a lookup table.
  app.post(
    "/o/:reference/pay",
    async (req, db) => {
      const o = await getOrderByReference(db, req.query.get("reference") ?? "");
      if (!o) return { kind: "redirect", to: "/buy" };
      const gateway = options.gateway;
      if (!gateway) return orderPage(db, o, options, notice("problem", "Paying online is not set up. Use the bank transfer details below."));
      if (o.state !== "awaiting_payment") return { kind: "redirect", to: `/o/${o.reference}` };
      try {
        const { url } = await gateway.initialize({
          reference: o.reference,
          amountKobo: o.price_kobo,
          email: o.buyer_email ?? `buyer-${o.recipient_number}@${new URL(options.publicBaseUrl).hostname}`,
          callbackUrl: `${options.publicBaseUrl}/payments/${gateway.name}/callback`,
          methods: await getSettingValue(db, "retail.payment_methods"),
        });
        return { kind: "redirect", to: url };
      } catch (err) {
        // The reason is for us, not for the visitor: it can name the
        // gateway, the address we call and part of their answer.
        console.error(`${gateway.name} initialize failed`, err);
        return orderPage(db, o, options, notice("problem", "Paying online did not start. Try again in a minute, or pay by bank transfer below."));
      }
    },
    false,
  );

  // The buyer comes back from the gateway. The redirect proves nothing, and
  // neither do the figures in it: the result is read from the gateway itself
  // before anything is recorded. Paystack sends the reference back as
  // "reference" or "trxref", Flutterwave as "tx_ref".
  app.get(
    "/payments/:provider/callback",
    async (req, db) => {
      const gateway = options.gateway;
      if (!gateway || req.query.get("provider") !== gateway.name) return { kind: "redirect", to: "/buy" };
      const reference = req.query.get("reference") ?? req.query.get("trxref") ?? req.query.get("tx_ref") ?? "";
      if (reference.toUpperCase().startsWith("AT-")) {
        // Only ask the gateway about a top-up we are actually waiting on.
        // Otherwise anyone could make the server call it all day by inventing
        // references, and use up the rate limit real payments need.
        const waiting = await db.query("SELECT 1 FROM agent_topups WHERE reference = $1 AND state = 'started'", [reference.toUpperCase()]);
        if (waiting.rowCount) {
          const v = await gateway.verify(reference.toUpperCase());
          if (v.status === "success" && inNaira(v, gateway)) await settleAgentTopUp(db, reference.toUpperCase(), v.amountKobo, v.feesKobo, gateway);
        }
        return { kind: "redirect", to: "/agent/topup" };
      }
      const o = await getOrderByReference(db, reference);
      if (!o) return { kind: "redirect", to: "/buy" };
      if (o.state === "awaiting_payment") {
        const v = await gateway.verify(o.reference);
        if (v.status === "success" && inNaira(v, gateway)) {
          const actor = `${gateway.name}:callback`;
          await withActor(actor, (c) => recordPayment(c, actor, o.id, { method: gateway.name, reference: v.reference, paidKobo: v.amountKobo, feeKobo: v.feesKobo, cashAccount: gateway.cashAccount }), db);
        }
      }
      return { kind: "redirect", to: `/o/${o.reference}` };
    },
    false,
  );

  // The gateway tells us a charge settled. Three things happen before a naira
  // moves: the signature has to be right, the event is recorded once so the
  // same one cannot be acted on twice, and the amount is read back from the
  // gateway rather than believed from the body.
  //
  // That last one is not caution for its own sake. Flutterwave's header is a
  // fixed secret we chose, not a signature over the body, so anybody who ever
  // sees one header could otherwise post any figure they liked.
  app.post(
    "/payments/:provider/webhook",
    async (req, db) => {
      const gateway = options.gateway;
      if (!gateway || req.query.get("provider") !== gateway.name) return { kind: "json", status: 404, body: { error: "No payment gateway is set up for that address." } };
      const sent = gateway.signatureHeaders.map((h) => req.raw.headers[h]).find((v) => typeof v === "string") as string | undefined;
      if (!gateway.verifySignature(req.rawBody, sent)) {
        return { kind: "json", status: 401, body: { error: "The signature does not match." } };
      }
      let read: { type: string; reference: string };
      try {
        read = gateway.readWebhook(req.rawBody);
      } catch {
        return { kind: "json", status: 400, body: { error: "The body is not JSON." } };
      }
      const { type, reference } = read;
      const inserted = await db.query<{ id: number }>(
        "INSERT INTO payment_events (provider, event_type, provider_reference, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [gateway.name, type, reference, req.rawBody],
      );
      if (!inserted.rows[0]) return { kind: "json", body: { ok: true, outcome: "already seen" } };
      const outcome = await actOnWebhook(db, gateway, type, reference);
      await db.query("UPDATE payment_events SET outcome = $2 WHERE id = $1", [inserted.rows[0].id, outcome]);
      return { kind: "json", body: { ok: true, outcome } };
    },
    false,
  );
}

// What a webhook means, once its reference is known. Only a charge that the
// gateway itself confirms, in naira, moves money; everything else is recorded
// with a word saying why it did not.
async function actOnWebhook(db: pg.Pool, gateway: PaymentGateway, type: string, reference: string): Promise<string> {
  // Refunds, chargebacks and the rest are kept and not acted on. Each would
  // need its own thinking, and guessing at one is worse than waiting.
  if (type !== "charge.success" && type !== "charge.completed") return "ignored";
  if (!reference) return "no reference";
  const upper = reference.toUpperCase();
  const isTopUp = upper.startsWith("AT-");
  const order = isTopUp ? undefined : await getOrderByReference(db, reference);
  if (!isTopUp && !order) return "no such order";
  const v = await gateway.verify(reference);
  if (v.status !== "success") return `${gateway.label} says the charge is ${v.status}`;
  if (!inNaira(v, gateway)) return `charged in ${v.currency}, not naira`;
  if (isTopUp) return (await settleAgentTopUp(db, upper, v.amountKobo, v.feesKobo, gateway)) ? "paid" : "already";
  const actor = `${gateway.name}:webhook`;
  const r = await withActor(actor, (c) => recordPayment(c, actor, order!.id, { method: gateway.name, reference: v.reference, paidKobo: v.amountKobo, feeKobo: v.feesKobo, cashAccount: gateway.cashAccount }), db);
  return r.outcome;
}

// We price in naira and ask the gateway for naira. A charge that comes back in
// anything else is not booked: the figures would not mean what every other
// part of this system assumes, and a wrong currency is a thing for a person to
// look at rather than for code to convert on a guess.
function inNaira(v: Verification, gateway: PaymentGateway): boolean {
  if (v.currency === "NGN" || v.currency === "") return true;
  console.error(`${gateway.name} charge ${v.reference} came back in ${v.currency}, not NGN; nothing was booked`);
  return false;
}

// An agent's online wallet top-up has settled. Claims the top-up row once
// and credits the wallet with what was actually paid.
export async function settleAgentTopUp(db: pg.Pool, reference: string, paidKobo: number, feeKobo: number, gateway: PaymentGateway): Promise<boolean> {
  return withActor(gateway.name, async (c) => {
    const row = (await c.query<{ agent_id: number }>("UPDATE agent_topups SET state = 'paid', paid_at = now() WHERE reference = $1 AND state = 'started' RETURNING agent_id", [reference])).rows[0];
    if (!row) return false;
    await topUpWallet(c, row.agent_id, { reference, paidKobo, feeKobo, cashAccount: gateway.cashAccount, method: gateway.name });
    return true;
  }, db);
}

export { priceFor };
