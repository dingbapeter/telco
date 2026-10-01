import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { formatNaira } from "./money.ts";

export const NETWORK_CODES = ["MTN", "AIRTEL", "GLO", "9MOBILE"] as const;
export type NetworkCode = (typeof NETWORK_CODES)[number];

export type PerNetwork<T> = Record<NetworkCode, T>;

export type PairOverride = {
  percent_basis_points?: number;
  flat_kobo?: number;
  floor_kobo?: number;
  ceiling_kobo?: number;
};

type Validator<T> = (value: unknown) => { ok: true; value: T } | { ok: false; reason: string };

export type SettingSpec<T> = {
  key: string;
  group: string;
  label: string;
  description: string;
  fallback: T;
  validate: Validator<T>;
  format: (value: T) => string;
};

function intBetween(min: number, max: number, unit: "kobo" | "basis points" | "minutes" | "count"): Validator<number> {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return { ok: false, reason: `must be a whole number of ${unit}` };
    }
    if (value < min || value > max) {
      const show = unit === "kobo" ? formatNaira : unit === "basis points" ? (v: number) => `${v / 100} percent` : String;
      return { ok: false, reason: `must be between ${show(min)} and ${show(max)}` };
    }
    return { ok: true, value };
  };
}

// A dialling code with a run of four or more digits and no {pin} in it is
// almost always somebody's PIN typed in by hand. A PIN written here would
// be sent to every phone, kept in the audit log and shown on the screen,
// so it is refused with the placeholder named.
function dialCode(max: number): Validator<string> {
  const inner = text(max);
  return (value) => {
    const r = inner(value);
    if (!r.ok) return r;
    if (r.value !== "" && !r.value.includes("{pin}") && /\d{4,}/.test(r.value)) {
      return { ok: false, reason: "must use {pin} where the PIN goes, never the PIN itself. The phone fills it in and it never leaves the phone" };
    }
    return r;
  };
}

function perNetwork<T>(inner: Validator<T>): Validator<PerNetwork<T>> {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "must be one value per network" };
    }
    const out = {} as PerNetwork<T>;
    for (const code of NETWORK_CODES) {
      const r = inner((value as Record<string, unknown>)[code]);
      if (!r.ok) return { ok: false, reason: `${code} ${r.reason}` };
      out[code] = r.value;
    }
    return { ok: true, value: out };
  };
}

function pairOverrides(): Validator<Record<string, PairOverride>> {
  const fields: Record<keyof PairOverride, Validator<number>> = {
    percent_basis_points: intBetween(0, 5000, "basis points"),
    flat_kobo: intBetween(0, 1_000_000, "kobo"),
    floor_kobo: intBetween(0, 1_000_000, "kobo"),
    ceiling_kobo: intBetween(0, 10_000_000, "kobo"),
  };
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "must be a map of network pairs like MTN>AIRTEL" };
    }
    const out: Record<string, PairOverride> = {};
    for (const [pair, override] of Object.entries(value as Record<string, unknown>)) {
      const [from, to] = pair.split(">");
      if (!from || !to || !NETWORK_CODES.includes(from as NetworkCode) || !NETWORK_CODES.includes(to as NetworkCode) || from === to) {
        return { ok: false, reason: `${pair} is not a pair of two different networks written like MTN>AIRTEL` };
      }
      if (typeof override !== "object" || override === null) {
        return { ok: false, reason: `${pair} must hold the fields to override` };
      }
      const cleaned: PairOverride = {};
      for (const [field, v] of Object.entries(override as Record<string, unknown>)) {
        const validator = fields[field as keyof PairOverride];
        if (!validator) return { ok: false, reason: `${pair} has an unknown field ${field}` };
        const r = validator(v);
        if (!r.ok) return { ok: false, reason: `${pair} ${field} ${r.reason}` };
        cleaned[field as keyof PairOverride] = r.value;
      }
      out[pair] = cleaned;
    }
    return { ok: true, value: out };
  };
}

function boolean(): Validator<boolean> {
  return (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "must be on or off" });
}

function oneOf<T extends string>(choices: readonly T[]): Validator<T> {
  return (value) => (typeof value === "string" && (choices as readonly string[]).includes(value) ? { ok: true, value: value as T } : { ok: false, reason: `must be one of ${choices.join(", ")}` });
}

function text(maxLength: number): Validator<string> {
  return (value) =>
    typeof value === "string" && value.length <= maxLength
      ? { ok: true, value }
      : { ok: false, reason: `must be text of at most ${maxLength} characters` };
}

const kobo = (v: number) => formatNaira(v);
const bp = (v: number) => `${(v / 100).toFixed(2)} percent`;
const each = <T>(f: (v: T) => string) => (v: PerNetwork<T>) => NETWORK_CODES.map((c) => `${c} ${f(v[c])}`).join(", ");
const zeroPerNetwork = Object.fromEntries(NETWORK_CODES.map((c) => [c, 0])) as PerNetwork<number>;
const emptyPerNetwork = Object.fromEntries(NETWORK_CODES.map((c) => [c, ""])) as PerNetwork<string>;

// Keeps each entry's value type while the registry stays one plain object.
function define<T>(spec: SettingSpec<T>): SettingSpec<T> {
  return spec;
}

// The registry. Every runtime setting the product has, with its range, its
// fallback, and words a founder can read. The command centre renders this.
export const SETTINGS = {
  "fee.percent_basis_points": define({
    key: "fee.percent_basis_points",
    group: "Fees",
    label: "Fee percentage",
    description: "Share of the transferred amount taken as the fee, in basis points. 400 is 4 percent.",
    fallback: 400,
    validate: intBetween(0, 5000, "basis points"),
    format: bp,
  }),
  "fee.flat_kobo": define({
    key: "fee.flat_kobo",
    group: "Fees",
    label: "Flat fee",
    description: "Fixed amount added to every fee before the floor and ceiling apply.",
    fallback: 0,
    validate: intBetween(0, 1_000_000, "kobo"),
    format: kobo,
  }),
  "fee.floor_kobo": define({
    key: "fee.floor_kobo",
    group: "Fees",
    label: "Minimum fee",
    description: "The fee is never below this.",
    fallback: 2000,
    validate: intBetween(0, 1_000_000, "kobo"),
    format: kobo,
  }),
  "fee.ceiling_kobo": define({
    key: "fee.ceiling_kobo",
    group: "Fees",
    label: "Maximum fee",
    description: "The fee is never above this.",
    fallback: 20_000,
    validate: intBetween(0, 10_000_000, "kobo"),
    format: kobo,
  }),
  "fee.network_share_basis_points": define({
    key: "fee.network_share_basis_points",
    group: "Fees",
    label: "Network share of the fee",
    description:
      "Share of each fee owed to the network the airtime left, per network, in basis points. Leave at zero for a network that has not signed an agreement.",
    fallback: zeroPerNetwork,
    validate: perNetwork(intBetween(0, 10_000, "basis points")),
    format: each(bp),
  }),
  "fee.pair_overrides": define({
    key: "fee.pair_overrides",
    group: "Fees",
    label: "Fee overrides per network pair",
    description: "Optional different fee fields for one direction, keyed like MTN>AIRTEL.",
    fallback: {} as Record<string, PairOverride>,
    validate: pairOverrides(),
    format: (v) => (Object.keys(v).length === 0 ? "none" : JSON.stringify(v)),
  }),
  "transfer.min_kobo": define({
    key: "transfer.min_kobo",
    group: "Limits",
    label: "Smallest transfer",
    description: "A sender cannot move less than this in one transfer.",
    fallback: 10_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "transfer.max_kobo": define({
    key: "transfer.max_kobo",
    group: "Limits",
    label: "Largest transfer",
    description: "A sender cannot move more than this in one transfer.",
    fallback: 1_000_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "transfer.sender_daily_max_kobo": define({
    key: "transfer.sender_daily_max_kobo",
    group: "Limits",
    label: "Daily limit per sender",
    description: "The most one sending number can move in a day, Lagos time.",
    fallback: 2_000_000,
    validate: intBetween(100, 1_000_000_000, "kobo"),
    format: kobo,
  }),
  "transfer.inbound_window_minutes": define({
    key: "transfer.inbound_window_minutes",
    group: "Limits",
    label: "Time allowed to send",
    description: "How long a sender has to dial the transfer code before the quote expires.",
    fallback: 30,
    validate: intBetween(5, 1440, "minutes"),
    format: (v) => `${v} minutes`,
  }),
  "transfer.inbound_grace_minutes": define({
    key: "transfer.inbound_grace_minutes",
    group: "Limits",
    label: "Late arrival grace",
    description: "Airtime that lands this long after a quote expired is still matched to it.",
    fallback: 120,
    validate: intBetween(0, 10_080, "minutes"),
    format: (v) => `${v} minutes`,
  }),
  "payout.auto_approve_max_kobo": define({
    key: "payout.auto_approve_max_kobo",
    group: "Guardrails",
    label: "Second approver above",
    description: "A payout larger than this waits for an administrator to approve it.",
    fallback: 500_000,
    validate: intBetween(0, 1_000_000_000, "kobo"),
    format: kobo,
  }),
  "payout.automatic": define({
    key: "payout.automatic",
    group: "Guardrails",
    label: "Automatic payouts",
    description:
      "When on, confirmed transfers are paid out through the top-up provider without a person. When off, every payout is done by hand from the transfer page. Turn it off in a moment of doubt; nothing is lost.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "payout.max_attempts": define({
    key: "payout.max_attempts",
    group: "Guardrails",
    label: "Automatic payout attempts",
    description: "How many times the provider is tried for one transfer before it is left for a person. Waits one, five and then fifteen minutes between tries.",
    fallback: 3,
    validate: intBetween(1, 10, "count"),
    format: (v) => `${v}`,
  }),
  "payout.route": define({
    key: "payout.route",
    group: "Guardrails",
    label: "How each network is paid out",
    description:
      "Per destination network: provider means through the top-up provider from its wallet; phone means from our own SIM in the sending phone, which drains that network's pool. Refunds and gifted bundles always go through the phone.",
    fallback: Object.fromEntries(NETWORK_CODES.map((c) => [c, "provider"])) as PerNetwork<"provider" | "phone">,
    validate: perNetwork(oneOf(["provider", "phone"] as const)),
    format: each((v) => v),
  }),
  "phone.command_timeout_minutes": define({
    key: "phone.command_timeout_minutes",
    group: "Guardrails",
    label: "Sending phone timeout",
    description: "How long to wait for a phone to dial and for the network to confirm before the item is left for a person.",
    fallback: 10,
    validate: intBetween(2, 120, "minutes"),
    format: (v) => `${v} minutes`,
  }),
  "payout.daily_ceiling_kobo": define({
    key: "payout.daily_ceiling_kobo",
    group: "Guardrails",
    label: "Daily payout ceiling per network",
    description: "Total paid out on each network in a day stops here. Anything more is held for a person to look at.",
    fallback: Object.fromEntries(NETWORK_CODES.map((c) => [c, 5_000_000])) as PerNetwork<number>,
    validate: perNetwork(intBetween(0, 10_000_000_000, "kobo")),
    format: each(kobo),
  }),
  "retail.enabled": define({
    key: "retail.enabled",
    group: "Retail top-up",
    label: "Selling airtime for money",
    description: "When on, the Buy airtime page is open to the public. Needs bank details below or a payment provider's keys on the server, or nobody can pay.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "retail.min_kobo": define({
    key: "retail.min_kobo",
    group: "Retail top-up",
    label: "Smallest purchase",
    description: "A buyer cannot buy less than this.",
    fallback: 10_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "retail.max_kobo": define({
    key: "retail.max_kobo",
    group: "Retail top-up",
    label: "Largest purchase",
    description: "A buyer cannot buy more than this in one order.",
    fallback: 2_000_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "retail.discount_basis_points": define({
    key: "retail.discount_basis_points",
    group: "Retail top-up",
    label: "Discount per network",
    description: "Sell a network's airtime below face value to drain an overfull pool, in basis points. 300 is 3 percent off. Zero sells at face value.",
    fallback: zeroPerNetwork,
    validate: perNetwork(intBetween(0, 2_000, "basis points")),
    format: each(bp),
  }),
  "retail.order_window_minutes": define({
    key: "retail.order_window_minutes",
    group: "Retail top-up",
    label: "Time allowed to pay",
    description: "How long a buyer has to pay before the order expires.",
    fallback: 60,
    validate: intBetween(5, 1440, "minutes"),
    format: (v) => `${v} minutes`,
  }),
  "retail.bank_name": define({
    key: "retail.bank_name",
    group: "Retail top-up",
    label: "Bank for transfers",
    description: "The bank buyers transfer to when paying by bank transfer. Leave all three bank fields empty to not offer bank transfer.",
    fallback: "",
    validate: text(80),
    format: (v) => (v === "" ? "not set" : v),
  }),
  "retail.bank_account_number": define({
    key: "retail.bank_account_number",
    group: "Retail top-up",
    label: "Account number for transfers",
    description: "Shown to buyers with their order reference to put in the narration.",
    fallback: "",
    validate: text(20),
    format: (v) => (v === "" ? "not set" : v),
  }),
  "retail.bank_account_name": define({
    key: "retail.bank_account_name",
    group: "Retail top-up",
    label: "Account name for transfers",
    description: "The name on the account, as the buyer's bank will show it.",
    fallback: "",
    validate: text(80),
    format: (v) => (v === "" ? "not set" : v),
  }),
  "agent.enabled": define({
    key: "agent.enabled",
    group: "Agents",
    label: "Agents",
    description: "When on, agents can log in, bring senders with their link, top up a wallet and buy for customers. When off, nothing an agent does is accepted, and their balances are kept.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "agent.commission_basis_points": define({
    key: "agent.commission_basis_points",
    group: "Agents",
    label: "Agent's share of our fee",
    description: "On every transfer an agent brings in, this share of our part of the fee is paid into the agent's wallet, in basis points. 2000 is 20 percent. An agent given a share of their own on their page is paid that instead.",
    fallback: 2_000,
    validate: intBetween(0, 10_000, "basis points"),
    format: bp,
  }),
  "agent.discount_basis_points": define({
    key: "agent.discount_basis_points",
    group: "Agents",
    label: "Agent's discount on purchases",
    description: "How much below face value an agent pays when buying airtime or bundles for customers from their wallet, in basis points. 200 is 2 percent. This is the rate for every agent who has no rate of their own set on their page.",
    fallback: 200,
    validate: intBetween(0, 2_000, "basis points"),
    format: bp,
  }),
  "agent.min_topup_kobo": define({
    key: "agent.min_topup_kobo",
    group: "Agents",
    label: "Smallest wallet top-up",
    description: "An agent cannot top up their wallet by less than this.",
    fallback: 100_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "agent.credit_enabled": define({
    key: "agent.credit_enabled",
    group: "Agents",
    label: "Credit lines for agents",
    description: "When on, an agent with a credit line can buy beyond what their wallet holds, up to their limit. When off, every agent is prepaid and nothing already owed is written off.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "agent.credit_max_kobo": define({
    key: "agent.credit_max_kobo",
    group: "Agents",
    label: "Largest credit line one agent may be given",
    description: "The ceiling on any one agent's credit line. A limit above this is refused on the agent's page, so a slip of the finger cannot hand out more than you meant. Zero means no credit line can be given at all.",
    fallback: 0,
    validate: intBetween(0, 1_000_000_000, "kobo"),
    format: kobo,
  }),
  "agent.credit_days": define({
    key: "agent.credit_days",
    group: "Agents",
    label: "Days an agent may stay owing",
    description: "How long an agent's wallet may stay below zero before their credit line stops paying for new purchases. It opens again the moment they top up enough to clear what they owe.",
    fallback: 7,
    validate: intBetween(1, 90, "count"),
    format: (v) => `${v} days`,
  }),
  "agent.api_enabled": define({
    key: "agent.api_enabled",
    group: "Agents",
    label: "The agent interface for other software",
    description: "When on, an agent's own till or POS software can buy through the interface at /api/v1 with a key they create in their portal. When off, every key is refused and the browser pages still work.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "agent.api_rate_per_minute": define({
    key: "agent.api_rate_per_minute",
    group: "Agents",
    label: "Requests a key may make each minute",
    description: "How many requests one key may make in a minute before it is asked to wait. A till buying one customer at a time needs a handful; a busy POS network needs more.",
    fallback: 120,
    validate: intBetween(1, 6_000, "count"),
    format: (v) => `${v} a minute`,
  }),
  "sellback.airtime_enabled": define({
    key: "sellback.airtime_enabled",
    group: "Buying back",
    label: "Buy airtime back from people",
    description: "When on, somebody can send us airtime they cannot use and take credit, or cash where that is also on. When off, the page says we are not buying and nothing already owed is affected.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "sellback.data_enabled": define({
    key: "sellback.data_enabled",
    group: "Buying back",
    label: "Buy data back from people",
    description: "When on, somebody can gift us a data bundle and take credit, or cash where that is also on. Only bundles marked as giftable can be sent to us.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "sellback.cash_enabled": define({
    key: "sellback.cash_enabled",
    group: "Buying back",
    label: "Pay sellers in cash as well as credit",
    description:
      "When off, a seller can only take credit to spend with us, which never leaves the business and cannot be used to turn stolen value into money. When on, they may instead ask for a bank transfer, which a person settles by hand after the holding time below. Read docs/SELLBACK.md before turning this on.",
    fallback: false,
    validate: boolean(),
    format: (v) => (v ? "on" : "off"),
  }),
  "sellback.airtime_rate_basis_points": define({
    key: "sellback.airtime_rate_basis_points",
    group: "Buying back",
    label: "What we pay for airtime",
    description:
      "Share of the airtime's face value we pay for it, in basis points, per network. 8000 is 80 percent, so N1,000 of airtime earns the seller N800. Zero means we do not buy airtime on that network. It must stay below the cheapest price anybody can buy that airtime from us, or the same naira could be bought and sold round in a circle at our expense.",
    fallback: { MTN: 8_000, AIRTEL: 8_000, GLO: 8_000, "9MOBILE": 8_000 } as PerNetwork<number>,
    validate: perNetwork(intBetween(0, 9_900, "basis points")),
    format: each((v) => (v === 0 ? "not buying" : bp(v))),
  }),
  "sellback.data_rate_basis_points": define({
    key: "sellback.data_rate_basis_points",
    group: "Buying back",
    label: "What we pay for data",
    description:
      "Share of a bundle's catalogue price we pay for it, in basis points, per network. Data is worth less to us than airtime because it expires and can only be sold on in whole bundles. Zero means we do not buy data on that network.",
    fallback: { MTN: 7_000, AIRTEL: 7_000, GLO: 7_000, "9MOBILE": 7_000 } as PerNetwork<number>,
    validate: perNetwork(intBetween(0, 9_900, "basis points")),
    format: each((v) => (v === 0 ? "not buying" : bp(v))),
  }),
  "sellback.min_margin_basis_points": define({
    key: "sellback.min_margin_basis_points",
    group: "Buying back",
    label: "Gap we keep between buying and selling",
    description:
      "How far below the cheapest price anybody can buy from us our buying rate must stay, in basis points. 300 is 3 percent. This is the guard against a circle: buy airtime from us at a discount, sell it back for more than it cost, repeat. A rate that breaks this guard is refused when saved and again when somebody asks for a quote.",
    fallback: 300,
    validate: intBetween(0, 5_000, "basis points"),
    format: bp,
  }),
  "sellback.min_kobo": define({
    key: "sellback.min_kobo",
    group: "Buying back",
    label: "Smallest we will buy",
    description: "Below this the network's own transfer fee and our handling make the deal worthless to both sides.",
    fallback: 10_000,
    validate: intBetween(100, 100_000_000, "kobo"),
    format: kobo,
  }),
  "sellback.max_kobo": define({
    key: "sellback.max_kobo",
    group: "Buying back",
    label: "Largest we will buy at once",
    description: "The most value one sale may carry. Keep it low while you learn who is selling: a large sale is the shape fraud takes.",
    fallback: 2_000_000,
    validate: intBetween(10_000, 1_000_000_000, "kobo"),
    format: kobo,
  }),
  "sellback.seller_daily_max_kobo": define({
    key: "sellback.seller_daily_max_kobo",
    group: "Buying back",
    label: "Most one number may sell in a day",
    description: "Counted in Lagos days against the selling number, whatever it was paid in. A number that has reached it is told what is left.",
    fallback: 2_000_000,
    validate: intBetween(10_000, 1_000_000_000, "kobo"),
    format: kobo,
  }),
  "sellback.daily_buy_cap_kobo": define({
    key: "sellback.daily_buy_cap_kobo",
    group: "Buying back",
    label: "Most we will buy in a day",
    description:
      "The face value of airtime and data we will take in on each network in one Lagos day. Zero means we buy nothing on that network, so this has to be set before buying back does anything. It is the cap on how much stock we can be left holding.",
    fallback: zeroPerNetwork,
    validate: perNetwork(intBetween(0, 10_000_000_000, "kobo")),
    format: each((v) => (v === 0 ? "not buying" : kobo(v))),
  }),
  "sellback.window_minutes": define({
    key: "sellback.window_minutes",
    group: "Buying back",
    label: "How long a seller has to send",
    description: "After this the quote lapses, and the rate is no longer held. Value that arrives late is still matched during the grace minutes set under Transfers.",
    fallback: 30,
    validate: intBetween(5, 240, "minutes"),
    format: (v) => `${v} minutes`,
  }),
  "sellback.assumed_validity_days": define({
    key: "sellback.assumed_validity_days",
    group: "Buying back",
    label: "How long we assume bought data lasts",
    description:
      "Gifted data keeps the validity the seller's own bundle had, which the network never tells us. Bought data is therefore recorded as expiring in this many days, or the bundle's own validity if that is shorter, so the pool is never worth more on paper than it is in practice. Data still on hand after that is written off as a loss you can see.",
    fallback: 7,
    validate: intBetween(1, 365, "count"),
    format: (v) => `${v} days`,
  }),
  "sellback.cash_hold_hours": define({
    key: "sellback.cash_hold_hours",
    group: "Buying back",
    label: "Holding time before cash can be paid",
    description:
      "How long a cash payout waits after the value lands before a person may settle it. The wait is what gives you time to notice a stolen line or a run of sales from one place, and it is the single cheapest control you have.",
    fallback: 24,
    validate: intBetween(0, 720, "count"),
    format: (v) => (v === 0 ? "no wait" : `${v} hours`),
  }),
  "sellback.cash_daily_cap_kobo": define({
    key: "sellback.cash_daily_cap_kobo",
    group: "Buying back",
    label: "Most cash we will pay out in a day",
    description: "Across all sellers, counted in Lagos days on what was settled. Zero means no cash is paid at all, whatever the switch above says.",
    fallback: 0,
    validate: intBetween(0, 1_000_000_000, "kobo"),
    format: (v) => (v === 0 ? "no cash" : kobo(v)),
  }),
  "pool.floor_kobo": define({
    key: "pool.floor_kobo",
    group: "Pools",
    label: "Pool warning level",
    description: "The command centre turns red when a network's pool falls below this.",
    fallback: zeroPerNetwork,
    validate: perNetwork(intBetween(0, 10_000_000_000, "kobo")),
    format: each(kobo),
  }),
  "network.daily_transfer_cap_kobo": define({
    key: "network.daily_transfer_cap_kobo",
    group: "Networks",
    label: "Network's own daily transfer cap",
    description:
      "How much airtime each network lets one subscriber transfer in a day, from the network's current terms. Zero means not yet entered, and the launch checklist stays red until it is.",
    fallback: zeroPerNetwork,
    validate: perNetwork(intBetween(0, 10_000_000_000, "kobo")),
    format: each(kobo),
  }),
  "network.sender_ids": define({
    key: "network.sender_ids",
    group: "Networks",
    label: "Who the network's messages come from",
    description:
      "The names or short numbers the network's own text messages come from, separated by commas, for example MTN, MTNN, 131. A message about airtime is only believed when it comes from one of these, because anyone can send a text message that reads like one. A message from anywhere else is kept on the Airtime in page for a person to look at, with the sender named, so a missing name here is easy to spot and add. Empty means nothing on that network is believed.",
    fallback: { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" } as PerNetwork<string>,
    validate: perNetwork(text(200)),
    format: each((v) => (v === "" ? "nothing believed" : v)),
  }),
  "network.inbound_pattern": define({
    key: "network.inbound_pattern",
    group: "Networks",
    label: "How to read the network's airtime received message",
    description:
      "A pattern with (?<amount>...) for the naira amount and (?<sender>...) for the sender's number, matched against the text message the network sends when airtime arrives. Empty means the built-in pattern, which looks for the first amount after the word received and the first phone number. Test it on the Phone bridge page before saving.",
    fallback: emptyPerNetwork,
    validate: perNetwork(text(400)),
    format: each((v) => (v === "" ? "built-in" : v)),
  }),
  "network.data_gift_code": define({
    key: "network.data_gift_code",
    group: "Networks",
    label: "Data gifting code the sender dials",
    description:
      "The network's own code for gifting data to another number on the same network, with {number} and where the network needs them {size} and {pin}, for example *131*{number}*{size}#. Empty means data cannot be sent from this network yet.",
    fallback: emptyPerNetwork,
    validate: perNetwork(dialCode(60)),
    format: each((v) => (v === "" ? "not set" : v)),
  }),
  "network.data_inbound_pattern": define({
    key: "network.data_inbound_pattern",
    group: "Networks",
    label: "How to read the network's data received message",
    description:
      "A pattern with (?<size>...) for the amount of data, like 1GB or 500MB, and (?<sender>...) for the sender's number, matched against the message the network sends when data is gifted to us. Empty means the built-in pattern. Test it on the Phone bridge page.",
    fallback: emptyPerNetwork,
    validate: perNetwork(text(400)),
    format: each((v) => (v === "" ? "built-in" : v)),
  }),
  "network.sent_pattern": define({
    key: "network.sent_pattern",
    group: "Networks",
    label: "How to read the network's airtime sent confirmation",
    description:
      "A pattern matched against the network's reply or text message after our SIM sends airtime or gifts data, with (?<number>...) for the number it went to and, where present, (?<amount>...). Empty means the built-in pattern, which looks for words like sent, transferred or successful with the number.",
    fallback: emptyPerNetwork,
    validate: perNetwork(text(400)),
    format: each((v) => (v === "" ? "built-in" : v)),
  }),
  "network.transfer_code": define({
    key: "network.transfer_code",
    group: "Networks",
    label: "Transfer code the sender dials",
    description:
      "The network's own airtime transfer code with {amount}, {number} and {pin} where they go, for example *321*{pin}*{amount}*{number}#. Empty means not yet entered.",
    fallback: emptyPerNetwork,
    validate: perNetwork(dialCode(60)),
    format: each((v) => (v === "" ? "not set" : v)),
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]["fallback"];

export type ResolvedSetting<K extends SettingKey> = {
  key: K;
  value: SettingValue<K>;
  source: "database" | "fallback";
  problem?: string;
};

// Reads a setting. A missing or invalid stored value falls back to the
// registry default and says so, because a wrong number silently applied to
// money is worse than a known default.
export async function getSetting<K extends SettingKey>(db: Queryable, key: K): Promise<ResolvedSetting<K>> {
  const spec = SETTINGS[key] as SettingSpec<SettingValue<K>>;
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = $1", [key]);
  const row = rows[0];
  if (!row) return { key, value: spec.fallback, source: "fallback" };
  const r = spec.validate(row.value);
  if (!r.ok) {
    return { key, value: spec.fallback, source: "fallback", problem: `stored value ${r.reason}` };
  }
  return { key, value: r.value, source: "database" };
}

export async function getSettingValue<K extends SettingKey>(db: Queryable, key: K): Promise<SettingValue<K>> {
  return (await getSetting(db, key)).value;
}

// Reads several settings in one query. Callers holding a single connection
// must not run queries in parallel on it, and one round trip is quicker anyway.
export async function getSettingValues<const K extends readonly SettingKey[]>(
  db: Queryable,
  keys: K,
): Promise<{ [I in keyof K]: SettingValue<K[I] & SettingKey> }> {
  const { rows } = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key = ANY($1)", [keys]);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return keys.map((key) => {
    const spec = SETTINGS[key] as SettingSpec<unknown>;
    if (!stored.has(key)) return spec.fallback;
    const r = spec.validate(stored.get(key));
    return r.ok ? r.value : spec.fallback;
  }) as { [I in keyof K]: SettingValue<K[I] & SettingKey> };
}

// Writes a setting inside the caller's transaction. The audit trigger records
// who changed it and from what.
export async function setSetting<K extends SettingKey>(db: Queryable, actor: string, key: K, value: unknown): Promise<SettingValue<K>> {
  const spec = SETTINGS[key] as SettingSpec<SettingValue<K>>;
  const r = spec.validate(value);
  if (!r.ok) {
    throw new UserFacingError("setting_out_of_range", `${spec.label} ${r.reason}. Nothing was changed.`);
  }
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(r.value), actor],
  );
  return r.value;
}

export async function getAllSettings(db: Queryable): Promise<ResolvedSetting<SettingKey>[]> {
  const out: ResolvedSetting<SettingKey>[] = [];
  for (const key of Object.keys(SETTINGS) as SettingKey[]) out.push(await getSetting(db, key));
  return out;
}
