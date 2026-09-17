// All amounts are integer kobo. Floating point never touches money.

export const KOBO_PER_NAIRA = 100;

export function naira(amount: number): number {
  if (!Number.isInteger(amount)) {
    throw new Error(`naira() takes whole naira; got ${amount}. Use kobo() for fractions.`);
  }
  return amount * KOBO_PER_NAIRA;
}

export function assertKobo(value: unknown, what = "amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${what} must be an integer number of kobo; got ${String(value)}`);
  }
  return value;
}

// Formats 123456 as "N1,234.56". Whole naira drops the kobo so amounts in the
// interface read the way people say them.
export function formatNaira(kobo: number): string {
  assertKobo(kobo);
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / KOBO_PER_NAIRA);
  const rest = abs % KOBO_PER_NAIRA;
  const wholeText = whole.toLocaleString("en-NG");
  return rest === 0 ? `${sign}N${wholeText}` : `${sign}N${wholeText}.${String(rest).padStart(2, "0")}`;
}

// Parses what a person typed: "500", "1,500", "N1500", "250.50".
export function parseNaira(text: string): number | undefined {
  const cleaned = text.trim().replace(/^[Nn₦]\s*/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [wholePart, fraction = ""] = cleaned.split(".");
  return Number(wholePart) * KOBO_PER_NAIRA + Number(fraction.padEnd(2, "0"));
}

// Basis points avoid the rounding surprises of percentages stored as floats.
// 425 basis points is 4.25 percent. Result rounds half up to the nearest kobo.
export function applyBasisPoints(kobo: number, basisPoints: number): number {
  assertKobo(kobo);
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error(`basis points must be a non-negative integer; got ${basisPoints}`);
  }
  return Math.floor((kobo * basisPoints + 5000) / 10000);
}
