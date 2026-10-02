import type pg from "pg";
import { describeBundle, getBundle, listBundles, takeableBundles, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { getSellbackByReference, percentOf as share, quoteSellback, rateFor, type Sellback } from "../sellbacks.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Response } from "../web/http.ts";
import { dialInstruction, mask, nairaDigits, shell, tooManyQuotes } from "./pages.ts";

const NAMES: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };

type Values = { network?: string; number?: string; amount?: string; bundle?: string; outcome?: string; bank?: string };

// What we are paying on each network today, worked out the same way the
// quote is, so the page can never promise a rate the quote would refuse.
async function board(db: pg.Pool): Promise<{ network: NetworkCode; airtime: number | null; data: number | null }[]> {
  const out: { network: NetworkCode; airtime: number | null; data: number | null }[] = [];
  for (const network of NETWORK_CODES) {
    const airtime = await rateFor(db, network, "airtime");
    const data = await rateFor(db, network, "data");
    out.push({ network, airtime: airtime.ok ? airtime.rate : null, data: data.ok ? data.rate : null });
  }
  return out;
}



async function sellPage(db: pg.Pool, values: Values = {}, problem?: Html, status = 200): Promise<Response> {
  const [airtimeOn, dataOn, cashOn, min, max, cashCap] = await getSettingValues(db, [
    "sellback.airtime_enabled",
    "sellback.data_enabled",
    "sellback.cash_enabled",
    "sellback.min_kobo",
    "sellback.max_kobo",
    "sellback.cash_daily_cap_kobo",
  ] as const);
  if (!airtimeOn && !dataOn) {
    return { kind: "html", status: 404, body: shell("Not open", html`${notice("info", html`We are not buying airtime or data at the moment. You can still <a href="/">move airtime between networks</a> or <a href="/buy">buy airtime</a>.`)}`) };
  }
  const rates = await board(db);
  const buying = rates.filter((r) => (airtimeOn && r.airtime !== null) || (dataOn && r.data !== null));
  const cash = cashOn && cashCap > 0;
  const bundles = dataOn ? await takeableBundles(db) : [];
  const byNetwork = new Map<string, Bundle[]>();
  for (const b of bundles) byNetwork.set(b.network_code, [...(byNetwork.get(b.network_code) ?? []), b]);
  const body = html`<h1>Sell us airtime or data you cannot use</h1>
    <p>Send it to our number with your network's own code and take ${cash ? "credit to spend with us, or cash to your bank account" : "credit you can spend on airtime or data for any number, on any network"}. From ${formatNaira(min)} to ${formatNaira(max)} at a time.</p>
    ${buying.length === 0
      ? notice("info", "We are not buying on any network at this minute. Try again later.")
      : html`<div class="scroll"><table><tr><th>Network</th>${airtimeOn ? html`<th class="num">Airtime</th>` : ""}${dataOn ? html`<th class="num">Data</th>` : ""}</tr>
          ${rates.map((r) => html`<tr><td>${NAMES[r.network]}</td>
            ${airtimeOn ? html`<td class="num">${r.airtime === null ? "not buying" : share(r.airtime)}</td>` : ""}
            ${dataOn ? html`<td class="num">${r.data === null ? "not buying" : share(r.data)}</td>` : ""}</tr>`)}
        </table></div>
        <p class="muted">What you get, as a share of what the airtime or bundle is worth. N1,000 of airtime at 80 percent pays you N800.</p>`}
    <form method="post" action="/sell" class="panel">
      ${problem ?? ""}
      <div class="field"><label for="number">Your number, the one holding it</label>
        <input id="number" name="number" type="tel" inputmode="tel" autocomplete="tel" required value="${values.number ?? ""}" data-network="network"></div>
      <div class="field"><label for="network">Its network</label>
        <select id="network" name="network" required><option value="" ${!values.network ? "selected" : ""}>Choose network</option>
          ${NETWORK_CODES.map((c) => html`<option value="${c}" ${c === values.network ? "selected" : ""}>${NAMES[c]}</option>`)}</select></div>
      ${airtimeOn
        ? html`<div class="field"><label for="amount">Airtime to sell, in naira ${dataOn ? html`<span class="muted">(leave empty to sell data)</span>` : ""}</label>
            <input id="amount" name="amount" type="text" inputmode="numeric" value="${values.amount ?? ""}" placeholder="1000"></div>`
        : ""}
      ${bundles.length > 0
        ? html`<div class="field"><label for="bundle">Or a data bundle you hold</label>
            <select id="bundle" name="bundle"><option value="" ${!values.bundle ? "selected" : ""}>No bundle, airtime only</option>
              ${[...byNetwork.entries()].map(([net, list]) => html`<optgroup label="${NAMES[net as NetworkCode]}">${list.map((b) => html`<option value="${b.id}" ${String(b.id) === values.bundle ? "selected" : ""}>${describeBundle(b)}</option>`)}</optgroup>`)}</select>
            <span class="muted">Only bundles your network lets you gift to another number can be sold to us.</span></div>`
        : ""}
      ${cash
        ? html`<div class="field"><label for="outcome">How you want paying</label>
            <select id="outcome" name="outcome">
              <option value="credit" ${values.outcome !== "cash" ? "selected" : ""}>Credit to spend with us</option>
              <option value="cash" ${values.outcome === "cash" ? "selected" : ""}>Cash to my bank account</option></select></div>
          <div class="field"><label for="bank">Bank, account number and account name <span class="muted">(only for cash)</span></label>
            <input id="bank" name="bank" type="text" value="${values.bank ?? ""}" placeholder="GTBank 0123456789 Ada Obi"></div>
          <p class="muted">Cash is sent by bank transfer by a person, after a short wait. Credit is yours the moment the airtime lands.</p>`
        : html`<input type="hidden" name="outcome" value="credit">
          <p class="muted">You are paid in credit: a code you spend on airtime or data for any number, on any network. It does not expire.</p>`}
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">See what we pay and how to send</button>
    </form>
    <h2 id="status">Check a sale</h2>
    <form method="post" action="/sell/status" class="panel">
      <div class="field"><label for="reference">Reference, like SB-ABCD2345</label><input id="reference" name="reference" type="text" required autocapitalize="characters"></div>
      <button type="submit" class="secondary">Check</button></form>
    <script src="/static/public.js" defer></script>`;
  return { kind: "html", status, body: shell("Sell airtime or data", body) };
}

async function statusPage(db: pg.Pool, s: Sellback, message?: Html): Promise<Response> {
  const [codes, giftCodes, holdHours] = await Promise.all([
    getSettingValue(db, "network.transfer_code"),
    getSettingValue(db, "network.data_gift_code"),
    getSettingValue(db, "sellback.cash_hold_hours"),
  ]);
  const bundle = s.bundle_id ? await getBundle(db, s.bundle_id) : undefined;
  const net = NAMES[s.network_code];
  const { dial, shown, needsPin } = dialInstruction(s.kind === "data" ? giftCodes[s.network_code] : codes[s.network_code], {
    amountNaira: nairaDigits(s.face_kobo),
    number: s.receiving_number,
    size: bundle?.name ?? "",
  });
  const what = bundle ? `the bundle ${bundle.name}` : `${formatNaira(s.face_kobo)} of ${net} airtime`;
  const minutesLeft = Math.ceil((new Date(s.expires_at).getTime() - Date.now()) / 60_000);
  let main: Html;
  let refresh: number | undefined;
  switch (s.state) {
    case "awaiting_inbound":
    case "expired": {
      const over = s.state === "expired" || minutesLeft <= 0;
      main = html`${message ?? ""}
        ${over
          ? notice("problem", html`The time to send has passed and the rate is no longer held. If you have just sent it, reload this page in a minute; it will still be matched. Otherwise <a href="/sell">start again</a>.`)
          : notice("info", `Send within about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} to hold this rate. This page updates itself.`)}
        <h1>Send ${what} to our ${net} number <span class="big">${s.receiving_number}</span></h1>
        <p><strong>${s.receiving_number} is ours.</strong> Send from your own line ${mask(s.seller_number)}, using ${net}'s own ${s.kind === "data" ? "data gifting" : "airtime transfer"}. We pay <strong>${formatNaira(s.quoted_pay_kobo)}</strong> once the network tells us it landed.</p>
        ${dial
          ? html`<p class="dial-label">On your ${net} line, dial:</p>
            <p class="dial">${shown}</p>
            <p><button type="button" class="secondary copy" data-copy="${shown}">Copy the code</button></p>
            ${needsPin
              ? html`<p>Put your ${net} transfer PIN where it says PIN. We never ask for your PIN and you should never type it on a website.</p>`
              : html`<p class="android-only"><a class="button" href="tel:${encodeURIComponent(dial).replaceAll("%2A", "*")}">Open the dial pad with this code</a></p>
                <p class="iphone-only">On an iPhone, copy the code, open the Phone app, paste it into the keypad and press call.</p>`}`
          : html`<p>Open your ${net} ${s.kind === "data" ? "data gifting" : "airtime transfer"} menu and send ${what} to ${s.receiving_number}.</p>`}
        <p>${s.kind === "data"
          ? "Gift that exact bundle from the number you gave. A different bundle is kept for a person to look at."
          : "Send from the number you gave. If a different amount arrives we pay for what arrived, at the same rate."}</p>`;
      refresh = 20;
      break;
    }
    case "received":
      main = html`${notice("ok", `We have your ${formatNaira(s.received_kobo!)} of ${net} ${s.kind}.`)}
        <h1>${formatNaira(s.pay_kobo!)} is yours</h1>
        <p>You asked for cash to ${s.bank_details}. A person sends it by bank transfer${holdHours > 0 ? `, after a wait of about ${holdHours} hours from now, which is how we keep stolen lines out of this` : ""}. Keep this reference: ${s.reference}.</p>`;
      refresh = 120;
      break;
    case "settled":
      main = html`${notice("ok", `Done. ${formatNaira(s.pay_kobo!)} of credit is yours.`)}
        <h1>Your credit code</h1>
        <p class="dial">${s.credit_code}</p>
        <p>Spend it on airtime or data for any number, on any network, at <a href="/buy">buy airtime</a>. It does not expire, and what you do not spend stays on the code. Keep it somewhere safe: anybody holding the code can spend it.</p>
        <p><a class="button" href="/buy">Buy airtime or data now</a></p>`;
      break;
    case "paid":
      main = html`${notice("ok", `Paid. ${formatNaira(s.pay_kobo!)} was sent to ${s.bank_details}.`)}
        <h1>Sale complete</h1>
        <p>Bank reference ${s.payout_reference}. ${formatNaira(s.received_kobo!)} of ${net} ${s.kind} bought from ${mask(s.seller_number)}.</p>
        <p><a class="button" href="/sell">Sell again</a></p>`;
      break;
    case "held":
      main = html`${notice("info", `We have your ${formatNaira(s.received_kobo!)} of ${net} ${s.kind} and a person is looking at this sale.`)}
        <h1>Being checked</h1>
        <p>${s.hold_reason === "amount_below_minimum"
          ? `What arrived was less than the smallest amount we buy, so it will be sent back to your line.`
          : s.hold_reason === "amount_above_maximum"
            ? `What arrived was more than we buy at once, so it will be sent back to your line.`
            : explainSellerCap(s.hold_reason)
              ? `${explainSellerCap(s.hold_reason)}, so it will be sent back to your line in full.`
            : "A person will either pay you or send it back to your line. Nothing is lost."} Keep this reference: ${s.reference}.</p>`;
      refresh = 120;
      break;
    case "returning":
      main = html`${notice("info", `${formatNaira(s.received_kobo!)} of ${net} ${s.kind} is going back to your line ${mask(s.seller_number)}.`)}
        <h1>Being sent back</h1>
        <p>${explainSellerCap(s.hold_reason) ?? "We are not buying this one"}, so nothing is owed and nothing was taken off. You will see it on your line shortly. This page updates itself.</p>`;
      refresh = 60;
      break;
    case "returned":
      main = html`${notice("info", `${formatNaira(s.received_kobo!)} was sent back to your ${net} line ${mask(s.seller_number)}.`)}
        <h1>Sent back</h1>
        <p>Nothing was bought and nothing is owed.</p>`;
      break;
    case "cancelled":
      main = html`${notice("info", "This sale was cancelled and nothing was sent.")}<h1>Cancelled</h1><p><a href="/sell">Start again</a></p>`;
      break;
  }
  const body = html`${main}
    <dl class="ref"><dt>Reference</dt><dd><strong>${s.reference}</strong> <span class="muted">keep this to check on the sale</span></dd>
      <dt>Rate</dt><dd>${share(s.rate_basis_points)} of what it is worth</dd></dl>`;
  return { kind: "html", body: shell(s.state === "awaiting_inbound" ? "Send what you are selling" : "Your sale", body, refresh ? { refreshSeconds: refresh } : {}) };
}

// What a seller is told when a cap stopped the sale. The same caps as a
// sender's, said for somebody selling rather than sending.
function explainSellerCap(reason: string | null): string | undefined {
  switch (reason) {
    case "over_daily_limit":
      return "Your number has sold as much as one number may sell in a day";
    case "over_weekly_limit":
      return "Your number has sold as much as one number may sell in a week";
    case "over_daily_count":
      return "Your number has made as many sales as it may make today";
    case "over_weekly_count":
      return "Your number has made as many sales as it may make this week";
    case "amount_above_maximum":
      return "What arrived was more than we buy in one go";
    default:
      return undefined;
  }
}

export function registerSell(app: App): void {
  app.get("/sell", async (_req, db) => sellPage(db), false);

  app.post(
    "/sell",
    async (req, db) => {
      const values: Values = {
        network: req.form.get("network") ?? "",
        number: req.form.get("number") ?? "",
        amount: req.form.get("amount") ?? "",
        bundle: req.form.get("bundle") ?? "",
        outcome: req.form.get("outcome") ?? "credit",
        bank: req.form.get("bank") ?? "",
      };
      if ((req.form.get("website") ?? "") !== "") return sellPage(db, values, notice("problem", "Something went wrong with the form. Please try again."), 400);
      const bundleId = values.bundle ? Number(values.bundle) : undefined;
      const amount = bundleId ? undefined : parseNaira(values.amount ?? "");
      if (!bundleId && amount === undefined) return sellPage(db, values, notice("problem", "Enter the airtime amount in naira, like 1000, or pick a bundle you hold."), 400);
      // A seller asking for quote after quote would fill our numbers' room
      // for the day with sales that never arrive.
      if (tooManyQuotes(`sell:${values.number}`) || tooManyQuotes(`sellip:${req.ip}`)) {
        return sellPage(db, values, notice("problem", "You have started several sales in the last few minutes. Send one of them, or wait ten minutes."), 429);
      }
      try {
        const { sellback } = await withActor("seller", (c) =>
          quoteSellback(c, "seller", {
            network: values.network ?? "",
            sellerNumber: values.number ?? "",
            kind: bundleId ? "data" : "airtime",
            bundleId,
            amountKobo: amount,
            outcome: values.outcome === "cash" ? "cash" : "credit",
            bankDetails: values.bank,
          }), db);
        return { kind: "redirect", to: `/s/${sellback.reference}` };
      } catch (err) {
        if (err instanceof UserFacingError) return sellPage(db, values, notice("problem", err.message), 400);
        throw err;
      }
    },
    false,
  );

  app.get(
    "/s/:reference",
    async (req, db) => {
      const s = await getSellbackByReference(db, req.query.get("reference") ?? "");
      if (!s) return { kind: "html", status: 404, body: shell("Not found", html`${notice("problem", html`There is no sale with that reference. <a href="/sell">Start a new one</a>.`)}`) };
      return statusPage(db, s);
    },
    false,
  );

  app.post(
    "/sell/status",
    async (req, db) => {
      const s = await getSellbackByReference(db, req.form.get("reference") ?? "");
      if (!s) return sellPage(db, {}, notice("problem", "We have no sale with that reference. Check the letters and try again."), 404);
      return { kind: "redirect", to: `/s/${s.reference}` };
    },
    false,
  );
}
