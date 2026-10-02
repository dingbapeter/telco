// Puts enough real data in the test database for every page to have
// something on it, and prints the logins the sweep needs as shell exports.
import { createApiKey } from "../src/agentkeys.ts";
import { createAgent, setAgentTerms, topUpWallet } from "../src/agents.ts";
import { createAdmin } from "../src/auth.ts";
import { createDevice } from "../src/bridge.ts";
import { fetchCommands, reportResult } from "../src/sendingphone.ts";
import { buyInBulk } from "../src/bulkorders.ts";
import { upsertBundle } from "../src/bundles.ts";
import { closePool, withActor } from "../src/db.ts";
import { postJournal } from "../src/ledger.ts";
import { createOrder } from "../src/orders.ts";
import { setSetting } from "../src/settings.ts";
import { askForBalance, recordBalanceAnswer } from "../src/balances.ts";
import { quoteSellback, startSellbackReturn } from "../src/sellbacks.ts";
import { quoteTransfer, recordInbound } from "../src/transfers.ts";

const ADMIN = { email: "founder@example.com", name: "Founder", password: "correct horse battery" };
const AGENT = { name: "Mama Nkechi shop", phone: "08051234567", password: "a long agent password" };

const out = await withActor("seed", async (c) => {
  await createAdmin(c, ADMIN);
  await createAdmin(c, { email: "ada@example.com", name: "Ada", password: "a long staff password", role: "staff" });
  await setSetting(c, "seed", "retail.enabled", true);
  await setSetting(c, "seed", "agent.enabled", true);
  await setSetting(c, "seed", "agent.api_enabled", true);
  await setSetting(c, "seed", "agent.credit_enabled", true);
  await setSetting(c, "seed", "agent.credit_max_kobo", 1_000_000);
  await setSetting(c, "seed", "retail.bank_name", "Example Bank");
  await setSetting(c, "seed", "retail.bank_account_number", "0123456789");
  await setSetting(c, "seed", "retail.bank_account_name", "Telco Ltd");
  await setSetting(c, "seed", "network.transfer_code", { MTN: "*321*{pin}*{amount}*{number}#", AIRTEL: "*432*{amount}*{number}#", GLO: "", "9MOBILE": "" });
  await setSetting(c, "seed", "network.data_gift_code", { MTN: "*131*{number}*{size}#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  await setSetting(c, "seed", "sellback.airtime_enabled", true);
  await setSetting(c, "seed", "sellback.data_enabled", true);
  await setSetting(c, "seed", "sellback.cash_enabled", true);
  await setSetting(c, "seed", "sellback.cash_daily_cap_kobo", 5_000_000);
  await setSetting(c, "seed", "sellback.daily_buy_cap_kobo", { MTN: 10_000_000, AIRTEL: 10_000_000, GLO: 10_000_000, "9MOBILE": 10_000_000 });
  await c.query("INSERT INTO receiving_numbers (number, network_code, label) VALUES ('08039990001', 'MTN', 'office'), ('08029990001', 'AIRTEL', 'office') ON CONFLICT DO NOTHING");
  await postJournal(c, { idempotencyKey: "seed:airtel", description: "Seed float", postings: [{ account: "pool:AIRTEL", amountKobo: 500_000 }, { account: "equity:float", amountKobo: -500_000 }] });
  await upsertBundle(c, { network: "AIRTEL", code: "airtel-1gb", name: "Airtel 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: 50_000, providerVariationCode: "x" });
  await upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 1 year", sizeMb: 1024, validityDays: 365, priceKobo: 60_000, giftable: true });
  const { device } = await createDevice(c, "MTN phone", "MTN");
  await c.query("UPDATE bridge_devices SET can_send = true, pin_set = true, last_seen_at = now() WHERE id = $1", [device.id]);
  await setSetting(c, "seed", "network.balance_code", { MTN: "*310#", AIRTEL: "", GLO: "", "9MOBILE": "" });
  // One balance check already answered, so the Pools page has a real
  // difference on it rather than an empty table.
  const { check } = await askForBalance(c, "seed", "MTN");
  await fetchCommands(c, device.id);
  const command = await reportResult(c, device.id, check.command_id, { ok: true, response: "Your balance is N4,850.00 valid till 31/12/2026" });
  await recordBalanceAnswer(c, command!);
  const { agent } = await createAgent(c, AGENT);
  await topUpWallet(c, agent.id, { reference: "seed", paidKobo: 250_000, feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" });
  await setAgentTerms(c, agent.id, { discountBasisPoints: 300, commissionBasisPoints: null, creditLimitKobo: 500_000 });
  await createApiKey(c, agent.id, "Till at the front counter", "seed");
  const batch = await buyInBulk(c, agent, "seed", { reference: "BK-SEED2345", text: "08031234567 500\n08021234567 airtel 200" });
  const { transfer } = await quoteTransfer(c, "seed", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: 50_000 });
  await recordInbound(c, "seed", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: 50_000, rawText: "You have received N500 from 08031234567", source: "manual" });
  const { transfer: waiting } = await quoteTransfer(c, "seed", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234568", recipientNumber: "08021234567", amountKobo: 100_000 });
  const order = await createOrder(c, "seed", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: 50_000 });
  // One sale waiting for the seller to send, and one that landed and is
  // waiting for cash, so both sides of buying back have real figures.
  const { sellback: waitingSale } = await quoteSellback(c, "seed", { network: "MTN", sellerNumber: "08031234570", kind: "airtime", amountKobo: 100_000, outcome: "credit" });
  const { sellback: cashSale } = await quoteSellback(c, "seed", { network: "MTN", sellerNumber: "08031234571", kind: "airtime", amountKobo: 200_000, outcome: "cash", bankDetails: "Example Bank 0123456789 Ada Obi" });
  await recordInbound(c, "seed", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234571", amountKobo: 200_000, rawText: "You have received N2000 from 08031234571", source: "manual" });
  // And one we have decided not to buy, on its way back to the seller's own
  // line, so the page that handles that is never photographed empty.
  // Asking for cash into the same account as the sale above, so the warning
  // about one account collecting for several lines is on the page too.
  const { sellback: goingBack } = await quoteSellback(c, "seed", { network: "MTN", sellerNumber: "08031234572", kind: "airtime", amountKobo: 150_000, outcome: "cash", bankDetails: "Example Bank 0123456789 Ada Obi" });
  await recordInbound(c, "seed", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234572", amountKobo: 150_000, rawText: "You have received N1500 from 08031234572", source: "manual" });
  await startSellbackReturn(c, "seed", goingBack.id);
  return { transferId: transfer.id, transferRef: waiting.reference, orderRef: order.reference, agentId: agent.id, batchRef: batch.batch.reference, sellRef: waitingSale.reference, sellbackId: cashSale.id };
});
await closePool();
console.log(`export TRANSFER_ID=${out.transferId} TRANSFER_REF=${out.transferRef} ORDER_REF=${out.orderRef} AGENT_ID=${out.agentId} BATCH_REF=${out.batchRef} SELL_REF=${out.sellRef} SELLBACK_ID=${out.sellbackId} ADMIN_EMAIL=${ADMIN.email} ADMIN_PASSWORD='${ADMIN.password}' AGENT_PHONE=${AGENT.phone} AGENT_PASSWORD='${AGENT.password}'`);
