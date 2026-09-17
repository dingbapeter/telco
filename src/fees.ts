import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { applyBasisPoints, assertKobo, formatNaira } from "./money.ts";
import { getSettingValues, type NetworkCode } from "./settings.ts";

export type FeeRule = {
  percentBasisPoints: number;
  flatKobo: number;
  floorKobo: number;
  ceilingKobo: number;
  networkShareBasisPoints: number;
};

export type FeeBreakdown = {
  amountKobo: number;
  feeKobo: number;
  platformShareKobo: number;
  networkShareKobo: number;
  payoutKobo: number;
};

// The fee comes out of the airtime: the recipient gets amount minus fee.
// The network's share rounds down so we never accrue a kobo we do not owe.
export function computeFee(amountKobo: number, rule: FeeRule): FeeBreakdown {
  assertKobo(amountKobo);
  if (amountKobo <= 0) throw new UserFacingError("amount_not_positive", "The amount must be more than zero.");
  let fee = rule.flatKobo + applyBasisPoints(amountKobo, rule.percentBasisPoints);
  if (fee < rule.floorKobo) fee = rule.floorKobo;
  if (fee > rule.ceilingKobo) fee = rule.ceilingKobo;
  if (fee >= amountKobo) {
    throw new UserFacingError(
      "fee_exceeds_amount",
      `The fee on ${formatNaira(amountKobo)} would be ${formatNaira(fee)}, which leaves nothing to send. Send a larger amount.`,
    );
  }
  const networkShare = Math.floor((fee * rule.networkShareBasisPoints) / 10_000);
  return {
    amountKobo,
    feeKobo: fee,
    networkShareKobo: networkShare,
    platformShareKobo: fee - networkShare,
    payoutKobo: amountKobo - fee,
  };
}

// The rule for one direction: the defaults, with any per pair override laid
// on top, and the origin network's share of the fee.
export async function loadFeeRule(db: Queryable, from: NetworkCode, to: NetworkCode): Promise<FeeRule> {
  const [percent, flat, floor, ceiling, shares, overrides] = await getSettingValues(db, [
    "fee.percent_basis_points",
    "fee.flat_kobo",
    "fee.floor_kobo",
    "fee.ceiling_kobo",
    "fee.network_share_basis_points",
    "fee.pair_overrides",
  ] as const);
  const o = overrides[`${from}>${to}`] ?? {};
  return {
    percentBasisPoints: o.percent_basis_points ?? percent,
    flatKobo: o.flat_kobo ?? flat,
    floorKobo: o.floor_kobo ?? floor,
    ceilingKobo: o.ceiling_kobo ?? ceiling,
    networkShareBasisPoints: shares[from],
  };
}

// The smallest whole-naira amount a sender must send so that, after the
// fee, the payout covers a price. Fees only grow with the amount, so a
// short walk upward from the arithmetic guess finds it.
export function requiredAmountFor(priceKobo: number, rule: FeeRule): number {
  assertKobo(priceKobo);
  const fraction = 1 - rule.percentBasisPoints / 10_000;
  let amount = Math.ceil((priceKobo + rule.flatKobo) / fraction / 100) * 100;
  amount = Math.max(amount, Math.ceil((priceKobo + rule.floorKobo) / 100) * 100);
  for (let i = 0; i < 1_000; i++) {
    try {
      if (computeFee(amount, rule).payoutKobo >= priceKobo) break;
    } catch {
      // The fee swallowed the amount; keep going up.
    }
    amount += 100;
  }
  // Come back down while the payout still covers the price, so the sender
  // never pays a naira more than needed.
  while (amount > 100) {
    try {
      if (computeFee(amount - 100, rule).payoutKobo < priceKobo) break;
    } catch {
      break;
    }
    amount -= 100;
  }
  return amount;
}
