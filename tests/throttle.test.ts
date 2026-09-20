import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { DUMMY_HASH, verifyPassword } from "../src/auth.ts";
import { clearLoginFailures, loginWait, recordLoginFailure, resetLoginThrottle, throttleSize } from "../src/throttle.ts";

describe("slowing down wrong passwords", () => {
  beforeEach(() => resetLoginThrottle());

  test("one wrong password makes that account wait", () => {
    const now = 1_000_000;
    recordLoginFailure("founder@example.com", "41.58.1.9", now);
    assert.ok(loginWait("founder@example.com", "", now) > 0);
  });

  test("a right password clears the account", () => {
    const now = 1_000_000;
    recordLoginFailure("founder@example.com", "41.58.1.9", now);
    clearLoginFailures("founder@example.com");
    assert.equal(loginWait("founder@example.com", "", now), 0);
  });

  test("one address working through many accounts is slowed even on an account it has not tried", () => {
    const now = 1_000_000;
    for (let i = 0; i < 25; i++) recordLoginFailure(`person${i}@example.com`, "41.58.1.9", now);
    assert.equal(loginWait("untouched@example.com", "", now), 0);
    assert.ok(loginWait("untouched@example.com", "41.58.1.9", now) > 0);
  });

  test("a handful of failures from one address does not slow a street sharing it", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) recordLoginFailure(`person${i}@example.com`, "41.58.1.9", now);
    assert.equal(loginWait("untouched@example.com", "41.58.1.9", now), 0);
  });

  test("the wait never goes past a minute", () => {
    const now = 1_000_000;
    for (let i = 0; i < 50; i++) recordLoginFailure("founder@example.com", "41.58.1.9", now);
    assert.ok(loginWait("founder@example.com", "41.58.1.9", now) <= 60_000);
  });

  test("what it remembers is forgotten, so it cannot grow for ever", () => {
    const now = 1_000_000;
    recordLoginFailure("founder@example.com", "41.58.1.9", now);
    assert.ok(throttleSize() > 0);
    loginWait("someone@example.com", "", now + 60 * 60_000);
    assert.equal(throttleSize(), 0);
  });
});

describe("the stand in password used when nobody has that account", () => {
  test("is a real stored password, so checking it costs what a real one costs", async () => {
    const [scheme, n, r, p, salt, key] = DUMMY_HASH.split("$");
    assert.equal(scheme, "scrypt");
    assert.equal(n, "16384");
    assert.ok(r && p && salt && key);
    assert.equal(await verifyPassword("anything at all", DUMMY_HASH), false);
  });
});
