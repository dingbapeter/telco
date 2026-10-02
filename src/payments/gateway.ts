// Taking money from a buyer, behind one door.
//
// Two gateways are supported and the rest of the product knows about neither:
// pages ask the gateway for a page to send the buyer to, and read the result
// back from the gateway itself. That matters more than it looks. The two
// differ in units, in how a webhook is signed and in what a successful status
// is called, and every one of those differences is a way to book the wrong
// amount if it leaks into a page.

export type Verification = {
  status: "success" | "pending" | "failed";
  amountKobo: number;
  feesKobo: number;
  channel: string;
  reference: string;
  // What the buyer was really charged in. We price in naira and ask for naira,
  // so anything else means the figures do not mean what we assume and nothing
  // is booked.
  currency: string;
};

export type StartPayment = { reference: string; amountKobo: number; email: string; callbackUrl: string };

export type WebhookRead = { type: string; reference: string };

export type Health = { ok: boolean; message: string; balanceKobo?: number };

export type PaymentGateway = {
  // The name in the money-in paths and in the webhook table, so one gateway's
  // events can never be mistaken for another's.
  readonly name: string;
  // What a person reads on a page or in the checklist.
  readonly label: string;
  // Where the money sits until the gateway settles it to the bank.
  readonly cashAccount: string;
  readonly isTestMode: boolean;
  // The header the gateway signs its webhooks in, and any other spelling it
  // has been known to use. Node lowercases what arrives, so these are
  // lowercase; a header we do not look at is a webhook refused for ever.
  readonly signatureHeaders: readonly string[];
  initialize(input: StartPayment): Promise<{ url: string }>;
  verify(reference: string): Promise<Verification>;
  verifySignature(rawBody: string, signature: string | undefined): boolean;
  readWebhook(rawBody: string): WebhookRead;
  health(): Promise<Health>;
};

// Naira as a gateway that takes major units wants them, from our kobo. Kept
// here rather than in one adapter because getting it wrong is a factor of a
// hundred in either direction, and the test for it belongs to the idea, not
// to whichever gateway happens to need it.
export function majorUnits(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || kobo <= 0) throw new Error(`An amount to charge must be a whole number of kobo above zero; got ${kobo}`);
  return (kobo / 100).toFixed(2);
}

// And back again, from whatever a gateway sends: "1500", 1500, "1,500.50".
// A figure that is not a number at all is nothing rather than a guess, because
// a guess here is money.
export function koboFromMajor(value: unknown): number {
  if (typeof value === "number") return Math.round(value * 100);
  if (typeof value !== "string") return 0;
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return 0;
  return Math.round(Number(cleaned) * 100);
}
