// Walks the real product on a phone-sized browser and keeps a screenshot of
// every screen a customer, a seller and an agent sees. Nothing here is a
// mockup: it drives the pages the server actually serves, against a real
// database, and moves the money between screenshots the way the rails do.
//
// Run with: scripts/phone-walkthrough.sh
import { mkdir, rm } from "node:fs/promises";
import pg from "pg";
import { devices, chromium } from "playwright";
import { createAgent, setAgentTerms, topUpWallet } from "../src/agents.ts";
import { buildApp } from "../src/app.ts";
import { createAdmin } from "../src/auth.ts";
import { askForBalance, recordBalanceAnswer } from "../src/balances.ts";
import { createDevice } from "../src/bridge.ts";
import { fetchCommands, reportResult } from "../src/sendingphone.ts";
import { buyInBulk } from "../src/bulkorders.ts";
import { upsertBundle } from "../src/bundles.ts";
import { withActor } from "../src/db.ts";
import { postJournal } from "../src/ledger.ts";
import { naira } from "../src/money.ts";
import { completeDelivery, recordPayment, startDelivery } from "../src/orders.ts";
import { setSetting } from "../src/settings.ts";
import { completePayout, recordInbound, startPayout } from "../src/transfers.ts";

const out = process.env.SHOTS_DIR ?? "phone-screens";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ADMIN = { email: "founder@example.com", name: "Founder", password: "correct horse battery" };
const AGENT = { name: "Mama Nkechi shop", phone: "08051234567", password: "a long agent password" };
const SENDER = "08031234567";
const RECIPIENT = "08021234567";
const SELLER = "08037654321";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Everything the product needs to be open for business, set the way a
// founder would set it on the first day.
await withActor("walkthrough", async (c) => {
  await createAdmin(c, ADMIN);
  await setSetting(c, "walkthrough", "retail.enabled", true);
  await setSetting(c, "walkthrough", "agent.enabled", true);
  await setSetting(c, "walkthrough", "retail.bank_name", "Example Bank");
  await setSetting(c, "walkthrough", "retail.bank_account_number", "0123456789");
  await setSetting(c, "walkthrough", "retail.bank_account_name", "Telco Ltd");
  await setSetting(c, "walkthrough", "network.transfer_code", { MTN: "*600*{pin}*{amount}*{number}#", AIRTEL: "*432*{amount}*{number}#", GLO: "", "9MOBILE": "" });
  await setSetting(c, "walkthrough", "network.data_gift_code", { MTN: "*131*{number}*{size}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  await setSetting(c, "walkthrough", "sellback.airtime_enabled", true);
  await setSetting(c, "walkthrough", "sellback.data_enabled", true);
  await setSetting(c, "walkthrough", "sellback.daily_buy_cap_kobo", { MTN: naira(500_000), AIRTEL: naira(500_000), GLO: naira(500_000), "9MOBILE": naira(500_000) });
  await c.query("INSERT INTO receiving_numbers (number, network_code, label) VALUES ('08039990001', 'MTN', 'office'), ('08029990001', 'AIRTEL', 'office') ON CONFLICT DO NOTHING");
  await postJournal(c, { idempotencyKey: "walkthrough:float", description: "Founder's float", postings: [{ account: "pool:AIRTEL", amountKobo: naira(50_000) }, { account: "pool:MTN", amountKobo: naira(50_000) }, { account: "equity:float", amountKobo: -naira(100_000) }] });
  await upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: naira(600), giftable: true });
  await upsertBundle(c, { network: "AIRTEL", code: "airtel-1gb", name: "Airtel 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: naira(500), giftable: true });
  // A phone on MTN that has already been asked what the network says the
  // SIM holds, so the Pools page shows a real difference.
  await createAdmin(c, { email: "ada@example.com", name: "Ada", password: "a long staff password", role: "staff" });
  await setSetting(c, "walkthrough", "network.balance_code", { MTN: "*310#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  const { device } = await createDevice(c, "MTN phone", "MTN");
  await c.query("UPDATE bridge_devices SET can_send = true, pin_set = true, last_seen_at = now() WHERE id = $1", [device.id]);
  const { check } = await askForBalance(c, "walkthrough", "MTN");
  await fetchCommands(c, device.id);
  const answered = await reportResult(c, device.id, check.command_id, { ok: true, response: "Your balance is N48,600.00 valid till 31/12/2026" });
  await recordBalanceAnswer(c, answered);
  const { agent } = await createAgent(c, AGENT);
  await setAgentTerms(c, agent.id, { discountBasisPoints: 300, commissionBasisPoints: null, creditLimitKobo: 0 });
  await topUpWallet(c, agent.id, { reference: "walkthrough", paidKobo: naira(5_000), feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" });
  await buyInBulk(c, agent, "walkthrough", { reference: "BK-WALK2345", text: "08031234567 500\n08021234567 airtel 200" });
}, db);

const app = buildApp(db, { secureCookies: false, publicBaseUrl: "http://127.0.0.1:3996" });
const server = app.listen(3996);
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:3996";

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13"] });
const page = await context.newPage();
let n = 0;
const shot = async (name) => {
  n += 1;
  const file = `${out}/${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
};

// 1. A sender moves airtime from MTN to Airtel.
await page.goto(`${base}/`);
await shot("home");
await page.fill("#sender", SENDER);
await page.selectOption("#from", "MTN");
await page.fill("#recipient", RECIPIENT);
await page.selectOption("#to", "AIRTEL");
await page.fill("#amount", "1000");
await shot("quote-form-filled");
await page.click("#quote button[type=submit]");
await page.waitForURL(/\/t\/TX-/);
const transferRef = page.url().split("/t/")[1];
await shot("what-to-dial");

// The sender dials. The network texts our SIM and the bridge forwards it.
const transfer = (await db.query("SELECT id FROM transfers WHERE reference = $1", [transferRef])).rows[0];
await withActor("bridge:MTN phone", (c) => recordInbound(c, "bridge:MTN phone", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: SENDER, amountKobo: naira(1_000), rawText: `You have received N1000.00 from ${SENDER}. Your balance is N40.00.`, source: "bridge" }), db);
await page.reload();
await shot("airtime-received");
await withActor("worker:payouts", (c) => startPayout(c, "worker:payouts", transfer.id), db);
await withActor("worker:payouts", (c) => completePayout(c, "worker:payouts", transfer.id, "VT-884213"), db);
await page.reload();
await shot("transfer-done");

// 2. A buyer buys Airtel airtime from us and pays by bank transfer.
await page.goto(`${base}/buy`);
await page.fill("#number", RECIPIENT);
await page.selectOption("#network", "AIRTEL");
await page.fill("#amount", "1000");
await shot("buy-form");
await page.click("form[action='/buy'] button[type=submit]");
await page.waitForURL(/\/o\/RT-/);
const orderRef = page.url().split("/o/")[1];
await shot("how-to-pay");
const order = (await db.query("SELECT id, price_kobo FROM orders WHERE reference = $1", [orderRef])).rows[0];
await withActor("founder", (c) => recordPayment(c, "founder", order.id, { method: "bank_transfer", reference: "BNK-77421", paidKobo: order.price_kobo, feeKobo: 0, cashAccount: "cash:bank" }), db);
await withActor("worker:payouts", async (c) => {
  await startDelivery(c, "worker:payouts", order.id);
  await completeDelivery(c, "worker:payouts", order.id, "VT-884999");
}, db);
await page.reload();
await shot("order-delivered");

// 3. Somebody sells us airtime they cannot use and takes credit.
await page.goto(`${base}/sell`);
await shot("sell-rates");
await page.fill("#number", SELLER);
await page.selectOption("#network", "MTN");
await page.fill("#amount", "2000");
await page.click("form[action='/sell'] button[type=submit]");
await page.waitForURL(/\/s\/SB-/);
const saleRef = page.url().split("/s/")[1];
await shot("what-to-send-us");
await withActor("bridge:MTN phone", (c) => recordInbound(c, "bridge:MTN phone", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: SELLER, amountKobo: naira(2_000), rawText: `You have received N2000.00 from ${SELLER}. Your balance is N5.00.`, source: "bridge" }), db);
await page.reload();
await shot("credit-code");
const code = (await db.query("SELECT credit_code FROM sellbacks WHERE reference = $1", [saleRef])).rows[0].credit_code;

// 4. The seller spends that credit on data for somebody else.
await page.goto(`${base}/buy`);
await page.fill("#number", "08031112222");
await page.selectOption("#network", "MTN");
await page.selectOption("#bundle", { label: "MTN 1GB, 30 days (1GB, 30 days, N600)" });
await page.click("form[action='/buy'] button[type=submit]");
await page.waitForURL(/\/o\/RT-/);
await page.fill("#code", code);
await shot("paying-with-credit");
await page.click("form[action$='/credit'] button[type=submit]");
await page.waitForLoadState();
await shot("credit-spent");

// 5. The agent's shop: the wallet, and buying for a queue of customers.
await page.goto(`${base}/agent/login`);
await page.fill("#phone", AGENT.phone);
await page.fill("#password", AGENT.password);
await page.click("form button[type=submit]");
await page.waitForURL(`${base}/agent`);
await shot("agent-wallet");
await page.goto(`${base}/agent/bulk`);
await page.fill("#list", "08031234567 500\n08021234567 airtel 200\n08039991111 1000\n08021112222 airtel 1gb");
await shot("agent-buys-for-many");
await page.click("form[action='/agent/bulk'] button[type=submit]");
await page.waitForURL(/\/agent\/list\/BK-/);
await shot("agent-list-bought");
await page.goto(`${base}/agent/statement`);
await shot("agent-statement");

// 6. What the founder sees, on the same phone.
await page.goto(`${base}/admin/login`);
await page.fill("#email", ADMIN.email);
await page.fill("#password", ADMIN.password);
await page.click("button[type=submit]");
await page.waitForURL(`${base}/admin`);
await shot("command-centre");
await page.goto(`${base}/admin/sellbacks`);
await shot("command-centre-buying-back");
await page.goto(`${base}/admin/money`);
await shot("command-centre-money");
await page.goto(`${base}/admin/pools`);
await shot("command-centre-sim-balances");
await page.goto(`${base}/admin/find?q=${SELLER}`);
await shot("command-centre-find");
await page.goto(`${base}/admin/people`);
await shot("command-centre-people");

await browser.close();
server.close();
await db.end();
console.log(`\n${n} screens in ${out}/`);
