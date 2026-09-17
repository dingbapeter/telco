import type { Queryable } from "./db.ts";
import { UserFacingError } from "./errors.ts";
import { applyBasisPoints, assertKobo, formatNaira } from "./money.ts";
import { getSettingValue, type NetworkCode } from "./settings.ts";

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
  const [percent, flat, floor, ceiling, shares, overrides] = await Promise.all([
    getSettingValue(db, "fee.percent_basis_points"),
    getSettingValue(db, "fee.flat_kobo"),
    getSettingValue(db, "fee.floor_kobo"),
    getSettingValue(db, "fee.ceiling_kobo"),
    getSettingValue(db, "fee.network_share_basis_points"),
    getSettingValue(db, "fee.pair_overrides"),
  ]);
  const o = overrides[`${from}>${to}`] ?? {};
  return {
    percentBasisPoints: o.percent_basis_points ?? percent,
    flatKobo: o.flat_kobo ?? flat,
    floorKobo: o.floor_kobo ?? floor,
    ceilingKobo: o.ceiling_kobo ?? ceiling,
    networkShareBasisPoints: shares[from],
  };
}
