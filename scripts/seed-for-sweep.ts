// Puts enough real data in the test database for every page to have
// something on it, and prints the logins the sweep needs as shell exports.
import { createAgent, topUpWallet } from "../src/agents.ts";
import { createAdmin } from "../src/auth.ts";
import { createDevice } from "../src/bridge.ts";
import { upsertBundle } from "../src/bundles.ts";
import { closePool, withActor } from "../src/db.ts";
import { postJournal } from "../src/ledger.ts";
import { createOrder } from "../src/orders.ts";
import { setSetting } from "../src/settings.ts";
import { quoteTransfer, recordInbound } from "../src/transfers.ts";

const ADMIN = { email: "founder@example.com", name: "Founder", password: "correct horse battery" };
const AGENT = { name: "Mama Nkechi shop", phone: "08051234567", password: "a long agent password" };

const out = await withActor("seed", async (c) => {
  await createAdmin(c, ADMIN);
  await setSetting(c, "seed", "retail.enabled", true);
  await setSetting(c, "seed", "agent.enabled", true);
  await setSetting(c, "seed", "retail.bank_name", "Example Bank");
  await setSetting(c, "seed", "retail.bank_account_number", "0123456789");
  await setSetting(c, "seed", "retail.bank_account_name", "Telco Ltd");
  await setSetting(c, "seed", "network.transfer_code", { MTN: "*321*{pin}*{amount}*{number}#", AIRTEL: "*432*{amount}*{number}#", GLO: "", "9MOBILE": "" });
  await c.query("INSERT INTO receiving_numbers (number, network_code, label) VALUES ('08039990001', 'MTN', 'office'), ('08029990001', 'AIRTEL', 'office') ON CONFLICT DO NOTHING");
  await postJournal(c, { idempotencyKey: "seed:airtel", description: "Seed float", postings: [{ account: "pool:AIRTEL", amountKobo: 500_000 }, { account: "equity:float", amountKobo: -500_000 }] });
  await upsertBundle(c, { network: "AIRTEL", code: "airtel-1gb", name: "Airtel 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: 50_000, providerVariationCode: "x" });
  await upsertBundle(c, { network: "MTN", code: "mtn-1gb", name: "MTN 1GB, 30 days", sizeMb: 1024, validityDays: 30, priceKobo: 60_000, giftable: true });
  await createDevice(c, "MTN phone", "MTN");
  const { agent } = await createAgent(c, AGENT);
  await topUpWallet(c, agent.id, { reference: "seed", paidKobo: 250_000, feeKobo: 0, cashAccount: "cash:bank", method: "bank_transfer" });
  const { transfer } = await quoteTransfer(c, "seed", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234567", recipientNumber: "08021234567", amountKobo: 50_000 });
  await recordInbound(c, "seed", { networkCode: "MTN", receivingNumber: "08039990001", senderNumber: "08031234567", amountKobo: 50_000, rawText: "You have received N500 from 08031234567", source: "manual" });
  const { transfer: waiting } = await quoteTransfer(c, "seed", { fromNetwork: "MTN", toNetwork: "AIRTEL", senderNumber: "08031234568", recipientNumber: "08021234567", amountKobo: 100_000 });
  const order = await createOrder(c, "seed", { network: "AIRTEL", recipientNumber: "08021234567", faceKobo: 50_000 });
  return { transferId: transfer.id, transferRef: waiting.reference, orderRef: order.reference };
});
await closePool();
console.log(`export TRANSFER_ID=${out.transferId} TRANSFER_REF=${out.transferRef} ORDER_REF=${out.orderRef} ADMIN_EMAIL=${ADMIN.email} ADMIN_PASSWORD='${ADMIN.password}' AGENT_PHONE=${AGENT.phone} AGENT_PASSWORD='${AGENT.password}'`);
