import { flutterwaveFromEnv } from "./flutterwave.ts";
import type { PaymentGateway } from "./gateway.ts";
import { paystackFromEnv } from "./paystack.ts";

// Which gateway is in use: Flutterwave where its key is on the server, else
// Paystack where its key is, else none and the pages say that paying online is
// not set up. Both keys at once means Flutterwave, and the other is left
// alone rather than deleted: a gateway nobody is using takes no money and
// costs nothing to keep.
//
// Its own file so that neither adapter has to import the other, and so the
// choice is one line somebody can read.
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentGateway | undefined {
  return flutterwaveFromEnv(env) ?? paystackFromEnv(env);
}
