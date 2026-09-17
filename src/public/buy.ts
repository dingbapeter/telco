import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { createOrder, getOrderByReference, priceFor, recordPayment, type Order } from "../orders.ts";
import type { PaystackProvider } from "../payments/paystack.ts";
import { getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Response } from "../web/http.ts";
import { mask, shell, tooManyQuotes } from "./pages.ts";

const NAMES: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };

export type PaymentOptions = { paystack?: PaystackProvider | undefined; publicBaseUrl: string };

type Values = { network?: string; number?: string; amount?: string; email?: string };

async function buyPage(db: pg.Pool, values: Values = {}, problem?: Html, status = 200): Promise<Response> {
  const [enabled, min, max, discounts] = await getSettingValues(db, ["retail.enabled", "retail.min_kobo", "retail.max_kobo", "retail.discount_basis_points"] as const);
  if (!enabled) {
    return { kind: "html", status: 404, body: shell("Not open", html`${notice("info", html`Buying airtime is not open yet. You can still <a href="/">move airtime between networks</a>.`)}`) };
  }
  const deals = NETWORK_CODES.filter((c) => discounts[c] > 0);
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
      <div class="field"><label for="amount">Airtime amount, in naira</label><input id="amount" name="amount" type="text" inputmode="numeric" required value="${values.amount ?? ""}" placeholder="500"></div>
      <div class="field"><label for="email">Email for a receipt <span class="muted">(optional)</span></label><input id="email" name="email" type="email" value="${values.email ?? ""}"></div>
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">See the price and pay</button>
    </form>
    <script src="/static/public.js" defer></script>`;
  return { kind: "html", status, body: shell("Buy airtime", body) };
}

async function orderPage(db: pg.Pool, o: Order, options: PaymentOptions, message?: Html): Promise<Response> {
  const [bankName, accountNumber, accountName] = await getSettingValues(db, ["retail.bank_name", "retail.bank_account_number", "retail.bank_account_name"] as const);
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
        <h1>Pay ${formatNaira(o.price_kobo)} for ${formatNaira(o.face_kobo)} of ${net} airtime</h1>
        <p>For ${mask(o.recipient_number)}.${o.discount_kobo > 0 ? ` That is ${formatNaira(o.discount_kobo)} off.` : ""}</p>
        ${options.paystack && !expired
          ? html`<form method="post" action="/o/${o.reference}/pay"><button type="submit">Pay ${formatNaira(o.price_kobo)} by card, bank or USSD</button></form>
            <p class="muted">You will be taken to Paystack, who handle the payment, and brought back here.</p>`
          : ""}
        ${bank
          ? html`<h2>${options.paystack && !expired ? "Or pay by bank transfer" : "Pay by bank transfer"}</h2>
            <p>Transfer exactly <strong>${formatNaira(o.price_kobo)}</strong> to:</p>
            <dl class="ref"><dt>Bank</dt><dd>${bank.bankName}</dd><dt>Account number</dt><dd><strong>${bank.accountNumber}</strong></dd><dt>Account name</dt><dd>${bank.accountName}</dd><dt>Narration or remark</dt><dd><strong>${o.reference}</strong></dd></dl>
            <p>Put the reference in the narration so we can match your transfer. We confirm bank transfers by hand during the day, so this can take a little longer than paying online.</p>`
          : ""}
        ${!options.paystack && !bank ? notice("problem", "No way to pay is set up yet. Come back later.") : ""}`;
      refresh = 30;
      break;
    }
    case "paid":
    case "delivering":
      main = html`${notice("ok", html`Payment of ${formatNaira(o.paid_kobo!)} received.`)}<h1>Sending ${formatNaira(o.face_kobo)} of ${net} airtime to ${mask(o.recipient_number)}</h1><p>This usually takes a minute. This page updates itself.</p>`;
      refresh = 20;
      break;
    case "delivered":
      main = html`${notice("ok", html`Done. ${formatNaira(o.face_kobo)} of ${net} airtime was sent to ${mask(o.recipient_number)}.`)}<h1>Order complete</h1><p><a class="button" href="/buy">Buy more</a></p>`;
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
  return { kind: "html", body: shell("Your order", body, refresh ? { refreshSeconds: refresh } : {}) };
}

export function registerBuy(app: App, options: PaymentOptions): void {
  app.get("/buy", async (_req, db) => buyPage(db), false);

  app.post(
    "/buy",
    async (req, db) => {
      const values: Values = { network: req.form.get("network") ?? "", number: req.form.get("number") ?? "", amount: req.form.get("amount") ?? "", email: req.form.get("email") ?? "" };
      if ((req.form.get("website") ?? "") !== "") return buyPage(db, values, notice("problem", "Something went wrong with the form. Please try again."), 400);
      const face = parseNaira(values.amount ?? "");
      if (face === undefined) return buyPage(db, values, notice("problem", "Enter the amount in naira, like 500."), 400);
      if (tooManyQuotes(`buy:${req.ip}`)) return buyPage(db, values, notice("problem", "You have started several orders in the last few minutes. Pay for one of them, or wait ten minutes."), 429);
      try {
        const order = await withActor("buyer", (c) => createOrder(c, "buyer", { network: values.network ?? "", recipientNumber: values.number ?? "", faceKobo: face, email: values.email }), db);
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

  // Sends the buyer to Paystack. Our order reference is Paystack's too, so
  // whatever comes back can be matched without a lookup table.
  app.post(
    "/o/:reference/pay",
    async (req, db) => {
      const o = await getOrderByReference(db, req.query.get("reference") ?? "");
      if (!o) return { kind: "redirect", to: "/buy" };
      if (!options.paystack) return orderPage(db, o, options, notice("problem", "Paying online is not set up. Use the bank transfer details below."));
      if (o.state !== "awaiting_payment") return { kind: "redirect", to: `/o/${o.reference}` };
      try {
        const { url } = await options.paystack.initialize({
          reference: o.reference,
          amountKobo: o.price_kobo,
          email: o.buyer_email ?? `buyer-${o.recipient_number}@${new URL(options.publicBaseUrl).hostname}`,
          callbackUrl: `${options.publicBaseUrl}/payments/paystack/callback`,
        });
        return { kind: "redirect", to: url };
      } catch (err) {
        return orderPage(db, o, options, notice("problem", `Paying online did not start: ${(err as Error).message}. Try again in a minute, or pay by bank transfer below.`));
      }
    },
    false,
  );

  // The buyer comes back from Paystack. The redirect proves nothing; the
  // result is read from Paystack before anything is recorded.
  app.get(
    "/payments/paystack/callback",
    async (req, db) => {
      const reference = req.query.get("reference") ?? req.query.get("trxref") ?? "";
      const o = await getOrderByReference(db, reference);
      if (!o) return { kind: "redirect", to: "/buy" };
      if (options.paystack && o.state === "awaiting_payment") {
        const v = await options.paystack.verify(o.reference);
        if (v.status === "success") {
          await withActor("paystack:callback", (c) => recordPayment(c, "paystack:callback", o.id, { method: "paystack", reference: v.reference, paidKobo: v.amountKobo, feeKobo: v.feesKobo, cashAccount: options.paystack!.cashAccount }), db);
        }
      }
      return { kind: "redirect", to: `/o/${o.reference}` };
    },
    false,
  );

  // Paystack tells us a charge settled. Believed only with a valid
  // signature, recorded once per event, and never re-booked.
  app.post(
    "/payments/paystack/webhook",
    async (req, db) => {
      if (!options.paystack) return { kind: "json", status: 404, body: { error: "Paystack is not set up." } };
      if (!options.paystack.verifySignature(req.rawBody, req.raw.headers["x-paystack-signature"] as string | undefined)) {
        return { kind: "json", status: 401, body: { error: "The signature does not match." } };
      }
      let event: { event?: string; data?: { reference?: string; amount?: number; fees?: number | null; status?: string } };
      try {
        event = JSON.parse(req.rawBody) as typeof event;
      } catch {
        return { kind: "json", status: 400, body: { error: "The body is not JSON." } };
      }
      const type = event.event ?? "";
      const reference = event.data?.reference ?? "";
      const inserted = await db.query<{ id: number }>(
        "INSERT INTO payment_events (provider, event_type, provider_reference, payload) VALUES ('paystack', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [type, reference, req.rawBody],
      );
      if (!inserted.rows[0]) return { kind: "json", body: { ok: true, outcome: "already seen" } };
      let outcome = "ignored";
      if (type === "charge.success" && reference) {
        const o = await getOrderByReference(db, reference);
        if (o) {
          const r = await withActor("paystack:webhook", (c) => recordPayment(c, "paystack:webhook", o.id, { method: "paystack", reference, paidKobo: Number(event.data?.amount ?? 0), feeKobo: Number(event.data?.fees ?? 0), cashAccount: options.paystack!.cashAccount }), db);
          outcome = r.outcome;
        } else outcome = "no such order";
      }
      await db.query("UPDATE payment_events SET outcome = $2 WHERE id = $1", [inserted.rows[0].id, outcome]);
      return { kind: "json", body: { ok: true, outcome } };
    },
    false,
  );
}

export { priceFor };
