import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBasisPoints, formatNaira, naira, parseNaira } from "../src/money.ts";

test("five hundred naira is fifty thousand kobo", () => {
  assert.equal(naira(500), 50_000);
});

test("a fractional naira amount is refused rather than rounded", () => {
  assert.throws(() => naira(2.5));
});

test("whole naira amounts show without kobo and with thousands separators", () => {
  assert.equal(formatNaira(50_000), "N500");
  assert.equal(formatNaira(123_456_700), "N1,234,567");
});

test("kobo show as two decimal places", () => {
  assert.equal(formatNaira(25_050), "N250.50");
  assert.equal(formatNaira(5), "N0.05");
});

test("negative amounts keep their sign", () => {
  assert.equal(formatNaira(-2_000), "-N20");
});

test("what a person types is read as kobo", () => {
  assert.equal(parseNaira("500"), 50_000);
  assert.equal(parseNaira("1,500"), 150_000);
  assert.equal(parseNaira("N1500"), 150_000);
  assert.equal(parseNaira(" 250.5 "), 25_050);
  assert.equal(parseNaira("250.55"), 25_055);
});

test("nonsense typed as an amount is rejected, not guessed", () => {
  assert.equal(parseNaira("five hundred"), undefined);
  assert.equal(parseNaira("-500"), undefined);
  assert.equal(parseNaira("1.234"), undefined);
  assert.equal(parseNaira(""), undefined);
});

test("four percent of five hundred naira is twenty naira", () => {
  assert.equal(applyBasisPoints(50_000, 400), 2_000);
});

test("a half kobo rounds up", () => {
  // 1 kobo at 50 basis points is 0.005 kobo, which rounds to zero.
  assert.equal(applyBasisPoints(1, 50), 0);
  // 100 kobo at 5 basis points is 0.05 kobo, which rounds to zero.
  assert.equal(applyBasisPoints(100, 5), 0);
  // 1000 kobo at 5 basis points is exactly 0.5 kobo, which rounds to one.
  assert.equal(applyBasisPoints(1000, 5), 1);
});

test("floating point never reaches the calculation", () => {
  assert.throws(() => applyBasisPoints(0.1 + 0.2, 400));
  assert.throws(() => applyBasisPoints(1000, 4.5));
});
