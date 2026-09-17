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

export interface PayoutRail {
  readonly name: string;
  readonly fundingAccount: string;
  send(input: { requestId: string; network: NetworkCode; number: string; amountKobo: number }): Promise<SendResult>;
  check(requestId: string): Promise<SendResult>;
  health(): Promise<RailHealth>;
}

export function railFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutRail | undefined {
  const vt = vtpassConfigFromEnv(env);
  return vt ? new VtpassRail(vt) : undefined;
}
