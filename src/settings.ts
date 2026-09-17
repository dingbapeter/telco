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
  "payout.daily_ceiling_kobo": define({
    key: "payout.daily_ceiling_kobo",
    group: "Guardrails",
    label: "Daily payout ceiling per network",
    description: "Total paid out on each network in a day stops here. Anything more is held for a person to look at.",
    fallback: Object.fromEntries(NETWORK_CODES.map((c) => [c, 5_000_000])) as PerNetwork<number>,
    validate: perNetwork(intBetween(0, 10_000_000_000, "kobo")),
    format: each(kobo),
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
  "network.transfer_code": define({
    key: "network.transfer_code",
    group: "Networks",
    label: "Transfer code the sender dials",
    description:
      "The network's own airtime transfer code with {amount}, {number} and {pin} where they go, for example *321*{pin}*{amount}*{number}#. Empty means not yet entered.",
    fallback: emptyPerNetwork,
    validate: perNetwork(text(60)),
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
