import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { normaliseNigerianNumber, prefixOf } from "../phone.ts";
import { getSettingValue, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { getTransferByReference, quoteTransfer, type Transfer } from "../transfers.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Request, Response } from "../web/http.ts";

const NAMES: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };

const lagosTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" });

// The public pages are read on a phone over a weak connection, so each one
// is a few kilobytes of HTML and one cached stylesheet. No script is needed
// for anything; the one small script only fills in the network from the
// number as a convenience.
export function shell(title: string, body: Html, options: { refreshSeconds?: number } = {}): string {
  return (
    "<!doctype html>" +
    html`<html lang="en-NG">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${options.refreshSeconds ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
<title>${title} | Telco</title>
<link rel="stylesheet" href="/static/public.css">
</head>
<body>
<header class="top"><a class="brand" href="/">Telco</a><span class="tag">Move airtime between networks</span></header>
<main class="main">${body}</main>
<footer class="foot"><a href="/">Move airtime</a> · <a href="/buy">Buy airtime</a> · <a href="/#status">Check a transfer</a></footer>
</body>
</html>`.text
  );
}

// 08031234567 becomes 0803 *** 4567 on any page a link might be shared from.
export function mask(number: string): string {
  return `${number.slice(0, 4)} *** ${number.slice(-4)}`;
}

export async function networkForNumber(db: pg.Pool, number: string): Promise<NetworkCode | undefined> {
  const local = normaliseNigerianNumber(number);
  if (!local) return undefined;
  const { rows } = await db.query<{ network_code: NetworkCode }>("SELECT network_code FROM network_prefixes WHERE prefix = $1", [prefixOf(local)]);
  return rows[0]?.network_code;
}

// A sender can ask for a handful of quotes in a short time and no more, so
// nobody can fill the receiving numbers' daily room with quotes they never
// pay for. Per sending number and per address, in memory.
const recent = new Map<string, number[]>();
export const QUOTE_LIMIT = { count: 5, windowMs: 10 * 60_000 };
export function tooManyQuotes(key: string, now = Date.now()): boolean {
  const times = (recent.get(key) ?? []).filter((t) => now - t < QUOTE_LIMIT.windowMs);
  if (times.length >= QUOTE_LIMIT.count) {
    recent.set(key, times);
    return true;
  }
  times.push(now);
  recent.set(key, times);
  return false;
}
export function resetQuoteLimits(): void {
  recent.clear();
}

type FormValues = { from?: string; sender?: string; to?: string; recipient?: string; amount?: string };

function form(values: FormValues, problem?: Html): Html {
  const networkOptions = (selected: string | undefined) =>
    html`<option value="" ${!selected ? "selected" : ""}>Choose network</option>${NETWORK_CODES.map((c) => html`<option value="${c}" ${c === selected ? "selected" : ""}>${NAMES[c]}</option>`)}`;
  return html`<form method="post" action="/quote" class="panel" id="quote">
    ${problem ?? ""}
    <div class="field"><label for="sender">Your number, the one with the airtime</label>
      <input id="sender" name="sender" type="tel" inputmode="tel" autocomplete="tel" required value="${values.sender ?? ""}" data-network="from"></div>
    <div class="field"><label for="from">Its network</label>
      <select id="from" name="from" required>${networkOptions(values.from)}</select></div>
    <div class="field"><label for="recipient">Number to send airtime to</label>
      <input id="recipient" name="recipient" type="tel" inputmode="tel" required value="${values.recipient ?? ""}" data-network="to"></div>
    <div class="field"><label for="to">Its network</label>
      <select id="to" name="to" required>${networkOptions(values.to)}</select></div>
    <div class="field"><label for="amount">Amount of airtime to move, in naira</label>
      <input id="amount" name="amount" type="text" inputmode="decimal" required value="${values.amount ?? ""}" placeholder="500"></div>
    <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">See the fee and how to send</button>
  </form>
  <script src="/static/public.js" defer></script>`;
}

async function homePage(db: pg.Pool, values: FormValues = {}, problem?: Html, status = 200): Promise<Response> {
  const [percent, floor, ceiling, min, max] = await Promise.all([
    getSettingValue(db, "fee.percent_basis_points"),
    getSettingValue(db, "fee.floor_kobo"),
    getSettingValue(db, "fee.ceiling_kobo"),
    getSettingValue(db, "transfer.min_kobo"),
    getSettingValue(db, "transfer.max_kobo"),
  ]);
  const body = html`<h1>Airtime on one network. Use it on another.</h1>
    <p>Send airtime from your MTN, Airtel, Glo or 9mobile line to a number on a different network. You dial your own network's transfer code, we deliver the airtime on the other side, and a small fee comes out of the amount.</p>
    <ul class="facts">
      <li>Fee: ${(percent / 100).toFixed(percent % 100 === 0 ? 0 : 2)} percent, at least ${formatNaira(floor)} and at most ${formatNaira(ceiling)}.</li>
      <li>From ${formatNaira(min)} to ${formatNaira(max)} per transfer.</li>
      <li>No account, no card, no app. Just your phone's dial pad.</li>
    </ul>
    ${form(values, problem)}
    <h2 id="status">Check a transfer</h2>
    <form method="post" action="/status" class="panel">
      <div class="field"><label for="reference">Reference, like TX-ABCD2345</label><input id="reference" name="reference" type="text" required autocapitalize="characters"></div>
      <button type="submit" class="secondary">Check</button>
    </form>`;
  return { kind: "html", status, body: shell("Move airtime between networks", body) };
}

// The whole instruction in one screen: how much to dial, to which number,
// by when, and what the other side will get.
async function statusPage(db: pg.Pool, t: Transfer): Promise<Response> {
  const codes = await getSettingValue(db, "network.transfer_code");
  const code = codes[t.from_network];
  const amountNaira = t.requested_kobo % 100 === 0 ? String(t.requested_kobo / 100) : (t.requested_kobo / 100).toFixed(2);
  const dial = code ? code.replace("{amount}", amountNaira).replace("{number}", t.receiving_number) : "";
  const needsPin = dial.includes("{pin}");
  const shown = dial.replace("{pin}", "PIN");
  const from = NAMES[t.from_network];
  const to = NAMES[t.to_network];
  const payout = formatNaira(t.payout_kobo ?? t.quoted_payout_kobo);
  const pending = t.state === "awaiting_inbound";
  const deadline = lagosTime.format(new Date(t.expires_at));
  const minutesLeft = Math.ceil((new Date(t.expires_at).getTime() - Date.now()) / 60_000);
  const expired = minutesLeft <= 0;

  let main: Html;
  let refresh: number | undefined;
  switch (t.state) {
    case "awaiting_inbound":
    case "expired":
      main = html`
        ${t.state === "expired" || expired
          ? notice("problem", html`The time to send has passed. If you already sent the airtime, wait a few minutes and reload this page; it will still be matched. If not, <a href="/">start again</a>.`)
          : notice("info", html`Send before ${deadline} Lagos time, about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} from now. This page updates itself.`)}
        <h1>Now send ${formatNaira(t.requested_kobo)} of ${from} airtime to <span class="big">${t.receiving_number}</span></h1>
        <p>Use ${from}'s own airtime transfer from your line ${mask(t.sender_number)}. The recipient gets ${payout} on ${to} once it lands.</p>
        ${dial
          ? html`<p class="dial-label">On your ${from} line, dial:</p>
            <p class="dial">${shown}</p>
            ${needsPin ? html`<p>Put your ${from} transfer PIN where it says PIN. We never ask for your PIN and you should never type it on a website.</p>` : html`<p><a class="button" href="tel:${encodeURIComponent(dial).replaceAll("%2A", "*")}">Open the dial pad with this code</a></p>`}`
          : html`<p>Open your ${from} airtime transfer menu and send exactly ${formatNaira(t.requested_kobo)} to ${t.receiving_number}.</p>`}
        <p>Send the exact amount from the number you gave. If a different amount arrives, we move what arrived and the fee is worked out on that.</p>`;
      refresh = 20;
      break;
    case "inbound_confirmed":
    case "awaiting_approval":
    case "paying_out":
      main = html`${notice("ok", html`We have your ${formatNaira(t.received_kobo!)} on ${from}.`)}
        <h1>Sending ${payout} to ${mask(t.recipient_number)} on ${to}</h1>
        <p>This usually takes a minute. Fee ${formatNaira(t.fee_kobo!)}. This page updates itself.</p>`;
      refresh = 20;
      break;
    case "completed":
      main = html`${notice("ok", html`Done. ${payout} of ${to} airtime was sent to ${mask(t.recipient_number)}.`)}
        <h1>Transfer complete</h1>
        <p>${formatNaira(t.received_kobo!)} received on ${from}, fee ${formatNaira(t.fee_kobo!)}, ${payout} delivered on ${to}.</p>
        <p><a class="button" href="/">Send another</a></p>`;
      break;
    case "held":
    case "payout_failed":
      main = html`${notice("info", html`We have your ${formatNaira(t.received_kobo!)} on ${from} and a person is looking at this transfer.`)}
        <h1>Being checked</h1>
        <p>${t.hold_reason === "amount_below_minimum" || t.hold_reason === "amount_above_maximum" || t.hold_reason === "fee_exceeds_amount"
          ? "The amount that arrived is outside the limits we can move, so it will be sent back to your line."
          : "The airtime could not be delivered on the first try. It will be sent, or sent back to you. Nothing is lost."} Keep this reference: ${t.reference}. This page updates itself.</p>`;
      refresh = 60;
      break;
    case "refunding":
    case "refunded":
      main = html`${notice("info", html`${formatNaira(t.received_kobo!)} is being returned to your ${from} line ${mask(t.sender_number)}.`)}
        <h1>${t.state === "refunded" ? "Returned" : "Being returned"}</h1>
        <p>${t.state === "refunded" ? "The airtime is back on your line." : "You will see it on your line shortly. This page updates itself."}</p>`;
      refresh = t.state === "refunded" ? undefined : 60;
      break;
  }
  const body = html`${main}
    <dl class="ref"><dt>Reference</dt><dd><strong>${t.reference}</strong> <span class="muted">keep this to check on the transfer</span></dd>
      <dt>Route</dt><dd>${from} ${mask(t.sender_number)} to ${to} ${mask(t.recipient_number)}</dd></dl>`;
  return { kind: "html", body: shell(pending ? "Send the airtime" : "Transfer status", body, refresh ? { refreshSeconds: refresh } : {}) };
}

export function registerPublic(app: App): void {
  app.get("/", async (_req, db) => homePage(db), false);

  app.post(
    "/quote",
    async (req: Request, db) => {
      const values: FormValues = {
        from: req.form.get("from") ?? "",
        sender: req.form.get("sender") ?? "",
        to: req.form.get("to") ?? "",
        recipient: req.form.get("recipient") ?? "",
        amount: req.form.get("amount") ?? "",
      };
      // Bots fill the hidden field; people cannot see it.
      if ((req.form.get("website") ?? "") !== "") return homePage(db, values, notice("problem", "Something went wrong with the form. Please try again."), 400);
      const amountKobo = parseNaira(values.amount ?? "");
      if (amountKobo === undefined) return homePage(db, values, notice("problem", "Enter the amount in naira, like 500 or 1,500."), 400);
      const sender = normaliseNigerianNumber(values.sender ?? "");
      if (!sender) return homePage(db, values, notice("problem", "Your number should be a Nigerian mobile number like 08031234567."), 400);
      if (tooManyQuotes(`n:${sender}`) || tooManyQuotes(`ip:${req.ip}`)) {
        return homePage(db, values, notice("problem", "You have asked for several transfers in the last few minutes. Send the airtime for one of them, or wait ten minutes and try again."), 429);
      }
      try {
        const { transfer } = await withActor(`sender:${sender}`, (c) =>
          quoteTransfer(c, `sender:${sender}`, {
            fromNetwork: values.from ?? "",
            toNetwork: values.to ?? "",
            senderNumber: values.sender ?? "",
            recipientNumber: values.recipient ?? "",
            amountKobo,
          }),
          db,
        );
        return { kind: "redirect", to: `/t/${transfer.reference}` };
      } catch (err) {
        if (err instanceof UserFacingError) return homePage(db, values, notice("problem", err.message), 400);
        throw err;
      }
    },
    false,
  );

  app.get(
    "/t/:reference",
    async (req, db) => {
      const t = await getTransferByReference(db, req.query.get("reference") ?? "");
      if (!t) return { kind: "html", status: 404, body: shell("Not found", html`${notice("problem", html`There is no transfer with that reference. Check it and try again, or <a href="/">start a new one</a>.`)}`) };
      return statusPage(db, t);
    },
    false,
  );

  app.post(
    "/status",
    async (req, db) => {
      const t = await getTransferByReference(db, req.form.get("reference") ?? "");
      if (!t) return homePage(db, {}, notice("problem", "There is no transfer with that reference. It looks like TX- followed by eight letters and numbers."), 404);
      return { kind: "redirect", to: `/t/${t.reference}` };
    },
    false,
  );

  // The tiny convenience script: choose the network from the number's
  // prefix as it is typed. The page works without it.
  app.get(
    "/api/network-for",
    async (req, db) => {
      const code = await networkForNumber(db, req.query.get("number") ?? "");
      return { kind: "json", body: { network: code ?? null } };
    },
    false,
  );
}
