import type { NetworkCode } from "../settings.ts";
import { vtpassConfigFromEnv, VtpassRail } from "./vtpass.ts";

// The four answers a provider can give, and what we do with each:
// delivered, book it; processing, check again later; retry, try again after
// a wait; failed, stop and leave it for a person; unknown, we never got an
// answer, so check the result before any retry, never send again blind.
export type SendResult =
  | { kind: "delivered"; reference: string; chargedKobo: number; commissionKobo: number; message: string }
  | { kind: "processing"; message: string }
  | { kind: "retry"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "unknown"; message: string };

export type RailHealth = { ok: boolean; message: string; balanceKobo?: number };

// What to deliver: airtime of an amount, or a catalogue bundle the provider
// knows by its own variation code.
export type SendInput = { requestId: string; network: NetworkCode; number: string; amountKobo: number; bundle?: { variationCode: string; name: string } | undefined };

export type ProviderBundle = { variationCode: string; name: string; priceKobo: number };

export interface PayoutRail {
  readonly name: string;
  readonly fundingAccount: string;
  // Rails that pay from a different account per network or per kind.
  fundingAccountFor?(network: NetworkCode, bundle?: { id: number } | undefined): string;
  send(input: SendInput): Promise<SendResult>;
  listDataBundles(network: NetworkCode): Promise<ProviderBundle[]>;
  check(requestId: string): Promise<SendResult>;
  health(): Promise<RailHealth>;
}

export function railFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutRail | undefined {
  const vt = vtpassConfigFromEnv(env);
  return vt ? new VtpassRail(vt) : undefined;
}
