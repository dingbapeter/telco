import { timingSafeEqual } from "node:crypto";
import { formatNaira } from "../money.ts";
import { koboFromMajor, majorUnits, type Health, type PaymentGateway, type StartPayment, type Verification, type WebhookRead } from "./gateway.ts";

// Flutterwave takes money from a buyer by card, bank transfer, USSD or mobile
// money, and takes cards issued outside Nigeria, which is why it is here.
//
// Built against their version 3 interface, which is the one in production use:
// POST /v3/payments with our reference as tx_ref returns a page to send the
// buyer to; GET /v3/transactions/verify_by_reference reads the result by that
// same reference; GET /v3/balances knocks. Every call carries the secret key
// as a bearer token. Their version 4 interface exists in public beta with a
// different way of signing in, and moving to it is a job of its own.
//
// Three differences from Paystack are worth knowing, because each is a way to
// lose money quietly:
//
// 1. Amounts are in naira, not kobo. A kobo figure sent as naira charges a
//    hundred times too much. Every amount crossing this file goes through the
//    conversions in gateway.ts.
// 2. A successful charge is called "successful", not "success".
// 3. The webhook header is a fixed secret that we choose, not a signature over
//    the body. So the header proves the message came from somebody who knows
//    the secret, and proves nothing at all about the figures in it: anybody
//    who ever sees one header can forge a body with any amount in it. The
//    figures are therefore always read back from Flutterwave before a naira
//    is booked, which is the same rule the airtime side follows about network
//    messages.

export type FlutterwaveConfig = { baseUrl: string; secretKey: string; webhookSecret: string };

export function flutterwaveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FlutterwaveConfig | undefined {
  const secretKey = env["FLUTTERWAVE_SECRET_KEY"];
  if (!secretKey) return undefined;
  return {
    baseUrl: (env["FLUTTERWAVE_BASE_URL"] ?? "https://api.flutterwave.com/v3").replace(/\/$/, ""),
    secretKey,
    // Without this no webhook is believed, which is safe but means a buyer who
    // closes the tab is never credited until somebody looks. The checklist
    // says so rather than leaving it to be discovered.
    webhookSecret: env["FLUTTERWAVE_WEBHOOK_SECRET"] ?? "",
  };
}

type Answer = { status?: string; message?: string; data?: unknown };

export class FlutterwaveGateway implements PaymentGateway {
  readonly name = "flutterwave";
  readonly label = "Flutterwave";
  readonly cashAccount = "cash:flutterwave";
  // Flutterwave has sent this header under more than one spelling over the
  // years, and a spelling we do not look at would refuse every webhook for
  // ever while looking like a quiet gateway.
  readonly signatureHeaders = ["verif-hash", "verifhash", "flutterwave-signature"] as const;
  private config: FlutterwaveConfig;
  private fetchImpl: typeof fetch;

  constructor(config: FlutterwaveConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get isTestMode(): boolean {
    return this.config.secretKey.includes("TEST");
  }

  get webhookSecretSet(): boolean {
    return this.config.webhookSecret !== "";
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    };
    if (body) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(this.config.baseUrl + path, init);
    const text = await res.text();
    let parsed: Answer;
    try {
      parsed = JSON.parse(text) as Answer;
    } catch {
      throw new Error(`Flutterwave answered something that is not JSON on ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Flutterwave refused the secret key. Check FLUTTERWAVE_SECRET_KEY in the environment file.");
    }
    return parsed;
  }

  // Starts a payment and returns the page to send the buyer to. The payment
  // methods offered are whatever is turned on in the Flutterwave dashboard:
  // naming them here would quietly hide one the founder had just enabled.
  async initialize(input: StartPayment): Promise<{ url: string }> {
    const r = await this.call("POST", "/payments", {
      tx_ref: input.reference,
      amount: majorUnits(input.amountKobo),
      currency: "NGN",
      redirect_url: input.callbackUrl,
      customer: { email: input.email },
      customizations: { title: "Airtime and data", description: `Payment for ${input.reference}` },
    });
    const data = r.data as { link?: string } | undefined;
    if (r.status !== "success" || !data?.link) {
      throw new Error(`Flutterwave would not start the payment: ${r.message ?? "no reason given"}`);
    }
    return { url: data.link };
  }

  // Reads the result from Flutterwave itself. Everything else, the buyer
  // coming back and the webhook alike, only says which reference to ask about.
  async verify(reference: string): Promise<Verification> {
    const r = await this.call("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    const data = r.data as { status?: string; amount?: unknown; charged_amount?: unknown; app_fee?: unknown; currency?: string; payment_type?: string; tx_ref?: string } | undefined;
    if (r.status !== "success" || !data) return { status: "pending", amountKobo: 0, feesKobo: 0, channel: "", reference, currency: "" };
    const state = (data.status ?? "").toLowerCase();
    const status = state === "successful" || state === "success" ? "success" : state === "failed" || state === "cancelled" || state === "reversed" ? "failed" : "pending";
    return {
      status,
      amountKobo: koboFromMajor(data.amount),
      feesKobo: koboFromMajor(data.app_fee),
      channel: data.payment_type ?? "",
      reference: data.tx_ref ?? reference,
      currency: (data.currency ?? "").toUpperCase(),
    };
  }

  // The header is a secret we chose and set in their dashboard, so this says
  // the message is from somebody who knows it. Compared in constant time
  // because it is a secret, and with no secret set nothing is believed.
  verifySignature(_rawBody: string, signature: string | undefined): boolean {
    if (!signature || !this.config.webhookSecret) return false;
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(this.config.webhookSecret, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  readWebhook(rawBody: string): WebhookRead {
    const body = JSON.parse(rawBody) as { event?: string; data?: { tx_ref?: string } };
    return { type: body.event ?? "", reference: body.data?.tx_ref ?? "" };
  }

  async health(): Promise<Health> {
    try {
      const r = await this.call("GET", "/balances");
      const rows = (r.data as { currency?: string; available_balance?: unknown }[] | undefined) ?? [];
      const ngn = rows.find((x) => (x.currency ?? "").toUpperCase() === "NGN") ?? rows[0];
      const balanceKobo = ngn === undefined ? undefined : koboFromMajor(ngn.available_balance);
      const mode = this.isTestMode ? " These are test keys; no real money moves." : "";
      const hook = this.webhookSecretSet ? "" : " No webhook secret is set, so a buyer who closes the tab before coming back is not credited until somebody looks.";
      return balanceKobo === undefined
        ? { ok: true, message: `Flutterwave answers and accepts the secret key.${mode}${hook}` }
        : { ok: true, message: `Flutterwave answers and accepts the secret key. Balance with Flutterwave ${formatNaira(balanceKobo)}.${mode}${hook}`, balanceKobo };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

export function flutterwaveFromEnv(env: NodeJS.ProcessEnv = process.env): FlutterwaveGateway | undefined {
  const c = flutterwaveConfigFromEnv(env);
  return c ? new FlutterwaveGateway(c) : undefined;
}
