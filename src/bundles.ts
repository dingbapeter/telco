import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { formatNaira } from "./money.ts";
import { getSettingValue, NETWORK_CODES, type NetworkCode } from "./settings.ts";

export type Bundle = {
  id: number;
  network_code: NetworkCode;
  code: string;
  name: string;
  size_mb: number;
  validity_days: number | null;
  price_kobo: number;
  provider_variation_code: string | null;
  giftable: boolean;
  active: boolean;
  source: "manual" | "vtpass";
  updated_at: Date;
};

export function describeSize(mb: number): string {
  if (mb % 1024 === 0) return `${mb / 1024}GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 512 === 0 ? 1 : 2).replace(/\.?0+$/, "")}GB`;
  return `${mb}MB`;
}

export function describeBundle(b: Bundle): string {
  return `${b.name} (${describeSize(b.size_mb)}${b.validity_days ? `, ${b.validity_days} days` : ""}, ${formatNaira(b.price_kobo)})`;
}

// "1GB", "1.5 GB", "500MB", "2gb" as people and networks write them.
export function parseSizeMb(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb|g|m)\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mb = unit.startsWith("g") ? Math.round(n * 1024) : Math.round(n);
  return mb > 0 ? mb : undefined;
}

export async function listBundles(db: Queryable, options: { network?: string; activeOnly?: boolean; giftableOnly?: boolean } = {}): Promise<Bundle[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.network) where.push(`network_code = $${params.push(options.network.toUpperCase())}`);
  if (options.activeOnly) where.push("active");
  if (options.giftableOnly) where.push("giftable");
  const { rows } = await db.query<Bundle>(`SELECT * FROM data_bundles ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY network_code, size_mb, price_kobo`, params);
  return rows;
}

export async function getBundle(db: Queryable, id: number): Promise<Bundle | undefined> {
  return (await db.query<Bundle>("SELECT * FROM data_bundles WHERE id = $1", [id])).rows[0];
}

export async function activeBundle(db: Queryable, id: number, network?: string): Promise<Bundle> {
  const b = await getBundle(db, id);
  if (!b || !b.active) throw new UserFacingError("no_such_bundle", "That data bundle is not on offer. Choose another.");
  if (network && b.network_code !== network.toUpperCase()) throw new UserFacingError("bundle_network", `That bundle is for ${b.network_code}, not ${network.toUpperCase()}.`);
  return b;
}

// Data somebody else sends us has to live long enough for us to sell it on
// again, or we have paid for something that dies on our hands. The floor is a
// setting the founder moves; a bundle whose validity nobody has written down
// is refused whatever the floor says, because data we cannot date is data we
// cannot value, cannot sell with a straight face and cannot write off on
// time.
export async function takeInCheck(db: Queryable, bundle: Bundle): Promise<{ ok: true } | { ok: false; reason: string }> {
  const floor = await getSettingValue(db, "sellback.min_validity_days");
  if (!bundle.validity_days) {
    return { ok: false, reason: `We cannot take ${bundle.name} because nobody has recorded how long it lasts. Choose another bundle.` };
  }
  if (bundle.validity_days < floor) {
    return {
      ok: false,
      reason: `We only take data that lasts ${floor} days or more, and ${describeBundle(bundle)} lasts ${bundle.validity_days} days. Choose a bundle with a longer life.`,
    };
  }
  return { ok: true };
}

// How long to treat data gifted to us as lasting. Gifted data carries
// whatever validity the sender's own bundle had left, which the network never
// tells us, so we assume the founder's figure and never more than the
// bundle's own life. The same assumption whether the data came in on a
// transfer or was sold to us: it is the same unknown either way.
export async function assumedValidityDays(db: Queryable, bundle: { validity_days: number | null } | undefined): Promise<number> {
  const assumed = await getSettingValue(db, "sellback.assumed_validity_days");
  return Math.min(assumed, bundle?.validity_days ?? assumed);
}

// The bundles we are willing to take in: giftable, on offer, and long enough
// lived. Every list a person chooses from uses this, so nobody is offered a
// bundle that would be refused after they had sent it.
export async function takeableBundles(db: Queryable, network?: string): Promise<Bundle[]> {
  const floor = await getSettingValue(db, "sellback.min_validity_days");
  const all = await listBundles(db, { ...(network ? { network } : {}), activeOnly: true, giftableOnly: true });
  return all.filter((b) => b.validity_days !== null && b.validity_days >= floor);
}

export type BundleInput = { network: string; code: string; name: string; sizeMb: number; validityDays?: number | null; priceKobo: number; providerVariationCode?: string | null; giftable?: boolean; active?: boolean; source?: "manual" | "vtpass" };

// Adds or updates one bundle. A provider fetch never overwrites a price a
// person has set by hand: manual entries keep their source and their price.
export async function upsertBundle(db: Queryable, input: BundleInput): Promise<Bundle> {
  const network = input.network.toUpperCase();
  if (!(NETWORK_CODES as readonly string[]).includes(network)) throw new UserFacingError("unknown_network", "Choose a network.");
  if (!input.code.trim() || !input.name.trim()) throw new UserFacingError("bundle_fields", "A bundle needs a code and a name.");
  if (!Number.isInteger(input.sizeMb) || input.sizeMb <= 0) throw new UserFacingError("bundle_size", "The size must be a whole number of megabytes above zero.");
  if (!Number.isSafeInteger(input.priceKobo) || input.priceKobo <= 0) throw new UserFacingError("bundle_price", "The price must be above zero.");
  const source = input.source ?? "manual";
  const { rows } = await db.query<Bundle>(
    `INSERT INTO data_bundles (network_code, code, name, size_mb, validity_days, price_kobo, provider_variation_code, giftable, active, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (network_code, code) DO UPDATE SET
       name = CASE WHEN data_bundles.source = 'manual' AND EXCLUDED.source = 'vtpass' THEN data_bundles.name ELSE EXCLUDED.name END,
       size_mb = CASE WHEN data_bundles.source = 'manual' AND EXCLUDED.source = 'vtpass' THEN data_bundles.size_mb ELSE EXCLUDED.size_mb END,
       validity_days = CASE WHEN data_bundles.source = 'manual' AND EXCLUDED.source = 'vtpass' THEN data_bundles.validity_days ELSE EXCLUDED.validity_days END,
       price_kobo = CASE WHEN data_bundles.source = 'manual' AND EXCLUDED.source = 'vtpass' THEN data_bundles.price_kobo ELSE EXCLUDED.price_kobo END,
       provider_variation_code = coalesce(EXCLUDED.provider_variation_code, data_bundles.provider_variation_code),
       giftable = CASE WHEN EXCLUDED.source = 'vtpass' THEN data_bundles.giftable ELSE EXCLUDED.giftable END,
       active = CASE WHEN EXCLUDED.source = 'vtpass' THEN data_bundles.active ELSE EXCLUDED.active END,
       source = CASE WHEN data_bundles.source = 'manual' THEN 'manual' ELSE EXCLUDED.source END,
       updated_at = now()
     RETURNING *`,
    [network, input.code.trim(), input.name.trim(), input.sizeMb, input.validityDays ?? null, input.priceKobo, input.providerVariationCode ?? null, input.giftable ?? false, input.active ?? true, source],
  );
  return rows[0]!;
}

// Reads the size out of a provider's bundle name, like "MTN 1.5GB - 30 days".
export function sizeFromName(name: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(GB|MB|TB)/i.exec(name);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  return Math.round(unit === "TB" ? n * 1024 * 1024 : unit === "GB" ? n * 1024 : n);
}

export function validityFromName(name: string): number | null {
  const m = /(\d+)\s*(day|days|month|months|week|weeks)/i.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit.startsWith("month") ? n * 30 : unit.startsWith("week") ? n * 7 : n;
}
