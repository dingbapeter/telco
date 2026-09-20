import type pg from "pg";
import { agentByCode } from "../agents.ts";
import { describeBundle, getBundle, listBundles, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { normaliseNigerianNumber, prefixOf } from "../phone.ts";
import { getSettingValue, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { getTransferByReference, quoteTransfer, type Transfer } from "../transfers.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Request, Response } from "../web/http.ts";
import { cookie } from "../web/http.ts";

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
<meta name="theme-color" content="#0b5d4a">
<link rel="stylesheet" href="/static/public.css">
<link rel="manifest" href="/static/manifest.json">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-180.png">
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

type FormValues = { from?: string; sender?: string; to?: string; recipient?: string; amount?: string; send?: string; receive?: string };

// Bundles grouped by network for a select, so the page needs no script to
// show the right ones: the form checks the network matches on submit.
function bundleOptions(bundles: Bundle[], selected: string | undefined, blank: string): Html {
  const byNetwork = new Map<string, Bundle[]>();
  for (const b of bundles) byNetwork.set(b.network_code, [...(byNetwork.get(b.network_code) ?? []), b]);
  return html`<option value="" ${!selected ? "selected" : ""}>${blank}</option>
    ${[...byNetwork.entries()].map(([net, list]) => html`<optgroup label="${NAMES[net as NetworkCode]}">${list.map((b) => html`<option value="${b.id}" ${String(b.id) === selected ? "selected" : ""}>${describeBundle(b)}</option>`)}</optgroup>`)}`;
}

function form(values: FormValues, problem: Html | undefined, giftable: Bundle[], deliverable: Bundle[]): Html {
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
    ${giftable.length > 0
      ? html`<div class="field"><label for="send">What you are sending</label>
          <select id="send" name="send">${bundleOptions(giftable, values.send, "Airtime, an amount I choose")}</select>
          <span class="muted">Pick a data bundle you hold to send that instead of airtime. It is valued at its price.</span></div>`
      : ""}
    <div class="field"><label for="amount">Amount of airtime to move, in naira <span class="muted">(leave empty if sending or receiving a bundle)</span></label>
      <input id="amount" name="amount" type="text" inputmode="decimal" value="${values.amount ?? ""}" placeholder="500"></div>
    ${deliverable.length > 0
      ? html`<div class="field"><label for="receive">What the other side gets</label>
          <select id="receive" name="receive">${bundleOptions(deliverable, values.receive, "Airtime")}</select>
          <span class="muted">Pick a data bundle and we tell you exactly how much airtime to send for it.</span></div>`
      : ""}
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
  const bundles = await listBundles(db, { activeOnly: true });
  const giftable = bundles.filter((b) => b.giftable);
  const body = html`<h1>Airtime on one network. Use it on another.</h1>
    <p>Send airtime from your MTN, Airtel, Glo or 9mobile line to a number on a different network. You dial your own network's transfer code, we deliver the airtime on the other side, and a small fee comes out of the amount.</p>
    <ul class="facts">
      <li>Fee: ${(percent / 100).toFixed(percent % 100 === 0 ? 0 : 2)} percent, at least ${formatNaira(floor)} and at most ${formatNaira(ceiling)}.</li>
      <li>From ${formatNaira(min)} to ${formatNaira(max)} per transfer.</li>
      <li>No account, no card, no app. Just your phone's dial pad.</li>
      ${bundles.length > 0 ? html`<li>The other side can get a data bundle instead of airtime${giftable.length > 0 ? ", and you can send a data bundle you hold" : ""}.</li>` : ""}
    </ul>
    ${form(values, problem, giftable, bundles)}
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
  const [codes, giftCodes] = await Promise.all([getSettingValue(db, "network.transfer_code"), getSettingValue(db, "network.data_gift_code")]);
  const inBundle = t.in_bundle_id ? await getBundle(db, t.in_bundle_id) : undefined;
  const outBundle = t.out_bundle_id ? await getBundle(db, t.out_bundle_id) : undefined;
  const gets = outBundle ? `the bundle ${outBundle.name}` : `${formatNaira(t.payout_kobo ?? t.quoted_payout_kobo)} of airtime`;
  const code = inBundle ? giftCodes[t.from_network] : codes[t.from_network];
  const amountNaira = t.requested_kobo % 100 === 0 ? String(t.requested_kobo / 100) : (t.requested_kobo / 100).toFixed(2);
  const dial = code ? code.replace("{amount}", amountNaira).replace("{number}", t.receiving_number).replace("{size}", inBundle ? inBundle.name : "") : "";
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
        <h1>Now ${inBundle ? `gift the bundle ${inBundle.name}` : `send ${formatNaira(t.requested_kobo)} of ${from} airtime`} to <span class="big">${t.receiving_number}</span></h1>
        <p>Use ${from}'s own ${inBundle ? "data gifting" : "airtime transfer"} from your line ${mask(t.sender_number)}. The recipient gets ${gets} on ${to} once it lands.${outBundle && !inBundle ? ` Send exactly ${formatNaira(t.requested_kobo)}: that covers the bundle's ${formatNaira(outBundle.price_kobo)} and the fee.` : ""}</p>
        ${dial
          ? html`<p class="dial-label">On your ${from} line, dial:</p>
            <p class="dial">${shown}</p>
            <p><button type="button" class="secondary copy" data-copy="${shown}">Copy the code</button></p>
            ${needsPin
              ? html`<p>Put your ${from} transfer PIN where it says PIN. We never ask for your PIN and you should never type it on a website.</p>`
              : html`<p class="android-only"><a class="button" href="tel:${encodeURIComponent(dial).replaceAll("%2A", "*")}">Open the dial pad with this code</a></p>
                <p class="iphone-only">On an iPhone, copy the code, open the Phone app, paste it into the keypad and press call.</p>`}`
          : html`<p>Open your ${from} ${inBundle ? "data gifting" : "airtime transfer"} menu and ${inBundle ? `gift ${inBundle.name}` : `send exactly ${formatNaira(t.requested_kobo)}`} to ${t.receiving_number}.</p>`}
        <p>${outBundle ? "Send the exact amount from the number you gave. A different amount is held for a person, who will return it." : inBundle ? "Gift that exact bundle from the number you gave. A different bundle is kept for a person to look at." : "Send the exact amount from the number you gave. If a different amount arrives, we move what arrived and the fee is worked out on that."}</p>`;
      refresh = 20;
      break;
    case "inbound_confirmed":
    case "awaiting_approval":
    case "paying_out":
      main = html`${notice("ok", html`We have your ${inBundle ? inBundle.name : formatNaira(t.received_kobo!)} on ${from}.`)}
        <h1>Sending ${outBundle ? outBundle.name : payout} to ${mask(t.recipient_number)} on ${to}</h1>
        <p>This usually takes a minute. Fee ${formatNaira(t.fee_kobo!)}. This page updates itself.</p>`;
      refresh = 20;
      break;
    case "completed":
      main = html`${notice("ok", html`Done. ${outBundle ? `The bundle ${outBundle.name}` : `${payout} of ${to} airtime`} was sent to ${mask(t.recipient_number)}.`)}
        <h1>Transfer complete</h1>
        <p>${inBundle ? `${inBundle.name} (valued at ${formatNaira(t.received_kobo!)})` : formatNaira(t.received_kobo!)} received on ${from}, fee ${formatNaira(t.fee_kobo!)}, ${outBundle ? outBundle.name : payout} delivered on ${to}.</p>
        <p><a class="button" href="/">Send another</a></p>`;
      break;
    case "held":
    case "payout_failed":
      main = html`${notice("info", html`We have your ${formatNaira(t.received_kobo!)} on ${from} and a person is looking at this transfer.`)}
        <h1>Being checked</h1>
        <p>${t.hold_reason === "amount_below_minimum" || t.hold_reason === "amount_above_maximum" || t.hold_reason === "fee_exceeds_amount"
          ? "The amount that arrived is outside the limits we can move, so it will be sent back to your line."
          : t.hold_reason === "amount_below_required" || t.hold_reason === "amount_above_required"
            ? `The amount that arrived was not the exact ${formatNaira(t.requested_kobo)} the bundle needs, so it will be sent back to your line.`
          : t.hold_reason === "bundle_repriced" || t.hold_reason === "bundle_withdrawn"
            ? "The bundle changed after you were quoted, so a person is checking this one. It will be sent, or sent back to your line."
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

export const AGENT_COOKIE = "telco_agent";

// The agent whose link brought this visitor, if the cookie still names an
// active agent and agents are switched on.
export async function referringAgent(req: Request, db: pg.Pool): Promise<number | undefined> {
  const code = req.cookies[AGENT_COOKIE];
  if (!code) return undefined;
  if (!(await getSettingValue(db, "agent.enabled"))) return undefined;
  return (await agentByCode(db, code))?.id;
}

export function registerPublic(app: App): void {
  app.get("/", async (_req, db) => homePage(db), false);

  // An agent's link: remembers the agent for thirty days, then shows the
  // ordinary front page.
  app.get(
    "/a/:code",
    async (req, db) => {
      const agent = (await getSettingValue(db, "agent.enabled")) ? await agentByCode(db, req.query.get("code") ?? "") : undefined;
      if (!agent) return { kind: "redirect", to: "/" };
      return { kind: "redirect", to: "/", headers: { "set-cookie": cookie(AGENT_COOKIE, agent.code, req.raw.headers["x-forwarded-proto"] === "https", 30 * 86_400) } };
    },
    false,
  );

  app.post(
    "/quote",
    async (req: Request, db) => {
      const values: FormValues = {
        from: req.form.get("from") ?? "",
        sender: req.form.get("sender") ?? "",
        to: req.form.get("to") ?? "",
        recipient: req.form.get("recipient") ?? "",
        amount: req.form.get("amount") ?? "",
        send: req.form.get("send") ?? "",
        receive: req.form.get("receive") ?? "",
      };
      // Bots fill the hidden field; people cannot see it.
      if ((req.form.get("website") ?? "") !== "") return homePage(db, values, notice("problem", "Something went wrong with the form. Please try again."), 400);
      const inBundleId = values.send ? Number(values.send) : undefined;
      const outBundleId = values.receive ? Number(values.receive) : undefined;
      let amountKobo: number | undefined;
      if (!inBundleId && !outBundleId) {
        amountKobo = parseNaira(values.amount ?? "");
        if (amountKobo === undefined) return homePage(db, values, notice("problem", "Enter the amount in naira, like 500 or 1,500, or pick a bundle."), 400);
      }
      const sender = normaliseNigerianNumber(values.sender ?? "");
      if (!sender) return homePage(db, values, notice("problem", "Your number should be a Nigerian mobile number like 08031234567."), 400);
      if (tooManyQuotes(`n:${sender}`) || tooManyQuotes(`ip:${req.ip}`)) {
        return homePage(db, values, notice("problem", "You have asked for several transfers in the last few minutes. Send the airtime for one of them, or wait ten minutes and try again."), 429);
      }
      try {
        const agentId = await referringAgent(req, db);
        const { transfer } = await withActor(`sender:${sender}`, (c) =>
          quoteTransfer(c, `sender:${sender}`, {
            fromNetwork: values.from ?? "",
            toNetwork: values.to ?? "",
            senderNumber: values.sender ?? "",
            recipientNumber: values.recipient ?? "",
            amountKobo,
            inBundleId,
            outBundleId,
            agentId,
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
