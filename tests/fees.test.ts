import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFee, type FeeRule } from "../src/fees.ts";
import { naira } from "../src/money.ts";

const rule: FeeRule = { percentBasisPoints: 400, flatKobo: 0, floorKobo: naira(20), ceilingKobo: naira(200), networkShareBasisPoints: 0 };

test("sending five hundred naira at four percent costs twenty naira and the recipient gets four hundred and eighty", () => {
  const fee = computeFee(naira(500), rule);
  assert.equal(fee.feeKobo, naira(20));
  assert.equal(fee.payoutKobo, naira(480));
});

test("the fee never drops below the floor", () => {
  assert.equal(computeFee(naira(100), rule).feeKobo, naira(20));
});

test("the fee never rises above the ceiling", () => {
  assert.equal(computeFee(naira(10_000), rule).feeKobo, naira(200));
});

test("a flat fee is added before the floor and ceiling apply", () => {
  const withFlat = { ...rule, flatKobo: naira(5), floorKobo: 0 };
  assert.equal(computeFee(naira(500), withFlat).feeKobo, naira(25));
});

test("with no network agreement the whole fee is ours", () => {
  const fee = computeFee(naira(500), rule);
  assert.equal(fee.networkShareKobo, 0);
  assert.equal(fee.platformShareKobo, naira(20));
});

test("a network on a quarter share gets a quarter of the fee, rounded down", () => {
  const fee = computeFee(naira(500), { ...rule, networkShareBasisPoints: 2_500 });
  assert.equal(fee.networkShareKobo, naira(5));
  assert.equal(fee.platformShareKobo, naira(15));
  // 2001 kobo fee at 25 percent is 500.25 kobo; the network gets 500.
  const odd = computeFee(50_025, { ...rule, networkShareBasisPoints: 2_500, floorKobo: 2_001 });
  assert.equal(odd.feeKobo, 2_001);
  assert.equal(odd.networkShareKobo, 500);
  assert.equal(odd.platformShareKobo, 1_501);
});

test("the shares always add up to the fee and the fee plus payout to the amount", () => {
  for (const amount of [naira(100), naira(333), naira(999), naira(5_000), 12_345]) {
    for (const share of [0, 1, 999, 2_500, 5_000, 10_000]) {
      const fee = computeFee(amount, { ...rule, networkShareBasisPoints: share });
      assert.equal(fee.platformShareKobo + fee.networkShareKobo, fee.feeKobo);
      assert.equal(fee.feeKobo + fee.payoutKobo, amount);
    }
  }
});

test("a fee that would swallow the whole amount is refused with advice", () => {
  assert.throws(() => computeFee(naira(20), rule), /leaves nothing to send/);
  assert.throws(() => computeFee(naira(15), rule), /Send a larger amount/);
});

test("a zero or negative amount is refused", () => {
  assert.throws(() => computeFee(0, rule));
  assert.throws(() => computeFee(-100, rule));
});
