import { randomBytes } from "node:crypto";
import { formatNaira } from "../money.ts";
import { type NetworkCode } from "../settings.ts";
import type { PayoutRail, ProviderBundle, RailHealth, SendInput, SendResult } from "./rail.ts";

// VTpass sells airtime on every Nigerian network through an interface our
// server calls. Their interface, as confirmed against three independent
// client libraries: POST /pay with request_id, serviceID, amount in naira
// and phone; POST /requery with request_id; api-key and secret-key headers
// on POST, api-key and public-key on GET; code "000" is success, "099" is
// still processing, and content.transactions.status says whether the
// airtime was delivered.

export const VTPASS_SERVICE_IDS: Record<NetworkCode, string> = { MTN: "mtn", AIRTEL: "airtel", GLO: "glo", "9MOBILE": "etisalat" };

export type VtpassConfig = { baseUrl: string; apiKey: string; secretKey: string; publicKey: string };

// The keys come from the environment file on the server and nowhere else.
export function vtpassConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VtpassConfig | undefined {
  const apiKey = env["VTPASS_API_KEY"];
  const secretKey = env["VTPASS_SECRET_KEY"];
  const publicKey = env["VTPASS_PUBLIC_KEY"] ?? "";
  if (!apiKey || !secretKey) return undefined;
  const baseUrl = env["VTPASS_BASE_URL"] ?? (env["VTPASS_ENV"] === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, secretKey, publicKey };
}

// VTpass wants the request id to begin with the Lagos date and time to the
// minute; the rest is ours and must be unique.
export function newRequestId(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts["year"]}${parts["month"]}${parts["day"]}${parts["hour"]}${parts["minute"]}${randomBytes(6).toString("hex")}`;
}

type VtpassResponse = {
  code?: string;
  response_description?: string;
  requestId?: string;
  amount?: string | number;
  content?: {
    transactions?: { status?: string; transactionId?: string; amount?: string | number; commission?: string | number; total_amount?: string | number };
    balance?: string | number;
    error?: string;
  };
  contents?: { balance?: string | number };
};

// What each provider code means for us: done, still working, try again
// later, or stop and let a person look. From the provider's documented
// list, mapped to what a person needs to do next.
export function interpret(body: VtpassResponse): { kind: "delivered" | "processing" | "retry" | "failed"; message: string } {
  const code = body.code ?? "";
  const status = (body.content?.transactions?.status ?? "").toLowerCase();
  const said = body.response_description ? ` The provider said: ${body.response_description}.` : "";
  if (code === "000") {
    if (status === "delivered") return { kind: "delivered", message: "Delivered." };
    if (status === "failed" || status === "reversed") return { kind: "retry", message: `The provider accepted the request but the network did not deliver.${said}` };
    return { kind: "processing", message: `The provider is still working on it.${said}` };
  }
  if (code === "099") return { kind: "processing", message: `The provider is still working on it.${said}` };
  if (code === "018") return { kind: "retry", message: `The VTpass wallet is too low to pay this. Fund the wallet at vtpass.com, then the transfer will be retried.${said}` };
  if (code === "030" || code === "083") return { kind: "retry", message: `The provider could not reach the network just now.${said}` };
  if (code === "019") return { kind: "processing", message: `The provider already has this request; checking its result.${said}` };
  if (code === "016") return { kind: "failed", message: `The provider reports the transaction failed.${said}` };
  if (code === "021" || code === "034") return { kind: "retry", message: `The VTpass account is locked or the service is suspended. Log in at vtpass.com to see why.${said}` };
  if (code === "011" || code === "012") return { kind: "failed", message: `The provider rejected the request as malformed. This is a bug on our side, not the sender's.${said}` };
  return { kind: "retry", message: `The provider answered with code ${code || "none"}.${said}` };
}

export class VtpassRail implements PayoutRail {
  readonly name = "vtpass";
  readonly fundingAccount = "wallet:vtpass";
  private config: VtpassConfig;
  private fetchImpl: typeof fetch;

  constructor(config: VtpassConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<VtpassResponse> {
    const headers: Record<string, string> = { "api-key": this.config.apiKey, accept: "application/json" };
    if (method === "POST") {
      headers["secret-key"] = this.config.secretKey;
      headers["content-type"] = "application/json";
    } else headers["public-key"] = this.config.publicKey;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
    if (body) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(this.config.baseUrl + path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`VTpass answered HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as VtpassResponse;
    } catch {
      throw new Error(`VTpass answered something that is not JSON on ${path}: ${text.slice(0, 200)}`);
    }
  }

  // Data bundles live under a separate service per network, and the
  // provider names each bundle by a variation code we keep in the catalogue.
  async listDataBundles(network: NetworkCode): Promise<ProviderBundle[]> {
    const body = await this.call("GET", `/service-variations?serviceID=${VTPASS_SERVICE_IDS[network]}-data`);
    if (body.code !== "000") throw new Error(`VTpass would not list ${network} data bundles (code ${body.code}: ${body.response_description ?? ""}).`);
    const raw = ((body.content as { varations?: unknown[]; variations?: unknown[] } | undefined)?.varations ?? (body.content as { variations?: unknown[] } | undefined)?.variations ?? []) as { variation_code?: string; name?: string; variation_amount?: string | number }[];
    return raw
      .filter((v) => v.variation_code && v.name)
      .map((v) => ({ variationCode: String(v.variation_code), name: String(v.name), priceKobo: Math.round(Number(v.variation_amount ?? 0) * 100) }))
      .filter((v) => v.priceKobo > 0);
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.amountKobo % 100 !== 0) {
      return { kind: "failed", message: `VTpass sells in whole naira and this payout is ${formatNaira(input.amountKobo)}. This is a bug on our side.` };
    }
    let body: VtpassResponse;
    try {
      const serviceID = input.bundle ? `${VTPASS_SERVICE_IDS[input.network]}-data` : VTPASS_SERVICE_IDS[input.network];
      const payload: Record<string, unknown> = { request_id: input.requestId, serviceID, amount: input.amountKobo / 100, phone: input.number };
      if (input.bundle) {
        payload["billersCode"] = input.number;
        payload["variation_code"] = input.bundle.variationCode;
      }
      body = await this.call("POST", "/pay", payload);
    } catch (err) {
      return { kind: "unknown", message: `Could not get an answer from VTpass: ${(err as Error).message}. The result will be checked before any retry.` };
    }
    return this.toResult(body);
  }

  async check(requestId: string): Promise<SendResult> {
    let body: VtpassResponse;
    try {
      body = await this.call("POST", "/requery", { request_id: requestId });
    } catch (err) {
      return { kind: "unknown", message: `Could not get an answer from VTpass: ${(err as Error).message}.` };
    }
    return this.toResult(body);
  }

  private toResult(body: VtpassResponse): SendResult {
    const r = interpret(body);
    if (r.kind === "delivered") {
      const t = body.content?.transactions ?? {};
      const commission = Math.round(Number(t.commission ?? 0) * 100);
      const charged = t.total_amount !== undefined ? Math.round(Number(t.total_amount) * 100) : Math.round(Number(t.amount ?? body.amount ?? 0) * 100) - commission;
      return { kind: "delivered", reference: t.transactionId ?? body.requestId ?? "", chargedKobo: Math.max(0, charged), commissionKobo: Math.max(0, commission), message: r.message };
    }
    return { kind: r.kind as "processing" | "retry" | "failed", message: r.message };
  }

  // Knocks on the provider: lists a real product, and reads the wallet
  // balance where the provider offers it. Configured is not working.
  async health(): Promise<RailHealth> {
    try {
      const products = await this.call("GET", "/service-variations?serviceID=mtn");
      if (products.code !== "000") return { ok: false, message: `VTpass answered but refused the keys (code ${products.code}: ${products.response_description ?? ""}). Check VTPASS_API_KEY and VTPASS_PUBLIC_KEY in the environment file.` };
    } catch (err) {
      return { ok: false, message: `VTpass did not answer: ${(err as Error).message}` };
    }
    let balanceKobo: number | undefined;
    try {
      const b = await this.call("GET", "/balance");
      const raw = b.contents?.balance ?? b.content?.balance;
      if (b.code === "000" && raw !== undefined) balanceKobo = Math.round(Number(raw) * 100);
    } catch {
      balanceKobo = undefined;
    }
    return balanceKobo === undefined
      ? { ok: true, message: "VTpass answers and accepts our keys. It did not report a wallet balance; see the balance at vtpass.com." }
      : { ok: true, message: `VTpass answers and accepts our keys. Wallet balance ${formatNaira(balanceKobo)}.`, balanceKobo };
  }
}
