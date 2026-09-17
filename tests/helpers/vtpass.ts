import { createServer, type Server } from "node:http";

// A stand-in for VTpass that answers the way their interface does, with a
// script of answers per request id, and remembers every call it received.
export type Scripted = { pay?: unknown | Error; requery?: unknown[] };

export class FakeVtpass {
  server!: Server;
  base = "";
  calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  script = new Map<string, Scripted>();
  defaultPay: (body: { request_id: string; serviceID: string; amount: number; phone: string }) => unknown = (b) => delivered(b.request_id, b.amount);
  balance: number | undefined = 12_345.5;
  variations?: Record<string, { variation_code: string; name: string; variation_amount: string }[]>;
  keys = { api: "api-test", secret: "secret-test", public: "public-test" };

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
        this.calls.push({ method: req.method!, path: req.url!, headers, body });
        const answer = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (headers["api-key"] !== this.keys.api) return answer(200, { code: "017", response_description: "INVALID CREDENTIALS" });
        if (req.method === "GET" && req.url!.startsWith("/service-variations")) {
          if (headers["public-key"] !== this.keys.public) return answer(200, { code: "017", response_description: "INVALID CREDENTIALS" });
          const serviceID = new URL(req.url!, "http://x").searchParams.get("serviceID") ?? "";
          return answer(200, { code: "000", response_description: "000", content: { ServiceName: serviceID, serviceID, varations: this.variations?.[serviceID] ?? [] } });
        }
        if (req.method === "GET" && req.url === "/balance") {
          return this.balance === undefined ? answer(404, { message: "no such page" }) : answer(200, { code: "000", contents: { balance: this.balance } });
        }
        if (headers["secret-key"] !== this.keys.secret) return answer(200, { code: "017", response_description: "INVALID CREDENTIALS" });
        if (req.method === "POST" && req.url === "/pay") {
          const s = this.script.get(body.request_id);
          if (s?.pay instanceof Error) {
            req.socket.destroy();
            return;
          }
          return answer(200, s?.pay ?? this.defaultPay(body));
        }
        if (req.method === "POST" && req.url === "/requery") {
          const s = this.script.get(body.request_id);
          const next = s?.requery?.shift();
          return answer(200, next ?? { code: "000", response_description: "TRANSACTION SUCCESSFUL", content: { transactions: { status: "delivered", transactionId: "req-" + body.request_id, amount: 480, commission: 14.4, total_amount: 465.6 } } });
        }
        answer(404, { message: "no such page" });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }

  stop(): void {
    this.server.close();
  }

  payCalls(): number {
    return this.calls.filter((c) => c.path === "/pay").length;
  }
}

export function delivered(requestId: string, amountNaira: number, commissionNaira = Math.round(amountNaira * 3) / 100): unknown {
  return {
    code: "000",
    response_description: "TRANSACTION SUCCESSFUL",
    requestId,
    amount: amountNaira,
    content: { transactions: { status: "delivered", transactionId: "vt-" + requestId, amount: amountNaira, commission: commissionNaira, total_amount: Math.round((amountNaira - commissionNaira) * 100) / 100 } },
  };
}
export const processing = (requestId: string) => ({ code: "099", response_description: "TRANSACTION IS PROCESSING", requestId, content: { transactions: { status: "pending" } } });
export const lowWallet = { code: "018", response_description: "LOW WALLET BALANCE" };
export const failed = { code: "016", response_description: "TRANSACTION FAILED" };
export const billerDown = { code: "030", response_description: "BILLER NOT REACHABLE AT THIS POINT" };
