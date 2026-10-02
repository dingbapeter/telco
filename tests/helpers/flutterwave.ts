import { createServer, type Server } from "node:http";

// A stand-in for Flutterwave: a hosted payment link, verification by our own
// reference, and balances. Serves under /v3 like the real one, so the path
// joining in the adapter is exercised rather than assumed.
//
// Amounts here are in naira, with decimals, because that is what Flutterwave
// works in. Our side works in kobo. That difference is the whole reason this
// fake exists.
export class FakeFlutterwave {
  server!: Server;
  base = "";
  secret = "FLWSECK_TEST-abc123";
  webhookSecret = "a-long-secret-hash";
  balance = "250000.00";
  // By our reference, as Flutterwave would answer it.
  verifications = new Map<string, { status: string; amount: string | number; app_fee: string | number; currency: string; payment_type: string }>();
  calls: { method: string; path: string; auth: string; body: unknown }[] = [];
  failNext = false;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as unknown) : undefined;
        this.calls.push({ method: req.method!, path: req.url!, auth: String(req.headers.authorization ?? ""), body });
        const answer = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${this.secret}`) return answer(401, { status: "error", message: "Authorization required" });
        if (this.failNext) {
          this.failNext = false;
          return answer(400, { status: "error", message: "Merchant does not have access to this feature" });
        }
        if (req.method === "POST" && req.url === "/v3/payments") {
          const txRef = (body as { tx_ref?: string } | undefined)?.tx_ref ?? "";
          return answer(200, { status: "success", message: "Hosted Link", data: { link: `${this.base}/pay/${txRef}` } });
        }
        if (req.method === "GET" && req.url!.startsWith("/v3/transactions/verify_by_reference")) {
          const ref = new URL(req.url!, this.base).searchParams.get("tx_ref") ?? "";
          const v = this.verifications.get(ref);
          if (!v) return answer(404, { status: "error", message: "No transaction was found for this id" });
          return answer(200, {
            status: "success",
            message: "Transaction fetched successfully",
            data: { id: 123456, tx_ref: ref, status: v.status, amount: v.amount, charged_amount: v.amount, app_fee: v.app_fee, currency: v.currency, payment_type: v.payment_type },
          });
        }
        if (req.method === "GET" && req.url === "/v3/balances") {
          return answer(200, { status: "success", data: [{ currency: "USD", available_balance: "10.00" }, { currency: "NGN", available_balance: this.balance, ledger_balance: this.balance }] });
        }
        answer(404, { status: "error", message: "no such page" });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }

  stop(): void {
    this.server.close();
  }

  // The real one echoes the secret hash we set in its dashboard. There is no
  // signing of the body, which is why our side never believes the body.
  get verifHash(): string {
    return this.webhookSecret;
  }
}
