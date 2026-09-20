import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { clientAddress } from "../src/web/http.ts";
import { clean } from "./helpers/db.ts";
import { Browser, seedAdmin, startServer } from "./helpers/web.ts";

describe("the address a request came from", () => {
  const withSocket = (remote: string, headers: Record<string, string | string[]> = {}) =>
    ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

  test("is the socket address when nothing sits in front", () => {
    assert.equal(clientAddress(withSocket("41.58.1.9")), "41.58.1.9");
  });

  test("is the last address the web server in front wrote", () => {
    assert.equal(clientAddress(withSocket("127.0.0.1", { "x-forwarded-for": "41.58.1.9" })), "41.58.1.9");
  });

  test("ignores an address a visitor put in the header themselves", () => {
    // Caddy appends the real address at the end of whatever arrived, so the
    // last one is the only one to trust.
    assert.equal(clientAddress(withSocket("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 41.58.1.9" })), "41.58.1.9");
  });

  test("falls back to the socket when the header is empty", () => {
    assert.equal(clientAddress(withSocket("127.0.0.1", { "x-forwarded-for": "" })), "127.0.0.1");
  });
});

describe("a form sent from somewhere else", () => {
  let base = "";
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  before(async () => {
    ({ base, server } = await startServer({ knowsItsAddress: true }));
  });
  after(() => server.close());
  beforeEach(async () => {
    await clean();
    await seedAdmin();
  });

  test("is refused on the login form, so nobody can be signed into another person's account", async () => {
    const b = new Browser(base);
    const r = await b.post("/admin/login", { email: "founder@example.com", password: "correct horse battery" }, false, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
    assert.match(r.text, /sent from another website/);
  });

  test("is accepted when it came from this site", async () => {
    const b = new Browser(base);
    const r = await b.post("/admin/login", { email: "founder@example.com", password: "correct horse battery" }, false, { origin: base });
    assert.equal(r.status, 303);
  });

  test("is accepted when the browser sends no origin at all, as an old phone browser does", async () => {
    const b = new Browser(base);
    const r = await b.post("/admin/login", { email: "founder@example.com", password: "correct horse battery" }, false);
    assert.equal(r.status, 303);
  });
});

describe("addresses and cookies that are not properly written", () => {
  let base = "";
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  before(async () => {
    ({ base, server } = await startServer());
    await clean();
    await seedAdmin();
  });
  after(() => server.close());

  test("a half written escape in the address gives a page, not a server error", async () => {
    const res = await fetch(`${base}/t/%`, { redirect: "manual" });
    assert.equal(res.status, 404);
  });

  test("a half written escape in a cookie gives a page, not a server error", async () => {
    const res = await fetch(base + "/", { headers: { cookie: "telco_admin=%" }, redirect: "manual" });
    assert.equal(res.status, 200);
  });
});

describe("files served from the public folder", () => {
  let base = "";
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  before(async () => {
    ({ base, server } = await startServer());
  });
  after(() => server.close());

  test("carry the same security headers as every page", async () => {
    const res = await fetch(base + "/static/app.css");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  test("cannot reach outside the folder", async () => {
    const res = await fetch(base + "/static/../src/main.ts");
    assert.equal(res.status, 404);
  });
});
