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

// The ways a buyer may pay, in our own words rather than any gateway's. The
// founder picks from these in the command centre and each adapter translates
// them into whatever its gateway calls them, which is why the list lives here
// and not in either adapter.
//
// These are the methods people in Nigeria actually use. Mobile money is
// deliberately absent: the wallets Nigerians hold, such as OPay and PalmPay,
// are reached by ordinary bank transfer, and the mobile money networks that
// need their own method, like M-Pesa in Kenya or MoMo in Ghana, take payment
// in another country's currency. That is the second currency in the ledger
// which is still a decision for the founder, not a line of code.
export const PAYMENT_METHODS = ["bank_transfer", "ussd", "card", "bank_account", "qr"] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

// Short enough for a button a buyer reads at the top of a small screen.
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodName, string> = {
  bank_transfer: "bank transfer",
  ussd: "USSD",
  card: "card",
  bank_account: "bank",
  qr: "a scanned code",
};

// The same methods for the founder, who is choosing between them and needs to
// know what each one actually is.
export const PAYMENT_METHOD_NOTES: Record<PaymentMethodName, string> = {
  bank_transfer: "the buyer pushes money to the gateway from their own bank app",
  ussd: "the buyer's own bank's code, dialled from any phone",
  card: "a card from any country",
  bank_account: "a debit taken straight from the buyer's account",
  qr: "a code the buyer scans, which few people in Nigeria use",
};

// Whether a method can be reversed by the person who paid, weeks later. Cards
// can: a chargeback on airtime that has already been delivered is a loss we
// cannot undo, because nobody can take airtime back off a line. The push
// methods cannot be reversed, which is the reason to prefer them.
export const CAN_BE_CHARGED_BACK: Record<PaymentMethodName, boolean> = {
  bank_transfer: false,
  ussd: false,
  card: true,
  bank_account: true,
  qr: false,
};

// "bank transfer, your bank's USSD code or card", for a button a buyer reads.
export function describeMethods(methods: readonly PaymentMethodName[]): string {
  const words = methods.map((m) => PAYMENT_METHOD_LABELS[m]);
  if (words.length === 0) return "card, bank transfer or USSD";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]!}`;
}

export type StartPayment = { reference: string; amountKobo: number; email: string; callbackUrl: string; methods: readonly PaymentMethodName[] };

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
