import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { naira } from "../src/money.ts";
import { mask, networkForNumber, QUOTE_LIMIT, resetQuoteLimits } from "../src/public/pages.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, expireQuotes, getTransferByReference, recordInbound, startPayout } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, fundPool, pool } from "./helpers/db.ts";
import { Browser, problems, startServer } from "./helpers/web.ts";

let base = "";
let server: Server;
before(async () => ({ base, server } = await startServer()));
after(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await clean();
  resetQuoteLimits();
  await addReceivingNumber("08039990001", "MTN");
  await as("founder", (c) => setSetting(c, "founder", "network.transfer_code", { MTN: "*321*{pin}*{amount}*{number}#", AIRTEL: "*432*{amount}*{number}#", GLO: "", "9MOBILE": "" }));
});

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function quote(b: Browser, fields: Record<string, string> = {}) {
  return b.post("/quote", { sender: "0803 123 4567", from: "MTN", recipient: "08021234567", to: "AIRTEL", amount: "500", ...fields }, false);
}

test("the front page says what it costs, from the live settings, and asks for nothing but numbers and an amount", async () => {
  await as("founder", (c) => setSetting(c, "founder", "fee.percent_basis_points", 250));
  const b = new Browser(base);
  const r = await b.get("/");
  assert.equal(r.status, 200);
  assert.match(r.text, /Fee: 2.50 percent, at least N20 and at most N200/);
  assert.match(r.text, /From N100 to N10,000 per transfer/);
  const fields = [...r.text.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fields, ["sender", "recipient", "amount", "website", "reference"]);
  assert.doesNotMatch(r.text, /type="password"/);
});

test("a quote sends the sender to a page that says exactly what to dial, to which number, and what the other side gets", async () => {
  const b = new Browser(base);
  const r = await quote(b);
  assert.equal(r.status, 303);
  assert.match(r.location!, /^\/t\/TX-[2-9A-HJKMNP-Z]{8}$/);
  const page = await b.get(r.location!);
  const text = strip(page.text);
  assert.match(text, /send N500 of MTN airtime to 08039990001/);
  assert.match(text, /\*321\*PIN\*500\*08039990001#/);
  assert.match(text, /Put your MTN transfer PIN where it says PIN/);
  assert.match(text, /recipient gets N480 of airtime on Airtel/);
  assert.match(page.text, /http-equiv="refresh" content="20"/);
  assert.match(text, /Reference TX-/);
});

test("a network whose code has no PIN gets a one-tap link that opens the dial pad with the code", async () => {
  await addReceivingNumber("08029990001", "AIRTEL");
  const b = new Browser(base);
  const r = await quote(b, { sender: "08021234567", from: "AIRTEL", recipient: "08031234567", to: "MTN" });
  const page = await b.get(r.location!);
  assert.match(page.text, /href="tel:\*432\*500\*08029990001%23"/);
});

test("the sender's own numbers are never shown in full on a page whose link might be shared", async () => {
  assert.equal(mask("08031234567"), "0803 *** 4567");
  const b = new Browser(base);
  const r = await quote(b);
  const page = await b.get(r.location!);
  assert.doesNotMatch(page.text, /08031234567/);
  assert.doesNotMatch(page.text, /08021234567/);
  assert.match(page.text, /0803 \*\*\* 4567/);
});

test("a mistake is shown on the form with what was typed kept, and nothing is created", async () => {
  const b = new Browser(base);
  const same = await quote(b, { to: "MTN", recipient: "08061234567" });
  assert.equal(same.status, 400);
  assert.match(problems(same.text).join(" "), /Both numbers are on MTN/);
  assert.match(same.text, /value="0803 123 4567"/);
  const small = await quote(b, { amount: "50" });
  assert.match(problems(small.text).join(" "), /smallest transfer is N100/);
  const words = await quote(b, { amount: "five hundred" });
  assert.match(problems(words.text).join(" "), /Enter the amount in naira/);
  const n = await pool.query("SELECT count(*)::int AS n FROM transfers");
  assert.equal(n.rows[0].n, 0);
});

test("the status page follows the transfer from waiting, to received, to sending, to done", async () => {
  await fundPool("AIRTEL", naira(5_000));
  const b = new Browser(base);
  const r = await quote(b);
  const ref = r.location!.slice(3);
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(500), rawText: "received", source: "bridge" }));
  let text = strip((await b.get(`/t/${ref}`)).text);
  assert.match(text, /We have your N500 on MTN/);
  assert.match(text, /Sending N480 to 0802 \*\*\* 4567 on Airtel/);
  const t = (await getTransferByReference(pool, ref))!;
  await as("worker", (c) => startPayout(c, "worker", t.id));
  await as("worker", (c) => completePayout(c, "worker", t.id, "A-1"));
  const done = await b.get(`/t/${ref}`);
  text = strip(done.text);
  assert.match(text, /Done. N480 of Airtel airtime was sent/);
  assert.doesNotMatch(done.text, /http-equiv="refresh"/);
});

test("a different amount arriving is explained honestly on the status page", async () => {
  const b = new Browser(base);
  const r = await quote(b);
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(1_000), rawText: "received", source: "bridge" }));
  const text = strip((await b.get(r.location!)).text);
  assert.match(text, /We have your N1,000 on MTN/);
  assert.match(text, /Sending N960/);
});

test("an expired quote tells the sender the time has passed and that airtime already sent will still be matched", async () => {
  const b = new Browser(base);
  const r = await quote(b);
  await pool.query("UPDATE transfers SET expires_at = now() - interval '1 minute'");
  await expireQuotes(pool);
  const text = strip((await b.get(r.location!)).text);
  assert.match(text, /The time to send has passed/);
  assert.match(text, /it will still be matched/);
});

test("a held transfer tells the sender a person is looking and nothing is lost", async () => {
  const b = new Browser(base);
  const r = await quote(b);
  await as("bridge", (c) => recordInbound(c, "bridge", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: naira(50), rawText: "received", source: "bridge" }));
  const text = strip((await b.get(r.location!)).text);
  assert.match(text, /a person is looking at this transfer/);
  assert.match(text, /outside the limits we can move, so it will be sent back/);
});

test("a transfer can be looked up by its reference, and a wrong reference is explained", async () => {
  const b = new Browser(base);
  const r = await quote(b);
  const ref = r.location!.slice(3);
  const found = await b.post("/status", { reference: ` ${ref.toLowerCase()} ` }, false);
  assert.equal(found.status, 303);
  assert.equal(found.location, `/t/${ref}`);
  const missing = await b.post("/status", { reference: "TX-NOPE1234" }, false);
  assert.equal(missing.status, 404);
  assert.match(problems(missing.text).join(" "), /no transfer with that reference/);
  assert.equal((await b.get("/t/TX-NOPE1234")).status, 404);
});

test("a sender who asks for quote after quote without paying is slowed down", async () => {
  const b = new Browser(base);
  for (let i = 0; i < QUOTE_LIMIT.count; i++) assert.equal((await quote(b)).status, 303);
  const blocked = await quote(b);
  assert.equal(blocked.status, 429);
  assert.match(problems(blocked.text).join(" "), /wait ten minutes/);
});

test("a form filled by a bot is refused", async () => {
  const b = new Browser(base);
  const r = await quote(b, { website: "http://spam" });
  assert.equal(r.status, 400);
});

test("the network is suggested from the number's prefix, and an unknown prefix suggests nothing", async () => {
  assert.equal(await networkForNumber(pool, "0803 123 4567"), "MTN");
  assert.equal(await networkForNumber(pool, "+2348021234567"), "AIRTEL");
  assert.equal(await networkForNumber(pool, "07991234567"), undefined);
  const r = await fetch(`${base}/api/network-for?number=08051234567`);
  assert.deepEqual(await r.json(), { network: "GLO" });
});

test("the sender's pages are small enough for a weak connection", async () => {
  const b = new Browser(base);
  const home = await b.get("/");
  const r = await quote(b);
  const status = await b.get(r.location!);
  const css = await (await fetch(`${base}/static/public.css`)).text();
  const js = await (await fetch(`${base}/static/public.js`)).text();
  for (const [name, text, limit] of [["home", home.text, 8_000], ["status", status.text, 6_000], ["css", css, 4_000], ["js", js, 2_000]] as const) {
    assert.ok(Buffer.byteLength(text) < limit, `${name} is ${Buffer.byteLength(text)} bytes, over ${limit}`);
  }
});
