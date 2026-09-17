import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

// A stand-in for Paystack: initialize, verify, balance, and a way to sign a
// webhook the way Paystack does.
export class FakePaystack {
  server!: Server;
  base = "";
  secret = "sk_test_abc";
  balance = 250_000_00;
  verifications = new Map<string, { status: string; amount: number; fees: number; channel: string }>();
  calls: { method: string; path: string; auth: string; body: unknown }[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        this.calls.push({ method: req.method!, path: req.url!, auth: String(req.headers.authorization ?? ""), body });
        const answer = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${this.secret}`) return answer(401, { status: false, message: "Invalid key" });
        if (req.method === "POST" && req.url === "/transaction/initialize") {
          return answer(200, { status: true, message: "Authorization URL created", data: { authorization_url: `${this.base}/checkout/${body.reference}`, access_code: "ac", reference: body.reference } });
        }
        if (req.method === "GET" && req.url!.startsWith("/transaction/verify/")) {
          const ref = decodeURIComponent(req.url!.slice("/transaction/verify/".length));
          const v = this.verifications.get(ref);
          if (!v) return answer(404, { status: false, message: "Transaction reference not found" });
          return answer(200, { status: true, message: "Verification successful", data: { status: v.status, amount: v.amount, fees: v.fees, channel: v.channel, reference: ref } });
        }
        if (req.method === "GET" && req.url === "/balance") return answer(200, { status: true, data: [{ currency: "NGN", balance: this.balance }] });
        answer(404, { status: false, message: "no such page" });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }

  stop(): void {
    this.server.close();
  }

  sign(rawBody: string, secret = this.secret): string {
    return createHmac("sha512", secret).update(rawBody).digest("hex");
  }
}
