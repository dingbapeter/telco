import type pg from "pg";
import { withActor } from "./db.ts";
import type { PayoutRail, SendResult } from "./rails/rail.ts";
import { newRequestId } from "./rails/vtpass.ts";
import { getSettingValues } from "./settings.ts";
import { completeDelivery, failDelivery, startDelivery, type Order } from "./orders.ts";
import { completePayout, failPayout, getTransfer, startPayout, type Transfer } from "./transfers.ts";

export type CycleReport = { checked: number; sent: number; delivered: number; retried: number; failed: number; skipped: string[] };

const ACTOR = "worker:payouts";

// One pass of automatic payouts. Runs every few seconds. Every step is a
// conditional state change, so two workers or a restart in the middle can
// never pay twice: a payout whose answer never came is checked with the
// provider by its request id before anything is sent again.
export async function runPayoutCycle(db: pg.Pool, rail: PayoutRail, now = new Date()): Promise<CycleReport> {
  const report: CycleReport = { checked: 0, sent: 0, delivered: 0, retried: 0, failed: 0, skipped: [] };
  const [automatic, maxAttempts] = await getSettingValues(db, ["payout.automatic", "payout.max_attempts"] as const);
  if (!automatic) {
    report.skipped.push("automatic payouts are off");
    return report;
  }

  // First, anything we sent and never heard back about.
  const unanswered = await db.query<Transfer>(
    `SELECT t.* FROM transfers t
     WHERE t.state = 'paying_out' AND t.payout_rail = $1 AND t.payout_request_id IS NOT NULL
       AND (SELECT max(at) FROM transfer_events e WHERE e.transfer_id = t.id) < $2::timestamptz - interval '45 seconds'
     ORDER BY t.id LIMIT 20`,
    [rail.name, now],
  );
  for (const t of unanswered.rows) {
    report.checked += 1;
    const result = await rail.check(t.payout_request_id!);
    await settle(db, rail, t.id, result, report);
  }

  // Then transfers waiting to be paid, including failed ones whose wait is over.
  const due = await db.query<Transfer>(
    `SELECT * FROM transfers
     WHERE (state = 'inbound_confirmed')
        OR (state = 'payout_failed' AND payout_next_attempt_at IS NOT NULL AND payout_next_attempt_at <= $1::timestamptz AND payout_attempts < $2)
     ORDER BY created_at LIMIT 10`,
    [now, maxAttempts],
  );
  for (const t of due.rows) {
    const requestId = newRequestId(now);
    const start = await withActor(ACTOR, (c) => startPayout(c, ACTOR, t.id, { fundingAccount: rail.fundingAccount, rail: rail.name, requestId }), db);
    if (!start.started) {
      report.skipped.push(`${t.reference}: ${start.reason}`);
      continue;
    }
    const bundle = start.instruction.bundle;
    if (bundle && !bundle.provider_variation_code) {
      // The provider does not know this bundle; a person delivers it from our SIM.
      await withActor(ACTOR, (c) => failPayout(c, ACTOR, t.id, `${bundle.name} has no provider code in the catalogue, so it must be delivered by hand from our ${bundle.network_code} SIM, or given a code under Data bundles.`, { retryable: false }), db);
      report.failed += 1;
      continue;
    }
    report.sent += 1;
    const result = await rail.send({ requestId, network: start.instruction.network, number: start.instruction.number, amountKobo: start.instruction.amountKobo, bundle: bundle ? { variationCode: bundle.provider_variation_code!, name: bundle.name } : undefined });
    await settle(db, rail, t.id, result, report);
  }
  return report;
}

async function settle(db: pg.Pool, rail: PayoutRail, transferId: number, result: SendResult, report: CycleReport): Promise<void> {
  switch (result.kind) {
    case "delivered": {
      const done = await withActor(ACTOR, (c) => completePayout(c, ACTOR, transferId, result.reference, { account: rail.fundingAccount, chargedKobo: result.chargedKobo, commissionKobo: result.commissionKobo }), db);
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
export async function runDeliveryCycle(db: pg.Pool, rail: PayoutRail, now = new Date()): Promise<CycleReport> {
  const report: CycleReport = { checked: 0, sent: 0, delivered: 0, retried: 0, failed: 0, skipped: [] };
  const [automatic, maxAttempts] = await getSettingValues(db, ["payout.automatic", "payout.max_attempts"] as const);
  if (!automatic) {
    report.skipped.push("automatic payouts are off");
    return report;
  }
  const unanswered = await db.query<Order>(
    `SELECT o.* FROM orders o
     WHERE o.state = 'delivering' AND o.delivery_rail = $1 AND o.delivery_request_id IS NOT NULL
       AND (SELECT max(at) FROM order_events e WHERE e.order_id = o.id) < $2::timestamptz - interval '45 seconds'
     ORDER BY o.id LIMIT 20`,
    [rail.name, now],
  );
  for (const o of unanswered.rows) {
    report.checked += 1;
    await settleOrder(db, rail, o.id, await rail.check(o.delivery_request_id!), report);
  }
  const due = await db.query<Order>(
    `SELECT * FROM orders
     WHERE state = 'paid'
        OR (state = 'delivery_failed' AND delivery_next_attempt_at IS NOT NULL AND delivery_next_attempt_at <= $1::timestamptz AND delivery_attempts < $2)
     ORDER BY created_at LIMIT 10`,
    [now, maxAttempts],
  );
  for (const o of due.rows) {
    const requestId = newRequestId(now);
    const start = await withActor(ACTOR, (c) => startDelivery(c, ACTOR, o.id, { fundingAccount: rail.fundingAccount, rail: rail.name, requestId }), db);
    if (!start.started) {
      report.skipped.push(`${o.reference}: ${start.reason}`);
      continue;
    }
    const bundle = start.bundle;
    if (bundle && !bundle.provider_variation_code) {
      await withActor(ACTOR, (c) => failDelivery(c, ACTOR, o.id, `${bundle.name} has no provider code in the catalogue, so it must be delivered by hand from our ${bundle.network_code} SIM, or given a code under Data bundles.`, { retryable: false }), db);
      report.failed += 1;
      continue;
    }
    report.sent += 1;
    await settleOrder(db, rail, o.id, await rail.send({ requestId, network: start.network, number: start.number, amountKobo: start.amountKobo, bundle: bundle ? { variationCode: bundle.provider_variation_code!, name: bundle.name } : undefined }), report);
  }
  return report;
}

async function settleOrder(db: pg.Pool, rail: PayoutRail, orderId: number, result: SendResult, report: CycleReport): Promise<void> {
  switch (result.kind) {
    case "delivered": {
      const done = await withActor(ACTOR, (c) => completeDelivery(c, ACTOR, orderId, result.reference, { account: rail.fundingAccount, chargedKobo: result.chargedKobo, commissionKobo: result.commissionKobo }), db);
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
