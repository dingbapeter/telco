import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { createDevice } from "../src/bridge.ts";
import { upsertBundle, type Bundle } from "../src/bundles.ts";
import { runChecklist } from "../src/checklist.ts";
import { openLots, writeOffExpired } from "../src/datalots.ts";
import { balance, balances } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { refundOrder } from "../src/orders.ts";
import { resetQuoteLimits } from "../src/public/pages.ts";
import {
  blockSeller,
  cashPayoutCheck,
  expireSellbacks,
  getCreditNote,
  getSellbackByReference,
  paySellbackCash,
  quoteSellback,
  rateFor,
  releaseSellback,
  returnByHand,
  completeSellbackReturn,
  startSellbackReturn,
  spendCredit,
  voidCredit,
  type Sellback,
} from "../src/sellbacks.ts";
import { setSetting } from "../src/settings.ts";
import { quoteTransfer, recordInbound } from "../src/transfers.ts";
import { addReceivingNumber, as, clean, pool } from "./helpers/db.ts";
import { Browser, oks, problems, seedAdmin } from "./helpers/web.ts";

let base = "";
let server: Server;
before(async () => {
  const app = buildApp(pool, { secureCookies: false, publicBaseUrl: "https://telco.example" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server.close();
  await pool.end();
});

const SELLER = "08031234567";
let mtn1gb: Bundle;
beforeEach(async () => {
  await clean();
  await pool.query("TRUNCATE sellback_events, credit_notes, sellback_blocks, sellbacks, orders, order_events, payment_events, data_lots, data_bundles, bridge_messages, bridge_devices, admin_sessions, admins RESTART IDENTITY CASCADE");
  resetQuoteLimits();
  await seedAdmin();
  await addReceivingNumber("08039990001", "MTN");
  mtn1gb = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 1 year", sizeMb: 1024, validityDays: 365, priceKobo: naira(600), giftable: true }));
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.airtime_enabled", true);
    await setSetting(c, "founder", "sellback.data_enabled", true);
    await setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(100_000), AIRTEL: naira(100_000), GLO: naira(100_000), "9MOBILE": naira(100_000) });
    await setSetting(c, "founder", "retail.enabled", true);
    await setSetting(c, "founder", "network.transfer_code", { MTN: "*600*{pin}*{amount}*{number}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
    await setSetting(c, "founder", "network.data_gift_code", { MTN: "*131*{number}*{size}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  });
});

const sell = (input: Partial<Parameters<typeof quoteSellback>[2]> = {}) =>
  as("seller", (c) =>
    quoteSellback(c, "seller", { network: "MTN", sellerNumber: SELLER, kind: "airtime", amountKobo: naira(1_000), outcome: "credit", ...input }),
  );

// The network's own message about what landed, which is the only thing we
// ever believe.
const landed = (amountKobo: number, options: { seller?: string; dataMb?: number; text?: string } = {}) =>
  as("bridge", (c) =>
    recordInbound(c, "bridge", {
      networkCode: "MTN",
      receivingNumber: "08039990001",
      senderNumber: options.seller ?? SELLER,
      amountKobo,
      rawText: options.text ?? `You have received N${amountKobo / 100} from ${options.seller ?? SELLER}`,
      source: "manual",
      ...(options.dataMb ? { dataMb: options.dataMb } : {}),
    }),
  );

async function enableCash(capKobo = naira(50_000), holdHours = 0): Promise<void> {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.cash_enabled", true);
    await setSetting(c, "founder", "sellback.cash_daily_cap_kobo", capKobo);
    await setSetting(c, "founder", "sellback.cash_hold_hours", holdHours);
  });
}

const booksBalance = async (): Promise<boolean> => (await balances(pool)).reduce((n, a) => n + (a.kind === "asset" || a.kind === "expense" ? a.balanceKobo : -a.balanceKobo), 0) === 0;

// --- selling airtime for credit -------------------------------------------

test("a seller is told our number, the code to dial and what we pay, and gets credit the moment the network says it landed", async () => {
  const { sellback, payKobo } = await sell();
  assert.match(sellback.reference, /^SB-[2-9A-HJKMNP-Z]{8}$/);
  assert.equal(sellback.receiving_number, "08039990001", "our own MTN number, not the seller's");
  assert.equal(sellback.rate_basis_points, 8_000, "the default rate in Settings");
  assert.equal(payKobo, naira(800));
  const page = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(page.text, /is our own|is ours/);
  assert.match(page.text, /\*600\*PIN\*1000\*08039990001#/, "the code carries our number and the amount, with the PIN left as a word");
  assert.match(page.text, /We pay <strong>N800<\/strong>/);

  const outcome = await landed(naira(1_000));
  assert.equal(outcome.outcome, "bought");
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.state, "settled");
  assert.equal(after.received_kobo, naira(1_000));
  assert.equal(after.pay_kobo, naira(800));
  assert.match(after.credit_code!, /^CR-[2-9A-HJKMNP-Z]{10}$/);
  // The airtime is ours at what we sell it for, what we owe is ours to pay,
  // and the difference is the margin.
  assert.equal(await balance(pool, "pool:MTN"), naira(1_000));
  assert.equal(await balance(pool, "owed:sellers"), naira(800));
  assert.equal(await balance(pool, "revenue:sellback_margin"), naira(200));
  assert.ok(await booksBalance());
  const status = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(status.text, new RegExp(after.credit_code!));
});

test("the credit code buys airtime for any number and what is left stays on the code", async () => {
  const { sellback } = await sell();
  await landed(naira(1_000));
  const code = (await getSellbackByReference(pool, sellback.reference))!.credit_code!;
  const b = new Browser(base);
  const first = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  const paid = await b.post(`${first.location}/credit`, { code }, false);
  assert.equal(paid.status, 303);
  const order = (await pool.query("SELECT * FROM orders ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(order.state, "paid");
  assert.equal(order.payment_method, "credit");
  assert.equal(order.credit_code, code);
  assert.equal(order.paid_kobo, naira(500));
  assert.equal((await getCreditNote(pool, code))!.remaining_kobo, naira(300));
  // What the buyer is owed came out of what the seller was owed, not out of cash.
  assert.equal(await balance(pool, "owed:sellers"), naira(300));
  assert.equal(await balance(pool, "owed:buyers"), naira(500));
  assert.ok(await booksBalance());
  // The rest of the code still works, and then it is spent.
  const second = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "300", bundle: "", email: "" }, false);
  await b.post(`${second.location}/credit`, { code }, false);
  const note = (await getCreditNote(pool, code))!;
  assert.equal(note.remaining_kobo, 0);
  assert.equal(note.state, "used");
  const third = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "100", bundle: "", email: "" }, false);
  const refused = await b.post(`${third.location}/credit`, { code }, false);
  assert.match(problems(refused.text).join(" "), /has nothing left on it/);
});

test("a credit code cannot pay for more than it holds, and a made up code buys nothing", async () => {
  const { sellback } = await sell();
  await landed(naira(1_000));
  const code = (await getSellbackByReference(pool, sellback.reference))!.credit_code!;
  const b = new Browser(base);
  const big = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "900", bundle: "", email: "" }, false);
  const refused = await b.post(`${big.location}/credit`, { code }, false);
  assert.equal(refused.status, 400);
  assert.match(problems(refused.text).join(" "), /holds N800 and this costs N900/);
  assert.equal((await getCreditNote(pool, code))!.remaining_kobo, naira(800), "nothing was taken off the code");
  assert.equal((await pool.query("SELECT state FROM orders ORDER BY id DESC LIMIT 1")).rows[0].state, "awaiting_payment");
  const invented = await b.post(`${big.location}/credit`, { code: "CR-NOTAREALCODE" }, false);
  assert.match(problems(invented.text).join(" "), /not one of ours/);
});

test("one credit code cannot pay for two orders out of the same balance", async () => {
  const { sellback } = await sell();
  await landed(naira(1_000));
  const code = (await getSellbackByReference(pool, sellback.reference))!.credit_code!;
  const b = new Browser(base);
  const one = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  const two = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  const results = await Promise.all([b.post(`${one.location}/credit`, { code }, false), b.post(`${two.location}/credit`, { code }, false)]);
  const paid = results.filter((r) => r.status === 303);
  assert.equal(paid.length, 1, "exactly one of the two went through");
  assert.equal((await getCreditNote(pool, code))!.remaining_kobo, naira(300));
  assert.equal(await balance(pool, "owed:buyers"), naira(500));
  assert.ok(await booksBalance());
});

// --- the circle guard -----------------------------------------------------

test("we never buy back at more than the cheapest price anybody can buy from us", async () => {
  // A deep retail discount on MTN makes 80 percent unsafe: the same naira
  // could be bought from us at 75 and sold back at 80, round and round.
  await as("founder", (c) => setSetting(c, "founder", "retail.discount_basis_points", { MTN: 2_000, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  const check = await rateFor(pool, "MTN", "airtime");
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.match(check.reason, /unsafe/);
    assert.match(check.reason, /the MTN retail discount lets it be bought from us for 80 percent/);
    assert.match(check.reason, /drop the rate below 77 percent/);
  }
  await assert.rejects(sell(), /unsafe/);
  // The public page says we are not buying MTN rather than quoting a rate.
  const page = await new Browser(base).get("/sell");
  assert.match(page.text, /not buying/);
  // And the launch checklist says what to change.
  const bad = (await runChecklist(pool)).filter((c) => c.status === "bad" && c.title.includes("MTN airtime"));
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.fix!, /lower the rate, or lower the discount/);
  // Dropping the rate under the guard opens it again.
  await as("founder", (c) => setSetting(c, "founder", "sellback.airtime_rate_basis_points", { MTN: 7_000, AIRTEL: 8_000, GLO: 8_000, "9MOBILE": 8_000 }));
  const open = await rateFor(pool, "MTN", "airtime");
  assert.equal(open.ok, true);
  const { payKobo } = await sell();
  assert.equal(payKobo, naira(700));
});

test("an agent's own rate counts as a price we sell at, and closes the circle too", async () => {
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO agents (code, name, phone, password_hash, discount_basis_points) VALUES ('AAAAA', 'Big shop', '08059998877', 'x', 2000)");
  const check = await rateFor(pool, "MTN", "airtime");
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /the rate agreed with one agent/);
  await pool.query("TRUNCATE agents RESTART IDENTITY CASCADE");
  assert.equal((await rateFor(pool, "MTN", "airtime")).ok, true);
});

test("the rate quoted is the rate paid, even when the setting moves before the airtime lands", async () => {
  const { sellback } = await sell();
  await as("founder", (c) => setSetting(c, "founder", "sellback.airtime_rate_basis_points", { MTN: 5_000, AIRTEL: 8_000, GLO: 8_000, "9MOBILE": 8_000 }));
  await landed(naira(1_000));
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.pay_kobo, naira(800), "the promise made at the quote is kept");
  assert.equal(after.state, "settled");
});

test("what arrives is what we pay for, at the rate quoted", async () => {
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  await landed(naira(600));
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.received_kobo, naira(600));
  assert.equal(after.pay_kobo, naira(480));
  assert.equal(await balance(pool, "pool:MTN"), naira(600));
  assert.equal((await getCreditNote(pool, after.credit_code!))!.amount_kobo, naira(480));
});

// --- holds, returns and blocks -------------------------------------------

test("value outside the limits is held, and sending it back leaves the books where they started", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.min_kobo", naira(500)));
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  const outcome = await landed(naira(200));
  assert.equal(outcome.outcome, "bought_held");
  const held = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(held.state, "held");
  assert.equal(held.hold_reason, "amount_below_minimum");
  assert.equal(await balance(pool, "pool:MTN"), naira(200), "the airtime is really ours, so it is in the books");
  assert.equal(await balance(pool, "owed:sellers"), naira(160));
  const page = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(page.text, /less than the smallest amount we buy, so it will be sent back/);
  // Automatic payouts are off, which is how the platform starts, so sending
  // it back is a person's from the first moment.
  const going = await as("founder", (c) => startSellbackReturn(c, "founder", held.id));
  assert.equal(going.state, "returning");
  assert.equal(going.return_rail, "manual");
  // Nothing moves in the books until the value has actually gone.
  assert.equal(await balance(pool, "pool:MTN"), naira(200));
  const back = await as("founder", (c) => completeSellbackReturn(c, "founder", held.id, "sent N200 back by hand from the MTN SIM", { byHand: true }));
  assert.equal(back!.state, "returned");
  assert.equal(await balance(pool, "pool:MTN"), 0);
  assert.equal(await balance(pool, "owed:sellers"), 0);
  assert.equal(await balance(pool, "revenue:sellback_margin"), 0);
  assert.ok(await booksBalance());
  // And it cannot be sent back twice.
  assert.equal(await as("founder", (c) => completeSellbackReturn(c, "founder", held.id, "again", { byHand: true })), undefined);
  await assert.rejects(as("founder", (c) => startSellbackReturn(c, "founder", held.id)), /cannot be sent back/);
});

test("a held sale can be bought anyway, and the seller gets their credit", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.min_kobo", naira(500)));
  const { sellback } = await sell();
  await landed(naira(200));
  const held = (await getSellbackByReference(pool, sellback.reference))!;
  const bought = await as("founder", (c) => releaseSellback(c, "founder", held.id));
  assert.equal(bought.state, "settled");
  assert.equal((await getCreditNote(pool, bought.credit_code!))!.remaining_kobo, naira(160));
});

test("a blocked number cannot sell, and value already on its way from it is held rather than bought", async () => {
  const { sellback } = await sell();
  await as("founder", (c) => blockSeller(c, "founder", SELLER, "sold us airtime bought with a stolen card"));
  await assert.rejects(sell({ sellerNumber: SELLER }), /cannot buy from this number/);
  const outcome = await landed(naira(1_000));
  assert.equal(outcome.outcome, "bought_held");
  const held = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(held.hold_reason, "seller_blocked");
  assert.equal(held.credit_code, null, "no credit is handed to a blocked number");
});

test("stopping a credit code takes back what is left and says who stopped it and why", async () => {
  const { sellback } = await sell();
  await landed(naira(1_000));
  const code = (await getSellbackByReference(pool, sellback.reference))!.credit_code!;
  const b = new Browser(base);
  const order = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  await b.post(`${order.location}/credit`, { code }, false);
  const note = await as("founder", (c) => voidCredit(c, "founder", code, "the airtime was not the seller's"));
  assert.equal(note.state, "voided");
  assert.equal(note.remaining_kobo, 0);
  assert.equal(note.void_reason, "the airtime was not the seller's");
  assert.equal(await balance(pool, "revenue:voided_credit"), naira(300), "only what was unspent");
  assert.equal(await balance(pool, "owed:sellers"), 0);
  assert.ok(await booksBalance());
  await assert.rejects(as("founder", (c) => spendCredit(c, code, naira(100))), /has been stopped/);
  await assert.rejects(as("founder", (c) => voidCredit(c, "founder", code, "again")), /already stopped/);
});

// --- cash ----------------------------------------------------------------

test("cash cannot be asked for while it is switched off", async () => {
  await assert.rejects(sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" }), /only paying in credit at the moment/);
  await as("founder", (c) => setSetting(c, "founder", "sellback.cash_enabled", true));
  await assert.rejects(sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" }), /only paying in credit at the moment/);
  await as("founder", (c) => setSetting(c, "founder", "sellback.cash_daily_cap_kobo", naira(10_000)));
  await assert.rejects(sell({ outcome: "cash" }), /Give the bank, account number and account name/);
  const { sellback } = await sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  assert.equal(sellback.outcome, "cash");
});

test("cash waits for the holding time, then is paid once by a person, inside the day's ceiling", async () => {
  await enableCash(naira(50_000), 24);
  const { sellback } = await sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  await landed(naira(1_000));
  const waiting = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(waiting.state, "received", "cash is never handed over by itself");
  assert.equal(waiting.credit_code, null);
  const early = await cashPayoutCheck(pool, waiting);
  assert.equal(early.ok, false);
  if (!early.ok) assert.match(early.reason, /still in its holding time/);
  await assert.rejects(as("founder", (c) => paySellbackCash(c, "founder", waiting.id, "BNK-1")), /holding time/);
  // A day later it can be paid, and only once.
  const later = new Date(Date.now() + 25 * 3_600_000);
  const paid = await as("founder", (c) => paySellbackCash(c, "founder", waiting.id, "BNK-1", later));
  assert.equal(paid.state, "paid");
  assert.equal(await balance(pool, "cash:bank"), -naira(800), "the money left the bank");
  assert.equal(await balance(pool, "owed:sellers"), 0);
  assert.ok(await booksBalance());
  await assert.rejects(as("founder", (c) => paySellbackCash(c, "founder", waiting.id, "BNK-1", later)), /is paid, so there is nothing to pay/);
  const page = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(page.text, /N800 was sent to GTB 0123456789 Ada/);
});

test("the day's cash ceiling stops the next payout rather than the books", async () => {
  await enableCash(naira(1_000), 0);
  const first = await sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  await landed(naira(1_000));
  await as("founder", (c) => paySellbackCash(c, "founder", first.sellback.id, "BNK-1"));
  const second = await sell({ sellerNumber: "08031234568", outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  await landed(naira(1_000), { seller: "08031234568" });
  const s = (await getSellbackByReference(pool, second.sellback.reference))!;
  const check = await cashPayoutCheck(pool, s);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /the day's ceiling is N1,000/);
  await assert.rejects(as("founder", (c) => paySellbackCash(c, "founder", s.id, "BNK-2")), /day's ceiling/);
  assert.equal((await getSellbackByReference(pool, second.sellback.reference))!.state, "received");
});

// --- limits and caps -----------------------------------------------------

test("a seller's day, the network's day and the size of one sale are all capped, each saying what is left", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.max_kobo", naira(2_000));
    await setSetting(c, "founder", "sellback.min_kobo", naira(200));
    await setSetting(c, "founder", "sellback.seller_daily_max_kobo", naira(2_500));
  });
  await assert.rejects(sell({ amountKobo: naira(3_000) }), /The most we buy at once is N2,000/);
  await assert.rejects(sell({ amountKobo: naira(100) }), /The smallest we buy is N200/);
  await sell({ amountKobo: naira(2_000) });
  await assert.rejects(sell({ amountKobo: naira(1_000) }), /can sell N2,500 a day and has N500 left today/);
  await as("founder", (c) => setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: naira(2_000), AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  await assert.rejects(sell({ sellerNumber: "08031234568", amountKobo: naira(500) }), /as much MTN value as we can take today/);
  await as("founder", (c) => setSetting(c, "founder", "sellback.daily_buy_cap_kobo", { MTN: 0, AIRTEL: 0, GLO: 0, "9MOBILE": 0 }));
  await assert.rejects(sell({ sellerNumber: "08031234569", amountKobo: naira(500) }), /not buying on MTN at the moment/);
});

test("what we buy counts against the receiving number's own daily cap, like everything else that lands on that SIM", async () => {
  await pool.query("UPDATE receiving_numbers SET daily_cap_kobo = $1 WHERE number = '08039990001'", [naira(1_500)]);
  await sell({ amountKobo: naira(1_000) });
  // A transfer now has only N500 of room on that SIM, and asking for more
  // is refused rather than quietly overshooting the network's own limit.
  await assert.rejects(
    as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234568", recipientNumber: "08021234567", amountKobo: naira(1_000) })),
    /No MTN number can take this transfer/,
  );
  await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234568", recipientNumber: "08021234567", amountKobo: naira(500) }));
});

test("a transfer waiting for the same airtime is paid first, and a sale takes what is left over", async () => {
  const { transfer } = await as("sender", (c) => quoteTransfer(c, "sender", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: SELLER, recipientNumber: "08021234567", amountKobo: naira(1_000) }));
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  const first = await landed(naira(1_000));
  assert.equal(first.outcome, "matched", "the sender waiting on a transfer comes first");
  if (first.outcome === "matched") assert.equal(first.transfer.reference, transfer.reference);
  const second = await landed(naira(1_000), { text: "You have received N1000 from 08031234567 at 10:05" });
  assert.equal(second.outcome, "bought");
  if (second.outcome === "bought") assert.equal(second.sellback.reference, sellback.reference);
});

// --- data ---------------------------------------------------------------

test("data bought becomes a lot that expires on the shorter of what we assume and the bundle's own validity", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.assumed_validity_days", 3));
  const { sellback, payKobo } = await sell({ kind: "data", bundleId: mtn1gb.id, amountKobo: undefined });
  assert.equal(sellback.face_kobo, naira(600));
  assert.equal(payKobo, naira(420), "seventy percent of the catalogue price");
  const page = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(page.text, /\*131\*08039990001\*MTN 1GB, 1 year#/);
  await landed(naira(600), { dataMb: 1_024 });
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.state, "settled");
  assert.equal(await balance(pool, "datapool:MTN"), naira(600));
  const lots = await openLots(pool);
  assert.equal(lots.length, 1);
  assert.equal(lots[0]!.value_kobo, naira(600));
  assert.equal(lots[0]!.source, sellback.reference);
  const days = Math.round((new Date(lots[0]!.expires_at!).getTime() - Date.now()) / 86_400_000);
  assert.equal(days, 3, "three days, not the bundle's year");
  // Data we fail to sell on is a loss we can see, not a silent hole.
  const written = await as("founder", (c) => writeOffExpired(c, new Date(Date.now() + 4 * 86_400_000)));
  assert.equal(written.valueKobo, naira(600));
  assert.equal(await balance(pool, "datapool:MTN"), 0);
  assert.equal(await balance(pool, "expense:losses"), naira(600));
  assert.ok(await booksBalance());
});

test("only a bundle the network lets a person gift can be sold to us", async () => {
  const notGiftable = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-5gb", name: "MTN 5GB", sizeMb: 5_120, priceKobo: naira(2_000), giftable: false }));
  await assert.rejects(sell({ kind: "data", bundleId: notGiftable.id, amountKobo: undefined }), /cannot be gifted to us/);
});

// --- the pages and the phone --------------------------------------------

test("the selling page quotes from the dial pad to the credit code, and the phone's message is what settles it", async () => {
  await as("founder", (c) => setSetting(c, "founder", "network.sender_ids", { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" }));
  const { token } = await as("founder", (c) => createDevice(c, "MTN phone", "MTN"));
  const b = new Browser(base);
  const page = await b.get("/sell");
  assert.match(page.text, /Sell us airtime or data you cannot use/);
  assert.match(page.text, /80 percent/);
  const started = await b.post("/sell", { number: SELLER, network: "MTN", amount: "1000", bundle: "", outcome: "credit", bank: "", website: "" }, false);
  assert.equal(started.status, 303);
  const reference = started.location!.slice(3);
  const instruction = await b.get(started.location!);
  assert.match(instruction.text, /\*600\*PIN\*1000\*08039990001#/);
  const r = await fetch(`${base}/bridge/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ from: "MTN", body: `You have received N1000.00 from ${SELLER}.`, receivedAt: new Date().toISOString() }], appVersion: "1.0", battery: 70, queueSize: 0 }),
  });
  const body = (await r.json()) as { results: { outcome: string; transferReference?: string }[] };
  assert.equal(body.results[0]!.outcome, "bought");
  assert.equal(body.results[0]!.transferReference, reference);
  const done = await b.get(`/s/${reference}`);
  assert.match(done.text, /of credit is yours/);
  assert.match(done.text, /CR-[2-9A-HJKMNP-Z]{10}/);
});

test("the command centre shows what was bought, what is owed and what is waiting for cash", async () => {
  await enableCash(naira(50_000), 0);
  const { sellback } = await sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  await landed(naira(1_000));
  const b = new Browser(base);
  await b.login();
  const list = await b.get("/admin/sellbacks");
  assert.match(list.text, /Bought today<\/div><div class="value">N1,000/);
  assert.match(list.text, /Owed to sellers<\/div><div class="value">N800/);
  assert.match(list.text, /Margin earned<\/div><div class="value">N200/);
  assert.match(list.text, /GTB 0123456789 Ada/);
  assert.match(list.text, /has sold to us 1 time/);
  const paid = await b.post(`/admin/sellbacks/${sellback.id}/cash`, { reference: "BNK-7" });
  assert.match(oks(paid.text).join(" "), /Recorded N800 paid to 08031234567/);
  assert.equal((await getSellbackByReference(pool, sellback.reference))!.state, "paid");
  const blocked = await b.post("/admin/sellbacks/block", { number: SELLER, reason: "test" });
  assert.match(oks(blocked.text).join(" "), /cannot sell to us from now on/);
  const unblocked = await b.post("/admin/sellbacks/unblock", { number: SELLER });
  assert.match(oks(unblocked.text).join(" "), /can sell to us again/);
});

test("a sale nobody sends anything for lapses and leaves nothing owed", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.window_minutes", 5));
  const { sellback } = await sell();
  await pool.query("UPDATE sellbacks SET expires_at = now() - interval '1 minute' WHERE id = $1", [sellback.id]);
  assert.equal(await expireSellbacks(pool, "test"), 1);
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.state, "expired");
  assert.equal(await balance(pool, "owed:sellers"), 0);
  // Late airtime inside the grace minutes is still bought, because the
  // seller did their part.
  const outcome = await landed(naira(1_000));
  assert.equal(outcome.outcome, "bought");
  assert.equal((await getSellbackByReference(pool, sellback.reference))!.state, "settled");
});

test("the same network message is never bought twice", async () => {
  const { sellback } = await sell();
  const first = await landed(naira(1_000));
  const again = await landed(naira(1_000));
  assert.equal(first.outcome, "bought");
  assert.equal(again.outcome, "duplicate");
  assert.equal(await balance(pool, "owed:sellers"), naira(800));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM credit_notes")).rows[0].n, 1);
  assert.equal((await getSellbackByReference(pool, sellback.reference))!.state, "settled");
});

test("a message we bought value on is not left nagging in the unmatched list", async () => {
  await sell();
  await landed(naira(1_000));
  const unmatched = (await pool.query("SELECT count(*)::int AS n FROM inbound_notifications WHERE matched_transfer_id IS NULL AND matched_sellback_id IS NULL")).rows[0].n;
  assert.equal(unmatched, 0);
  // And the launch checklist does not report somebody unpaid.
  const list = await runChecklist(pool);
  assert.equal(list.filter((c) => c.title.includes("unmatched airtime")).length, 0, "nothing is reported as unmatched");
  assert.equal(list.filter((c) => c.status === "ok" && c.title === "All airtime received this week is matched").length, 1);
});

test("refunding an order paid with credit puts the value back on the code, and a stopped code keeps it", async () => {
  const { sellback } = await sell();
  await landed(naira(1_000));
  const code = (await getSellbackByReference(pool, sellback.reference))!.credit_code!;
  const b = new Browser(base);
  const first = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  await b.post(`${first.location}/credit`, { code }, false);
  const order = (await pool.query("SELECT * FROM orders ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal((await getCreditNote(pool, code))!.remaining_kobo, naira(300));
  const refunded = await as("founder", (c) => refundOrder(c, "founder", order.id, "could not be delivered"));
  assert.equal(refunded.state, "refunded");
  const note = (await getCreditNote(pool, code))!;
  assert.equal(note.remaining_kobo, naira(800), "the buyer can spend it again");
  assert.equal(note.state, "open");
  assert.equal(await balance(pool, "owed:sellers"), naira(800), "no cash left the bank");
  assert.equal(await balance(pool, "cash:bank"), 0);
  assert.ok(await booksBalance());

  // A code we stopped on purpose cannot take a refund back.
  const second = await b.post("/buy", { number: "08021234567", network: "AIRTEL", amount: "500", bundle: "", email: "" }, false);
  await b.post(`${second.location}/credit`, { code }, false);
  const paidAgain = (await pool.query("SELECT * FROM orders ORDER BY id DESC LIMIT 1")).rows[0];
  await as("founder", (c) => voidCredit(c, "founder", code, "the airtime was not the seller's"));
  const after = await as("founder", (c) => refundOrder(c, "founder", paidAgain.id, "could not be delivered"));
  assert.equal(after.state, "refunded");
  assert.equal((await getCreditNote(pool, code))!.remaining_kobo, 0, "nothing goes back onto a stopped code");
  assert.equal(await balance(pool, "cash:bank"), 0, "and nothing is paid out in cash either");
  assert.ok(await booksBalance());
});

test("the overview says what is owed to sellers and who is waiting on us", async () => {
  await enableCash(naira(50_000), 24);
  await sell({ outcome: "cash", bankDetails: "GTB 0123456789 Ada" });
  await landed(naira(1_000));
  const b = new Browser(base);
  await b.login();
  const page = await b.get("/admin");
  assert.match(page.text, /Owed to sellers right now<\/div><div class="value">N800/);
  assert.match(page.text, /Sellers waiting on us<\/div><div class="value">1/);
});

// --- data that dies too soon to resell -----------------------------------

test("data that does not last long enough is not bought, and is not even offered", async () => {
  const monthly = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-2gb-30", name: "MTN 2GB, 30 days", sizeMb: 2_048, validityDays: 30, priceKobo: naira(1_200), giftable: true }));
  await assert.rejects(
    sell({ kind: "data", bundleId: monthly.id, amountKobo: undefined }),
    /We only take data that lasts 180 days or more, and MTN 2GB, 30 days \(2GB, 30 days, N1,200\) lasts 30 days/,
  );
  // And nobody is offered it, because being refused after you have sent it is
  // worse than not being offered it.
  const page = await new Browser(base).get("/sell");
  assert.doesNotMatch(page.text, /MTN 2GB, 30 days/);
  assert.match(page.text, /MTN 1GB, 1 year/);
});

test("data with no validity written down is not bought at any floor", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.min_validity_days", 1));
  const undated = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-3gb-?", name: "MTN 3GB", sizeMb: 3_072, priceKobo: naira(1_500), giftable: true }));
  await assert.rejects(sell({ kind: "data", bundleId: undated.id, amountKobo: undefined }), /nobody has recorded how long it lasts/);
});

test("the founder can move the validity floor and short dated data becomes buyable", async () => {
  const monthly = await as("founder", (c) => upsertBundle(c, { network: "MTN", code: "mtn-2gb-30", name: "MTN 2GB, 30 days", sizeMb: 2_048, validityDays: 30, priceKobo: naira(1_200), giftable: true }));
  await as("founder", (c) => setSetting(c, "founder", "sellback.min_validity_days", 30));
  const { sellback } = await sell({ kind: "data", bundleId: monthly.id, amountKobo: undefined });
  assert.equal(sellback.face_kobo, naira(1_200));
});

// --- the caps a seller runs into -----------------------------------------

test("one number cannot sell more in a week than the week allows", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.seller_weekly_max_kobo", naira(1_200)));
  await sell({ amountKobo: naira(1_000) });
  await assert.rejects(sell({ amountKobo: naira(500) }), /can sell N1,200 a week and has N200 left until Monday/);
});

test("one number cannot make more sales in a day than the day allows", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.seller_daily_max_count", 2));
  await sell({ amountKobo: naira(100) });
  await sell({ amountKobo: naira(100) });
  await assert.rejects(sell({ amountKobo: naira(100) }), /can make 2 sales a day and has made 2 today/);
});

test("value that arrives over a seller's cap goes straight back and nothing is owed", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.seller_daily_max_kobo", naira(1_000)));
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  // Quoted for N1,000 and sent N1,500: the only way past a cap checked when
  // the quote was made.
  const outcome = await landed(naira(1_500));
  assert.equal(outcome.outcome, "bought_returned");
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.state, "returning");
  assert.equal(after.hold_reason, "over_daily_limit");
  assert.equal(after.credit_code, null, "no credit is given for value we are sending back");
  const page = await new Browser(base).get(`/s/${sellback.reference}`);
  assert.match(page.text, /Being sent back/);
  assert.match(page.text, /sold as much as one number may sell in a day/);
  // And when it has gone, the books are where they started.
  const back = await as("founder", (c) => completeSellbackReturn(c, "founder", after.id, "sent back by hand", { byHand: true }));
  assert.equal(back!.state, "returned");
  assert.equal(await balance(pool, "pool:MTN"), 0);
  assert.equal(await balance(pool, "owed:sellers"), 0);
  assert.equal(await balance(pool, "revenue:sellback_margin"), 0);
  assert.ok(await booksBalance());
});

test("more than we buy in one go goes back on its own too", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.max_kobo", naira(1_000)));
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  await landed(naira(1_200));
  const after = (await getSellbackByReference(pool, sellback.reference))!;
  assert.equal(after.state, "returning");
  assert.equal(after.hold_reason, "amount_above_maximum");
});

test("with the switch off, value over a cap waits for a person instead", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "sellback.seller_daily_max_kobo", naira(1_000));
    await setSetting(c, "founder", "sellback.return_over_cap", false);
  });
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  const outcome = await landed(naira(1_500));
  assert.equal(outcome.outcome, "bought_held");
  assert.equal((await getSellbackByReference(pool, sellback.reference))!.state, "held");
});

test("a sale that fills the cap exactly is not sent back as though it broke it", async () => {
  await as("founder", (c) => setSetting(c, "founder", "sellback.seller_daily_max_kobo", naira(1_000)));
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  await landed(naira(1_000));
  assert.equal((await getSellbackByReference(pool, sellback.reference))!.state, "settled");
});

// --- one bank account, many lines ----------------------------------------

test("cash without an account number in it is refused, and a phone number is not one", async () => {
  await enableCash();
  await assert.rejects(sell({ outcome: "cash", bankDetails: "GTB, Ada Obi" }), /Put the ten digit account number in/);
  // Eleven digits is a phone number. Reading the first ten of it as an
  // account would invent an account nobody holds, and would make the count
  // of lines sharing an account wrong as well as the payment impossible.
  await assert.rejects(sell({ outcome: "cash", bankDetails: "GTB 08031234567 Ada Obi" }), /Put the ten digit account number in/);
  // With both in there, the account is the ten digit one.
  const both = await sell({ outcome: "cash", bankDetails: "GTB 08031234567 account 0123456789 Ada Obi" });
  assert.equal(both.sellback.bank_account_digits, "0123456789");
});

test("one bank account collecting for more lines than allowed is held with the other numbers named", async () => {
  await enableCash();
  await as("founder", (c) => setSetting(c, "founder", "sellback.bank_max_numbers", 2));
  const account = "GTB 0123456789 Ada Obi";
  const first = await sell({ outcome: "cash", bankDetails: account });
  await landed(naira(1_000));
  assert.equal((await getSellbackByReference(pool, first.sellback.reference))!.state, "received");
  const second = await sell({ outcome: "cash", bankDetails: account, sellerNumber: "08035550002" });
  await landed(naira(1_000), { seller: "08035550002" });
  assert.equal((await getSellbackByReference(pool, second.sellback.reference))!.state, "received");
  // The third line on the same account is one too many.
  const third = await sell({ outcome: "cash", bankDetails: account, sellerNumber: "08035550003" });
  await landed(naira(1_000), { seller: "08035550003" });
  const held = (await getSellbackByReference(pool, third.sellback.reference))!;
  assert.equal(held.state, "held", "a judgement call, so it waits for a person rather than going back");
  assert.equal(held.hold_reason, "bank_account_shared");
  const b = new Browser(base);
  await b.login();
  const page = await b.get(`/admin/sellbacks/${held.id}`);
  assert.match(page.text, /also been given for sales from 2 other numbers: 08031234567, 08035550002/);
});

// --- sending value back through a phone ----------------------------------

test("a return a phone is sending cannot also be recorded by hand", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "payout.automatic", true);
    await setSetting(c, "founder", "sellback.min_kobo", naira(500));
  });
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  await landed(naira(200));
  const held = (await getSellbackByReference(pool, sellback.reference))!;
  const going = await as("founder", (c) => startSellbackReturn(c, "founder", held.id));
  assert.equal(going.return_rail, null, "the phones have it, so nobody has taken it over");
  await assert.rejects(
    as("founder", (c) => completeSellbackReturn(c, "founder", held.id, "sent it myself", { byHand: true })),
    /with a sending phone/,
  );
  // Taking it over makes it theirs, and then it can be recorded.
  assert.equal(await as("founder", (c) => returnByHand(c, "founder", held.id)), true);
  const back = await as("founder", (c) => completeSellbackReturn(c, "founder", held.id, "sent N200 from the SIM", { byHand: true }));
  assert.equal(back!.state, "returned");
});

test("a return a phone has already been given cannot be taken over", async () => {
  // Once a phone has the command, taking it over is how the value goes out
  // twice: the phone sends it and a person sends it again.
  await as("founder", async (c) => {
    await setSetting(c, "founder", "payout.automatic", true);
    await setSetting(c, "founder", "sellback.min_kobo", naira(500));
  });
  const { sellback } = await sell({ amountKobo: naira(1_000) });
  await landed(naira(200));
  const held = (await getSellbackByReference(pool, sellback.reference))!;
  await as("founder", (c) => startSellbackReturn(c, "founder", held.id));
  await pool.query("UPDATE sellbacks SET return_request_id = 'sellback-return-1' WHERE id = $1", [held.id]);
  assert.equal(await as("founder", (c) => returnByHand(c, "founder", held.id)), false);
  await assert.rejects(
    as("founder", (c) => completeSellbackReturn(c, "founder", held.id, "sent it myself", { byHand: true })),
    /with a sending phone/,
  );
});

test("data sent back gives up the lot as well as the money", async () => {
  const { sellback } = await sell({ kind: "data", bundleId: mtn1gb.id, amountKobo: undefined });
  await landed(naira(600), { dataMb: 1_024 });
  const bought = (await getSellbackByReference(pool, sellback.reference))!;
  // Credit was given, so the code has to be stopped before it can go back.
  await as("founder", (c) => voidCredit(c, "founder", bought.credit_code!, "sent us somebody else's data"));
  await pool.query("UPDATE sellbacks SET credit_code = NULL WHERE id = $1", [bought.id]);
  await pool.query("UPDATE sellbacks SET state = 'received' WHERE id = $1", [bought.id]);
  await as("founder", (c) => startSellbackReturn(c, "founder", bought.id));
  await as("founder", (c) => completeSellbackReturn(c, "founder", bought.id, "gifted back from the SIM", { byHand: true }));
  assert.equal(await balance(pool, "datapool:MTN"), 0);
  assert.equal((await openLots(pool)).length, 0, "the lot goes with the data, or it would be written off twice");
});

test("a message about value over a cap is recorded as sent back, not left unmatched", async () => {
  await as("founder", async (c) => {
    await setSetting(c, "founder", "network.sender_ids", { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" });
    await setSetting(c, "founder", "sellback.seller_daily_max_kobo", naira(1_000));
  });
  const { token } = await as("founder", (c) => createDevice(c, "MTN phone", "MTN"));
  await sell({ amountKobo: naira(1_000) });
  const r = await fetch(`${base}/bridge/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ from: "MTN", body: `You have received N1500.00 from ${SELLER}.`, receivedAt: new Date().toISOString() }] }),
  });
  const body = (await r.json()) as { results: { outcome: string }[] };
  assert.equal(body.results[0]!.outcome, "bought_returned");
  const recorded = await pool.query<{ outcome: string }>("SELECT outcome FROM bridge_messages ORDER BY id DESC LIMIT 1");
  assert.equal(recorded.rows[0]!.outcome, "bought_returned");
});
