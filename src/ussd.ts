import type pg from "pg";
import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { computeFee, loadFeeRule } from "./fees.ts";
import { formatNaira, parseNaira } from "./money.ts";
import { createOrder, getOrderByReference } from "./orders.ts";
import { normaliseNigerianNumber, prefixOf } from "./phone.ts";
import { getSellbackByReference, quoteSellback } from "./sellbacks.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "./settings.ts";
import { getTransferByReference, quoteTransfer } from "./transfers.ts";

// The dialled service: one screen at a time, on any phone ever made.
//
// A USSD session has no memory of its own, so the whole of it lives in a row
// and this module is the machine that moves that row along. One keypress in,
// one screen out. The screens are the product here: there is no scrolling, no
// going back, and no second chance to explain anything.
//
// What this cannot do, and no amount of code will change: take the airtime off
// the caller's line. No network gives anybody an interface for that, which is
// why the last screen of a transfer hands over the network's own code for the
// caller to dial themselves. Everything up to that point, and everything
// afterwards, happens here.

// The GSM limit for one USSD screen is 182 characters. Longer and the network
// either cuts it or refuses it, and which of those it does is not something we
// get to find out in advance, so nothing here is allowed to exceed it.
export const SCREEN_LIMIT = 182;

type Client = pg.PoolClient;

export type Step =
  | "menu"
  | "send_from"
  | "send_to"
  | "send_network"
  | "send_amount"
  | "send_confirm"
  | "sell_from"
  | "sell_amount"
  | "sell_confirm"
  | "buy_to"
  | "buy_network"
  | "buy_amount"
  | "buy_confirm"
  | "check_reference";

export type Answers = {
  from?: NetworkCode;
  to?: string;
  toNetwork?: NetworkCode;
  amountKobo?: number;
};

export type Session = {
  session_id: string;
  caller_number: string;
  service_code: string;
  network_code: NetworkCode | null;
  step: Step;
  answers: Answers;
  input_so_far: string;
  last_screen: string;
  keypresses: number;
  reference: string | null;
};

// What the machine decided: the screen to send back, whether the session goes
// on, the step and answers to store, and the reference of anything created.
export type Rendered = { screen: string; done: boolean; step: Step; answers: Answers; reference?: string; outcome?: string };

// A caller who sends forty requests has lost their way, or something at the
// aggregator is looping. The session ends politely rather than running for
// ever. Exported because the endpoint counts retries against the same
// ceiling: forty requests is forty requests, keyed or repeated.
export const MOST_KEYPRESSES = 40;

export function tooLongScreen(): string {
  return lines("This has gone on a long time and nothing has been taken.", "Please dial again.");
}

// Trims a screen to what a network will carry, at a word boundary so the last
// thing the caller reads is a whole word. Screens are written to fit; this is
// the net under them, mostly for messages that come from elsewhere, like the
// reason a cap refused a transfer.
export function fitScreen(text: string): string {
  const clean = text.replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length <= SCREEN_LIMIT) return clean;
  const cut = clean.slice(0, SCREEN_LIMIT - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SCREEN_LIMIT - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}.`;
}

const lines = (...parts: (string | false | undefined)[]): string => fitScreen(parts.filter(Boolean).join("\n"));

// A number as a person reads it back: 0802 123 4567.
export function spaced(number: string): string {
  return number.length === 11 ? `${number.slice(0, 4)} ${number.slice(4, 7)} ${number.slice(7)}` : number;
}

// Networks as a numbered list, which is the only way to choose on a dial pad.
const NETWORK_CHOICES = NETWORK_CODES.map((c, i) => ({ key: String(i + 1), code: c }));
const SHORT: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };

function networkList(guess?: NetworkCode): string {
  return NETWORK_CHOICES.map(({ key, code }) => `${key} ${SHORT[code]}${guess === code ? " (we think)" : ""}`).join("\n");
}

export const MENU = lines(
  "Telco",
  "1 Send airtime to another network",
  "2 Sell airtime to us",
  "3 Buy airtime",
  "4 Check a transfer",
  "5 My recent sends",
);

// The network a number is on, as far as a prefix can say. Numbers get ported,
// so this is offered as a guess the caller confirms, never used on its own.
async function guessNetwork(db: Queryable, number: string): Promise<NetworkCode | undefined> {
  const { rows } = await db.query<{ network_code: NetworkCode }>("SELECT network_code FROM network_prefixes WHERE prefix = $1", [prefixOf(number)]);
  return rows[0]?.network_code;
}

// The amount screen, which has to say the limits because a refusal after the
// fact costs the caller another whole session. Sending, selling to us and
// buying each have their own pair of limits in the command centre, so the
// screen asks for the pair belonging to the thing the caller is doing: the
// limits shown and the limits enforced are then the same numbers.
async function amountScreen(db: Queryable, what: string, which: "transfer" | "sellback" | "retail"): Promise<string> {
  const [min, max] =
    which === "transfer"
      ? await getSettingValues(db, ["transfer.min_kobo", "transfer.max_kobo"] as const)
      : which === "sellback"
        ? await getSettingValues(db, ["sellback.min_kobo", "sellback.max_kobo"] as const)
        : await getSettingValues(db, ["retail.min_kobo", "retail.max_kobo"] as const);
  return lines(`${what}`, `From ${formatNaira(min)} to ${formatNaira(max)}.`, "Reply with the amount in naira.");
}

// What the caller is about to agree to, with the real fee from the fee engine
// rather than anything written here.
async function sendConfirmScreen(db: Queryable, s: Session): Promise<string> {
  const a = s.answers;
  const fee = computeFee(a.amountKobo!, await loadFeeRule(db, a.from!, a.toNetwork!));
  return lines(
    "Check carefully:",
    `${formatNaira(a.amountKobo!)} from your ${SHORT[a.from!]} line`,
    `to ${spaced(a.to!)} (${SHORT[a.toNetwork!]})`,
    `Fee ${formatNaira(fee.feeKobo)}, they get ${formatNaira(fee.payoutKobo)}`,
    "1 Confirm  2 Change number  0 Cancel",
  );
}

// The last screen of a transfer: the network's own code, with our number and
// the amount in it and the PIN left as a word, because we never hold a PIN.
async function dialScreen(db: Queryable, reference: string): Promise<string> {
  const t = await getTransferByReference(db, reference);
  if (!t) return lines("Something went wrong and nothing was taken. Nothing is owed. Please dial again.");
  const codes = await getSettingValue(db, "network.transfer_code");
  const code = codes[t.from_network]
    .replace("{amount}", t.requested_kobo % 100 === 0 ? String(t.requested_kobo / 100) : (t.requested_kobo / 100).toFixed(2))
    .replace("{number}", t.receiving_number)
    .replace("{pin}", "PIN");
  return lines(
    `Ref ${t.reference}`,
    code ? `Now dial ${code} on your ${SHORT[t.from_network]} line.` : `Now send ${formatNaira(t.requested_kobo)} of ${SHORT[t.from_network]} airtime to ${t.receiving_number}.`,
    code.includes("PIN") ? "PIN is your own transfer PIN. We never ask for it." : false,
    `We send ${formatNaira(t.quoted_payout_kobo)} as soon as ${SHORT[t.from_network]} confirms.`,
  );
}

async function sellDialScreen(db: Queryable, reference: string): Promise<string> {
  const s = await getSellbackByReference(db, reference);
  if (!s) return lines("Something went wrong and nothing was taken. Please dial again.");
  const codes = await getSettingValue(db, "network.transfer_code");
  const code = codes[s.network_code]
    .replace("{amount}", s.face_kobo % 100 === 0 ? String(s.face_kobo / 100) : (s.face_kobo / 100).toFixed(2))
    .replace("{number}", s.receiving_number)
    .replace("{pin}", "PIN");
  return lines(
    `Ref ${s.reference}`,
    code ? `Dial ${code} on your ${SHORT[s.network_code]} line.` : `Send ${formatNaira(s.face_kobo)} to ${s.receiving_number}.`,
    `You get ${formatNaira(s.quoted_pay_kobo)} of credit when it lands.`,
  );
}

function sellConfirmScreen(a: Answers): string {
  return lines("Sell to us:", `${formatNaira(a.amountKobo!)} of ${SHORT[a.from!]} airtime`, "You get credit to spend with us.", "1 Confirm  0 Cancel");
}

function buyConfirmScreen(a: Answers): string {
  return lines("Buy airtime:", `${formatNaira(a.amountKobo!)} of ${SHORT[a.toNetwork!]}`, `for ${spaced(a.to!)}`, "1 Confirm  0 Cancel");
}

async function buyPayScreen(db: Queryable, reference: string): Promise<string> {
  const o = await getOrderByReference(db, reference);
  if (!o) return lines("Something went wrong and nothing was taken. Please dial again.");
  const [bank, number, name] = await getSettingValues(db, ["retail.bank_name", "retail.bank_account_number", "retail.bank_account_name"] as const);
  if (!bank || !number || !name) {
    return lines(`Ref ${o.reference}`, "We cannot take bank transfers yet. Nothing is owed. Please use the website to pay by card.");
  }
  return lines(
    `Pay ${formatNaira(o.price_kobo)} to`,
    `${bank} ${number}`,
    name,
    `Put ${o.reference} as the narration.`,
    "Airtime is sent once the money lands.",
  );
}

// The caller's last few transfers, which is the question the command centre
// gets asked most often by the people who send.
async function recentScreen(db: Queryable, caller: string): Promise<string> {
  const { rows } = await db.query<{ reference: string; state: string; requested_kobo: number; to_network: NetworkCode }>(
    "SELECT reference, state, requested_kobo, to_network FROM transfers WHERE sender_number = $1 ORDER BY created_at DESC LIMIT 3",
    [caller],
  );
  if (rows.length === 0) return lines("You have not sent anything yet.", "Dial again and choose 1 to send airtime.");
  return lines("Your last sends:", ...rows.map((r) => `${formatNaira(r.requested_kobo)} to ${SHORT[r.to_network]}: ${stateWord(r.state)}`));
}

// The state of a transfer in words a caller understands, not ours.
export function stateWord(state: string): string {
  switch (state) {
    case "awaiting_inbound":
      return "waiting for your airtime";
    case "expired":
      return "lapsed, nothing was taken";
    case "inbound_confirmed":
    case "awaiting_approval":
    case "paying_out":
      return "sending now";
    case "completed":
      return "done";
    case "payout_failed":
    case "held":
      return "being checked by a person";
    case "refunding":
      return "coming back to you";
    case "refunded":
      return "returned to you";
    default:
      return state.replaceAll("_", " ");
  }
}

async function checkScreen(db: Queryable, reference: string): Promise<string> {
  const wanted = reference.trim().toUpperCase();
  const t = await getTransferByReference(db, wanted);
  if (t) {
    return lines(
      `${t.reference}: ${stateWord(t.state)}.`,
      `${formatNaira(t.received_kobo ?? t.requested_kobo)} to ${spaced(t.recipient_number)} on ${SHORT[t.to_network]}.`,
      t.state === "completed" ? `They got ${formatNaira(t.payout_kobo ?? t.quoted_payout_kobo)}.` : false,
    );
  }
  const s = await getSellbackByReference(db, wanted);
  if (s) return lines(`${s.reference}: ${s.state.replaceAll("_", " ")}.`, s.credit_code ? `Your credit code is ${s.credit_code}.` : false);
  const o = await getOrderByReference(db, wanted);
  if (o) return lines(`${o.reference}: ${o.state.replaceAll("_", " ")}.`, `${formatNaira(o.face_kobo)} for ${spaced(o.recipient_number)}.`);
  return lines("No transfer, sale or order has that reference.", "Check it and dial again.");
}

// One keypress. Returns the screen to send back and what to store.
//
// Everything that creates anything is guarded by the reference already on the
// session, so a keypress the aggregator sends twice cannot make two transfers.
export async function advance(db: Client, session: Session, input: string, actor: string): Promise<Rendered> {
  const keyed = input.trim();
  const stay = (step: Step, screen: string, answers: Answers = session.answers): Rendered => ({ screen, done: false, step, answers });
  const end = (screen: string, outcome: string, extra: Partial<Rendered> = {}): Rendered => ({ screen, done: true, step: session.step, answers: session.answers, outcome, ...extra });

  if (session.keypresses >= MOST_KEYPRESSES) return end(tooLongScreen(), "too_many_keypresses");

  try {
    switch (session.step) {
      case "menu":
        switch (keyed) {
          case "1":
            return session.network_code
              ? stay("send_to", lines("Enter the number that will RECEIVE the airtime."), { from: session.network_code })
              : stay("send_from", lines("Which network are you sending FROM?", networkList(await guessNetwork(db, session.caller_number))));
          case "2":
            return session.network_code
              ? stay("sell_amount", await amountScreen(db, "How much airtime do you want to sell to us?", "sellback"), { from: session.network_code })
              : stay("sell_from", lines("Which network is the airtime on?", networkList(await guessNetwork(db, session.caller_number))));
          case "3":
            return stay("buy_to", lines("Enter the number to buy airtime for."));
          case "4":
            return stay("check_reference", lines("Enter the reference, like TX-ABCD2345."));
          case "5":
            return end(await recentScreen(db, session.caller_number), "recent");
          default:
            return stay("menu", lines("Choose 1 to 5.", MENU));
        }

      case "send_from":
      case "sell_from": {
        const chosen = NETWORK_CHOICES.find((n) => n.key === keyed);
        if (!chosen) return stay(session.step, lines("Choose a network.", networkList()));
        return session.step === "send_from"
          ? stay("send_to", lines("Enter the number that will RECEIVE the airtime."), { ...session.answers, from: chosen.code })
          : stay("sell_amount", await amountScreen(db, "How much airtime do you want to sell to us?", "sellback"), { ...session.answers, from: chosen.code });
      }

      case "send_to":
      case "buy_to": {
        const to = normaliseNigerianNumber(keyed);
        if (!to) return stay(session.step, lines("That is not a Nigerian mobile number.", "Enter it like 08021234567."));
        const next = session.step === "send_to" ? "send_network" : "buy_network";
        return stay(next, lines(`Which network is ${spaced(to)} on?`, networkList(await guessNetwork(db, to))), { ...session.answers, to });
      }

      case "send_network":
      case "buy_network": {
        const chosen = NETWORK_CHOICES.find((n) => n.key === keyed);
        if (!chosen) return stay(session.step, lines("Choose a network.", networkList()));
        const answers = { ...session.answers, toNetwork: chosen.code };
        if (session.step === "send_network" && chosen.code === answers.from) {
          return stay("send_network", lines(`Your line is on ${SHORT[chosen.code]} too, and ${SHORT[chosen.code]} can send to itself for free.`, "Choose another network."));
        }
        return stay(
          session.step === "send_network" ? "send_amount" : "buy_amount",
          await amountScreen(db, session.step === "send_network" ? "How much airtime to send?" : "How much airtime to buy?", session.step === "send_network" ? "transfer" : "retail"),
          answers,
        );
      }

      case "send_amount":
      case "sell_amount":
      case "buy_amount": {
        const amountKobo = parseNaira(keyed);
        if (amountKobo === undefined || amountKobo <= 0) return stay(session.step, lines("That is not an amount.", "Reply with the amount in naira, like 500."));
        const answers = { ...session.answers, amountKobo };
        const next = session.step === "send_amount" ? "send_confirm" : session.step === "sell_amount" ? "sell_confirm" : "buy_confirm";
        const screen =
          next === "send_confirm"
            ? await sendConfirmScreen(db, { ...session, answers })
            : next === "sell_confirm"
              ? sellConfirmScreen(answers)
              : buyConfirmScreen(answers);
        return stay(next, screen, answers);
      }

      case "send_confirm": {
        if (keyed === "0") return end(lines("Cancelled. Nothing was taken."), "cancelled");
        if (keyed === "2") return stay("send_to", lines("Enter the number that will RECEIVE the airtime."));
        if (keyed !== "1") return stay("send_confirm", await sendConfirmScreen(db, session));
        if (session.reference) return end(await dialScreen(db, session.reference), "sent", { reference: session.reference });
        const a = session.answers;
        const { transfer } = await quoteTransfer(db, actor, {
          fromNetwork: a.from!,
          toNetwork: a.toNetwork!,
          senderNumber: session.caller_number,
          recipientNumber: a.to!,
          amountKobo: a.amountKobo!,
        });
        return end(await dialScreen(db, transfer.reference), "sent", { reference: transfer.reference });
      }

      case "sell_confirm": {
        if (keyed === "0") return end(lines("Cancelled. Nothing was taken."), "cancelled");
        if (keyed !== "1") return stay("sell_confirm", sellConfirmScreen(session.answers));
        if (session.reference) return end(await sellDialScreen(db, session.reference), "selling", { reference: session.reference });
        const { sellback } = await quoteSellback(db, actor, {
          network: session.answers.from!,
          sellerNumber: session.caller_number,
          kind: "airtime",
          amountKobo: session.answers.amountKobo!,
          outcome: "credit",
        });
        return end(await sellDialScreen(db, sellback.reference), "selling", { reference: sellback.reference });
      }

      case "buy_confirm": {
        if (keyed === "0") return end(lines("Cancelled. Nothing was taken."), "cancelled");
        if (keyed !== "1") return stay("buy_confirm", buyConfirmScreen(session.answers));
        if (session.reference) return end(await buyPayScreen(db, session.reference), "buying", { reference: session.reference });
        const order = await createOrder(db, actor, {
          network: session.answers.toNetwork!,
          recipientNumber: session.answers.to!,
          faceKobo: session.answers.amountKobo!,
        });
        return end(await buyPayScreen(db, order.reference), "buying", { reference: order.reference });
      }

      case "check_reference":
        return end(await checkScreen(db, keyed), "checked");
    }
  } catch (err) {
    // A rule said no. The reason is the one the website would have given,
    // trimmed to a screen, because a caller who is refused needs to know why
    // and what to do, not that something went wrong.
    if (err instanceof UserFacingError) return end(fitScreen(err.message), `refused:${err.code}`);
    throw err;
  }
}

// The first screen of a session. Separate because nothing has been keyed yet.
export function openingScreen(): string {
  return MENU;
}
