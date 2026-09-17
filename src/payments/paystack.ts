import { createHmac, timingSafeEqual } from "node:crypto";
import { formatNaira } from "../money.ts";

// Paystack takes money from a buyer by card, bank transfer or USSD and
// tells us when it has settled. Their interface: POST /transaction/initialize
// with email, amount in kobo, our reference and a callback address, which
// returns a page to send the buyer to; GET /transaction/verify/<reference>
// to read the result; GET /balance to knock; every call carries the secret
// key as a bearer token; and a webhook signed with HMAC SHA512 of the raw
// body using the secret key.

export type PaystackConfig = { baseUrl: string; secretKey: string };

export function paystackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaystackConfig | undefined {
  const secretKey = env["PAYSTACK_SECRET_KEY"];
  if (!secretKey) return undefined;
  return { baseUrl: (env["PAYSTACK_BASE_URL"] ?? "https://api.paystack.co").replace(/\/$/, ""), secretKey };
}

export type Verification = { status: "success" | "pending" | "failed"; amountKobo: number; feesKobo: number; channel: string; reference: string };

export class PaystackProvider {
  readonly name = "paystack";
  readonly cashAccount = "cash:paystack";
  private config: PaystackConfig;
  private fetchImpl: typeof fetch;

  constructor(config: PaystackConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get isTestMode(): boolean {
    return this.config.secretKey.startsWith("sk_test_");
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: boolean; message?: string; data?: unknown }> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(30_000) };
    if (body) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(this.config.baseUrl + path, init);
    const text = await res.text();
    let parsed: { status: boolean; message?: string; data?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`Paystack answered something that is not JSON on ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (res.status === 401) throw new Error("Paystack refused the secret key. Check PAYSTACK_SECRET_KEY in the environment file.");
    return parsed;
  }

  // Starts a payment and returns the page to send the buyer to.
  async initialize(input: { reference: string; amountKobo: number; email: string; callbackUrl: string }): Promise<{ url: string }> {
    const r = await this.call("POST", "/transaction/initialize", {
      reference: input.reference,
      amount: input.amountKobo,
      email: input.email,
      callback_url: input.callbackUrl,
      channels: ["card", "bank", "ussd", "bank_transfer", "qr", "mobile_money"],
    });
    const data = r.data as { authorization_url?: string } | undefined;
    if (!r.status || !data?.authorization_url) throw new Error(`Paystack would not start the payment: ${r.message ?? "no reason given"}`);
    return { url: data.authorization_url };
  }

  // Reads the result of a payment from Paystack itself. A redirect back to
  // us proves nothing; this does.
  async verify(reference: string): Promise<Verification> {
    const r = await this.call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    const data = r.data as { status?: string; amount?: number; fees?: number | null; channel?: string; reference?: string } | undefined;
    if (!r.status || !data) return { status: "pending", amountKobo: 0, feesKobo: 0, channel: "", reference };
    const status = data.status === "success" ? "success" : data.status === "failed" || data.status === "abandoned" || data.status === "reversed" ? "failed" : "pending";
    return { status, amountKobo: Number(data.amount ?? 0), feesKobo: Number(data.fees ?? 0), channel: data.channel ?? "", reference: data.reference ?? reference };
  }

  // A webhook is only believed when its signature matches our secret key.
  verifySignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac("sha512", this.config.secretKey).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async health(): Promise<{ ok: boolean; message: string; balanceKobo?: number }> {
    try {
      const r = await this.call("GET", "/balance");
      const rows = (r.data as { currency?: string; balance?: number }[] | undefined) ?? [];
      const ngn = rows.find((x) => x.currency === "NGN") ?? rows[0];
      const balanceKobo = ngn?.balance !== undefined ? Number(ngn.balance) : undefined;
      const mode = this.isTestMode ? " These are test keys; no real money moves." : "";
      return balanceKobo === undefined
        ? { ok: true, message: `Paystack answers and accepts the secret key.${mode}` }
        : { ok: true, message: `Paystack answers and accepts the secret key. Balance with Paystack ${formatNaira(balanceKobo)}.${mode}`, balanceKobo };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

export function paystackFromEnv(env: NodeJS.ProcessEnv = process.env): PaystackProvider | undefined {
  const c = paystackConfigFromEnv(env);
  return c ? new PaystackProvider(c) : undefined;
}
