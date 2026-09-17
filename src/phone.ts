// Nigerian mobile numbers as people type them: 08031234567, 8031234567,
// +2348031234567, 2348031234567, with spaces or dashes anywhere.
// Stored form is the eleven digit local form starting with 0.

export function normaliseNigerianNumber(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  let local: string;
  if (digits.length === 13 && digits.startsWith("234")) local = "0" + digits.slice(3);
  else if (digits.length === 11 && digits.startsWith("0")) local = digits;
  else if (digits.length === 10 && !digits.startsWith("0")) local = "0" + digits;
  else return undefined;
  // Nigerian mobile numbers start 07, 08 or 09.
  if (!/^0[789]\d{9}$/.test(local)) return undefined;
  return local;
}

export function prefixOf(localNumber: string): string {
  return localNumber.slice(0, 4);
}
