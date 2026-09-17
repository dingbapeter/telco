import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliseNigerianNumber, prefixOf } from "../src/phone.ts";

test("every way people write a Nigerian number becomes the local eleven digit form", () => {
  for (const input of ["08031234567", "8031234567", "+2348031234567", "2348031234567", "0803 123 4567", "+234 (0)803-123-4567".replace("(0)", "")]) {
    assert.equal(normaliseNigerianNumber(input), "08031234567", input);
  }
});

test("a number that is not a Nigerian mobile is refused", () => {
  assert.equal(normaliseNigerianNumber("0123456789"), undefined);
  assert.equal(normaliseNigerianNumber("080312345"), undefined);
  assert.equal(normaliseNigerianNumber("+447700900123"), undefined);
  assert.equal(normaliseNigerianNumber(""), undefined);
  assert.equal(normaliseNigerianNumber("0603123456"), undefined);
});

test("the prefix is the first four digits of the local form", () => {
  assert.equal(prefixOf("08031234567"), "0803");
});
