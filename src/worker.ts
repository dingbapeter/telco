import type pg from "pg";
import { withActor } from "./db.ts";
import type { PayoutRail, SendResult } from "./rails/rail.ts";
import { newRequestId } from "./rails/vtpass.ts";
import { expireCommands, PhoneRail } from "./sendingphone.ts";
import { getSettingValues, type NetworkCode } from "./settings.ts";
import { completeDelivery, failDelivery, startDelivery, type Order } from "./orders.ts";
import { completePayout, completeRefund, failPayout, getTransfer, startPayout, type Transfer } from "./transfers.ts";

export type CycleReport = { checked: number; sent: number; delivered: number; retried: number; failed: number; skipped: string[] };

const ACTOR = "worker:payouts";

export type Rails = { provider?: PayoutRail | undefined; phone: PhoneRail };

// Which rail pays a network: the founder's route setting, provided that
// rail can actually do it right now. A bundle the provider does not know,
// and every gifted bundle from a data pool, goes through the phone.
export async function chooseRail(db: pg.Pool, rails: Rails, network: NetworkCode, bundle?: { provider_variation_code: string | null } | undefined): Promise<{ rail: PayoutRail } | { rail: undefined; reason: string }> {
  const [routes] = await getSettingValues(db, ["payout.route"] as const);
  const wantPhone = routes[network] === "phone" || (bundle !== undefined && !bundle.provider_variation_code);
  if (!wantPhone && rails.provider) return { rail: rails.provider };
  if (await rails.phone.available(network)) return { rail: rails.phone };
  if (!wantPhone) return { rail: undefined, reason: `No provider keys on the server and no phone on ${network} can send.` };
  return { rail: undefined, reason: bundle && !bundle.provider_variation_code ? `${network} phone cannot send right now, and the provider does not know this bundle.` : `${network} is routed to the phone and no phone on ${network} can send right now.` };
}

function fundingFor(rail: PayoutRail, network: NetworkCode, bundle?: { id: number } | undefined): string {
  return rail.fundingAccountFor ? rail.fundingAccountFor(network, bundle) : rail.fundingAccount;
}

// One pass of automatic payouts. Runs every few seconds. Every step is a
// conditional state change, so two workers or a restart in the middle can
// never pay twice: a payout whose answer never came is checked with the
// provider by its request id before anything is sent again.
export async function runPayoutCycle(db: pg.Pool, railOrRails: PayoutRail | Rails, now = new Date()): Promise<CycleReport> {
  const rails: Rails = "phone" in railOrRails && railOrRails.phone instanceof PhoneRail ? (railOrRails as Rails) : { provider: railOrRails as PayoutRail, phone: new PhoneRail(db) };
  const report: CycleReport = { checked: 0, sent: 0, delivered: 0, retried: 0, failed: 0, skipped: [] };
  const [automatic, maxAttempts, timeout] = await getSettingValues(db, ["payout.automatic", "payout.max_attempts", "phone.command_timeout_minutes"] as const);
  if (!automatic) {
    report.skipped.push("automatic payouts are off");
    return report;
  }
  await expireCommands(db, timeout);
  const byName = (name: string): PayoutRail | undefined => (name === "phone" ? rails.phone : rails.provider?.name === name ? rails.provider : undefined);

  // First, anything we sent and never heard back about.
  const unanswered = await db.query<Transfer>(
    `SELECT t.* FROM transfers t
     WHERE t.state = 'paying_out' AND t.payout_rail IN ('phone', $1) AND t.payout_request_id IS NOT NULL
       AND (SELECT max(at) FROM transfer_events e WHERE e.transfer_id = t.id) < $2::timestamptz - interval '45 seconds'
     ORDER BY t.id LIMIT 20`,
    [rails.provider?.name ?? "phone", now],
  );
  for (const t of unanswered.rows) {
    const rail = byName(t.payout_rail!);
    if (!rail) continue;
    report.checked += 1;
    const result = await rail.check(t.payout_request_id!);
    await settle(db, rail, t.id, result, report, t.to_network, t.out_bundle_id ? { id: t.out_bundle_id } : undefined);
  }

  // Refunds: airtime or a bundle back to the sender, through the phone.
  await runRefunds(db, rails, report, now);

  // Then transfers waiting to be paid, including failed ones whose wait is over.
  const due = await db.query<Transfer>(
    `SELECT * FROM transfers
     WHERE (state = 'inbound_confirmed')
        OR (state = 'payout_failed' AND payout_next_attempt_at IS NOT NULL AND payout_next_attempt_at <= $1::timestamptz AND payout_attempts < $2)
     ORDER BY created_at LIMIT 10`,
    [now, maxAttempts],
  );
  for (const t of due.rows) {
    const bundle = t.out_bundle_id ? (await db.query<{ id: number; name: string; network_code: string; provider_variation_code: string | null; code: string }>("SELECT id, name, network_code, provider_variation_code, code FROM data_bundles WHERE id = $1", [t.out_bundle_id])).rows[0] : undefined;
    const choice = await chooseRail(db, rails, t.to_network, bundle);
    if (!choice.rail) {
      report.skipped.push(`${t.reference}: ${choice.reason}`);
      continue;
    }
    const rail = choice.rail;
    const requestId = newRequestId(now);
    const start = await withActor(ACTOR, (c) => startPayout(c, ACTOR, t.id, { fundingAccount: fundingFor(rail, t.to_network, bundle), rail: rail.name, requestId }), db);
    if (!start.started) {
      report.skipped.push(`${t.reference}: ${start.reason}`);
      continue;
    }
    report.sent += 1;
    const result = await rail.send({ requestId, network: start.instruction.network, number: start.instruction.number, amountKobo: start.instruction.amountKobo, bundle: bundle ? { variationCode: bundle.provider_variation_code ?? bundle.code, name: bundle.name } : undefined });
    await settle(db, rail, t.id, result, report, t.to_network, bundle);
  }
  return report;
}

// Refunds go back the way the value came: airtime to the sender's line
// from that network's pool, or the same bundle gifted back from the data
// pool, through the phone. A refund is only ever queued once.
async function runRefunds(db: pg.Pool, rails: Rails, report: CycleReport, now: Date): Promise<void> {
  const waiting = await db.query<Transfer>(
    `SELECT t.* FROM transfers t WHERE t.state = 'refunding' AND t.refund_request_id IS NOT NULL
       AND (SELECT max(at) FROM transfer_events e WHERE e.transfer_id = t.id) < $1::timestamptz - interval '45 seconds' ORDER BY t.id LIMIT 20`,
    [now],
  );
  for (const t of waiting.rows) {
    report.checked += 1;
    const result = await rails.phone.check(t.refund_request_id!);
    if (result.kind === "delivered") {
      const done = await withActor(ACTOR, (c) => completeRefund(c, ACTOR, t.id, result.reference), db);
      if (done) report.delivered += 1;
    } else if (result.kind === "failed" || result.kind === "retry") {
      // Back to a person: the refund page shows the phone's words.
      await withActor(ACTOR, (c) => c.query("UPDATE transfers SET refund_request_id = NULL, refund_rail = 'manual', payout_last_error = $2 WHERE id = $1 AND state = 'refunding'", [t.id, `Refund through the phone did not complete: ${result.message}`]), db);
      report.failed += 1;
    }
  }
  const due = await db.query<Transfer>("SELECT * FROM transfers WHERE state = 'refunding' AND refund_request_id IS NULL AND coalesce(refund_rail, '') <> 'manual' ORDER BY created_at LIMIT 10");
  for (const t of due.rows) {
    if (!(await rails.phone.available(t.from_network))) {
      report.skipped.push(`${t.reference}: refund waits for a person; no phone on ${t.from_network} can send.`);
      continue;
    }
    const inBundle = t.in_bundle_id ? (await db.query<{ code: string; name: string }>("SELECT code, name FROM data_bundles WHERE id = $1", [t.in_bundle_id])).rows[0] : undefined;
    const requestId = `refund-${newRequestId(now)}`;
    await withActor(ACTOR, (c) => c.query("UPDATE transfers SET refund_rail = 'phone', refund_request_id = $2 WHERE id = $1 AND state = 'refunding' AND refund_request_id IS NULL", [t.id, requestId]), db);
    report.sent += 1;
    const result = await rails.phone.send({ requestId, network: t.from_network, number: t.sender_number, amountKobo: t.received_kobo!, bundle: inBundle ? { variationCode: inBundle.code, name: inBundle.name } : undefined });
    if (result.kind !== "processing") {
      await withActor(ACTOR, (c) => c.query("UPDATE transfers SET refund_request_id = NULL, refund_rail = 'manual', payout_last_error = $2 WHERE id = $1", [t.id, result.message]), db);
      report.failed += 1;
    }
  }
}

async function settle(db: pg.Pool, rail: PayoutRail, transferId: number, result: SendResult, report: CycleReport, network: NetworkCode, bundle?: { id: number } | undefined): Promise<void> {
  switch (result.kind) {
    case "delivered": {
      const done = await withActor(ACTOR, (c) => completePayout(c, ACTOR, transferId, result.reference, { account: fundingFor(rail, network, bundle), chargedKobo: result.chargedKobo, commissionKobo: result.commissionKobo }), db);
      if (done) report.delivered += 1;
      return;
    }
    case "retry":
      await withActor(ACTOR, (c) => failPayout(c, ACTOR, transferId, result.message, { retryable: true }), db);
      report.retried += 1;
      return;
    case "failed":
      await withActor(ACTOR, (c) => failPayout(c, ACTOR, transferId, result.message, { retryable: false }), db);
      report.failed += 1;
      return;
    case "processing":
    case "unknown": {
      // Leave it paying out; the next cycle asks the provider by request id.
      const t = await getTransfer(db, transferId);
      if (t) await withActor(ACTOR, (c) => c.query("UPDATE transfers SET payout_last_error = $2 WHERE id = $1", [transferId, result.message]), db);
      return;
    }
  }
}

// Retail orders that have been paid are delivered the same way transfers
// are paid out, with the same rules: never twice, retry with a wait, leave
// a final failure for a person.
export async function runDeliveryCycle(db: pg.Pool, railOrRails: PayoutRail | Rails, now = new Date()): Promise<CycleReport> {
  const rails: Rails = "phone" in railOrRails && railOrRails.phone instanceof PhoneRail ? (railOrRails as Rails) : { provider: railOrRails as PayoutRail, phone: new PhoneRail(db) };
  const report: CycleReport = { checked: 0, sent: 0, delivered: 0, retried: 0, failed: 0, skipped: [] };
  const [automatic, maxAttempts] = await getSettingValues(db, ["payout.automatic", "payout.max_attempts"] as const);
  if (!automatic) {
    report.skipped.push("automatic payouts are off");
    return report;
  }
  const byName = (name: string): PayoutRail | undefined => (name === "phone" ? rails.phone : rails.provider?.name === name ? rails.provider : undefined);
  const unanswered = await db.query<Order>(
    `SELECT o.* FROM orders o
     WHERE o.state = 'delivering' AND o.delivery_rail IN ('phone', $1) AND o.delivery_request_id IS NOT NULL
       AND (SELECT max(at) FROM order_events e WHERE e.order_id = o.id) < $2::timestamptz - interval '45 seconds'
     ORDER BY o.id LIMIT 20`,
    [rails.provider?.name ?? "phone", now],
  );
  for (const o of unanswered.rows) {
    const rail = byName(o.delivery_rail!);
    if (!rail) continue;
    report.checked += 1;
    await settleOrder(db, rail, o.id, await rail.check(o.delivery_request_id!), report, o.network_code, o.bundle_id ? { id: o.bundle_id } : undefined);
  }
  const due = await db.query<Order>(
    `SELECT * FROM orders
     WHERE state = 'paid'
        OR (state = 'delivery_failed' AND delivery_next_attempt_at IS NOT NULL AND delivery_next_attempt_at <= $1::timestamptz AND delivery_attempts < $2)
     ORDER BY created_at LIMIT 10`,
    [now, maxAttempts],
  );
  for (const o of due.rows) {
    const bundle = o.bundle_id ? (await db.query<{ id: number; name: string; network_code: string; provider_variation_code: string | null; code: string }>("SELECT id, name, network_code, provider_variation_code, code FROM data_bundles WHERE id = $1", [o.bundle_id])).rows[0] : undefined;
    const choice = await chooseRail(db, rails, o.network_code, bundle);
    if (!choice.rail) {
      report.skipped.push(`${o.reference}: ${choice.reason}`);
      continue;
    }
    const rail = choice.rail;
    const requestId = newRequestId(now);
    const start = await withActor(ACTOR, (c) => startDelivery(c, ACTOR, o.id, { fundingAccount: fundingFor(rail, o.network_code, bundle), rail: rail.name, requestId }), db);
    if (!start.started) {
      report.skipped.push(`${o.reference}: ${start.reason}`);
      continue;
    }
    report.sent += 1;
    await settleOrder(db, rail, o.id, await rail.send({ requestId, network: start.network, number: start.number, amountKobo: start.amountKobo, bundle: bundle ? { variationCode: bundle.provider_variation_code ?? bundle.code, name: bundle.name } : undefined }), report, o.network_code, bundle);
  }
  return report;
}

async function settleOrder(db: pg.Pool, rail: PayoutRail, orderId: number, result: SendResult, report: CycleReport, network: NetworkCode, bundle?: { id: number } | undefined): Promise<void> {
  switch (result.kind) {
    case "delivered": {
      const done = await withActor(ACTOR, (c) => completeDelivery(c, ACTOR, orderId, result.reference, { account: fundingFor(rail, network, bundle), chargedKobo: result.chargedKobo, commissionKobo: result.commissionKobo }), db);
      if (done) report.delivered += 1;
      return;
    }
    case "retry":
      await withActor(ACTOR, (c) => failDelivery(c, ACTOR, orderId, result.message, { retryable: true }), db);
      report.retried += 1;
      return;
    case "failed":
      await withActor(ACTOR, (c) => failDelivery(c, ACTOR, orderId, result.message, { retryable: false }), db);
      report.failed += 1;
      return;
    case "processing":
    case "unknown":
      await withActor(ACTOR, (c) => c.query("UPDATE orders SET delivery_last_error = $2 WHERE id = $1", [orderId, result.message]), db);
      return;
  }
}
