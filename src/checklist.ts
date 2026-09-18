import type pg from "pg";
import { countAdmins } from "./auth.ts";
import { balance } from "./ledger.ts";
import { formatNaira } from "./money.ts";
import { listMigrations } from "./migrate.ts";
import { getSetting, getSettingValue, getSettingValues, NETWORK_CODES, SETTINGS } from "./settings.ts";
import { STALE_AFTER_MINUTES } from "./admin/bridge.ts";
import { expiringSoon } from "./datalots.ts";
import { paystackFromEnv } from "./payments/paystack.ts";
import { railFromEnv } from "./rails/rail.ts";

export type Check = {
  status: "ok" | "bad" | "warn";
  title: string;
  detail: string;
  fix?: string;
};

// The launch checklist reads live configuration and live outcomes. Nothing
// here is green because a setting exists; each row says what it found and,
// when red, exactly what to set and where.
export async function runChecklist(db: pg.Pool, env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    const applied = (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name);
    const all = await listMigrations();
    const missing = all.filter((m) => !applied.includes(m));
    checks.push(
      missing.length === 0
        ? { status: "ok", title: "Database is up to date", detail: `${applied.length} migrations applied.` }
        : { status: "bad", title: "Database is behind the code", detail: `${missing.length} migration(s) not applied: ${missing.join(", ")}.`, fix: "On the server, run: npm run migrate" },
    );
  } catch (err) {
    checks.push({ status: "bad", title: "Database cannot be read", detail: (err as Error).message, fix: "Check DATABASE_URL in the service's environment file and that Postgres is running." });
    return checks;
  }

  const admins = await countAdmins(db);
  checks.push(
    admins > 0
      ? { status: "ok", title: "An administrator can log in", detail: `${admins} active administrator(s).` }
      : { status: "bad", title: "No administrator", detail: "Nobody can log in to the command centre.", fix: 'On the server, run: node scripts/create-admin.ts you@example.com "Your name"' },
  );

  const numbers = (await db.query<{ network_code: string; n: number }>("SELECT network_code, count(*)::int AS n FROM receiving_numbers WHERE active GROUP BY network_code")).rows;
  for (const c of NETWORK_CODES) {
    const n = numbers.find((r) => r.network_code === c)?.n ?? 0;
    checks.push(
      n > 0
        ? { status: "ok", title: `${c} has a receiving number`, detail: `${n} active number(s) can receive airtime on ${c}.` }
        : { status: "bad", title: `${c} has no receiving number`, detail: `Nobody can send airtime from ${c}.`, fix: "Command centre, Receiving numbers: add the number of our SIM on this network." },
    );
  }

  const phones = (
    await db.query<{ network_code: string; label: string; last_seen_at: Date | null }>(
      "SELECT network_code, label, last_seen_at FROM bridge_devices WHERE active ORDER BY last_seen_at DESC NULLS LAST",
    )
  ).rows;
  for (const c of NETWORK_CODES) {
    const hasNumber = (numbers.find((r) => r.network_code === c)?.n ?? 0) > 0;
    if (!hasNumber) continue;
    const phone = phones.find((p) => p.network_code === c);
    const fresh = phone?.last_seen_at && Date.now() - new Date(phone.last_seen_at).getTime() < STALE_AFTER_MINUTES * 60_000;
    checks.push(
      !phone
        ? { status: "bad", title: `${c} has no phone forwarding its messages`, detail: `Airtime arriving on ${c} will only be seen if someone records it by hand.`, fix: "Command centre, Phone bridge: add a phone for this network and set the app up on it as docs/BRIDGE.md describes." }
        : fresh
          ? { status: "ok", title: `${c} phone is reporting`, detail: `${phone.label} was heard from at ${phone.last_seen_at!.toISOString()}.` }
          : { status: "bad", title: `${c} phone has gone quiet`, detail: phone.last_seen_at ? `${phone.label} was last heard from at ${phone.last_seen_at.toISOString()}.` : `${phone.label} has never reported.`, fix: "Check the phone has power, signal and data, the app is open once, and battery saving is off for it. Until then record airtime by hand under Airtime in." },
    );
  }
  const routes = await getSettingValue(db, "payout.route");
  for (const c of NETWORK_CODES) {
    const hasNumber = (numbers.find((r) => r.network_code === c)?.n ?? 0) > 0;
    if (!hasNumber) continue;
    const sender = (await db.query<{ label: string; can_send: boolean; pin_set: boolean; fresh: boolean }>("SELECT label, can_send, pin_set, last_seen_at > now() - interval '30 minutes' AS fresh FROM bridge_devices WHERE network_code = $1 AND active ORDER BY can_send DESC, last_seen_at DESC NULLS LAST LIMIT 1", [c])).rows[0];
    const ready = sender?.can_send && sender.pin_set && sender.fresh;
    const needed = routes[c] === "phone";
    checks.push(
      ready
        ? { status: "ok", title: `${c} phone can send`, detail: `${sender!.label} can send airtime and gift bundles from its SIM.` }
        : { status: needed ? "bad" : "warn", title: `${c} phone cannot send`, detail: !sender ? "No phone." : !sender.can_send ? `${sender.label} has not been allowed to make calls.` : !sender.pin_set ? `${sender.label} has no transfer PIN entered.` : `${sender.label} has not reported recently.`, fix: `On the phone: tap "Allow sending" and enter the SIM's transfer PIN. ${needed ? `${c} is routed to the phone, so payouts wait until this is fixed.` : "Until then refunds and pool deliveries on this network are done by hand."}` },
    );
  }
  const expiring = await expiringSoon(db, 7);
  checks.push(
    expiring.length === 0
      ? { status: "ok", title: "No gifted data expires this week", detail: "Every lot of data we hold has more than a week left, or there is none." }
      : { status: "warn", title: `${formatNaira(expiring.reduce((s, e) => s + e.value, 0))} of gifted data expires within a week`, detail: expiring.map((e) => `${e.network_code}: ${formatNaira(e.value)} in ${e.lots} lot(s)`).join("; "), fix: "Command centre, Settings, Retail top-up: put a discount on that network's bundles, and route the network's bundle deliveries to the phone so the data goes out before it is lost." },
  );
  const openCommands = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM phone_commands WHERE state = 'unknown'")).rows[0]!.n;
  checks.push(openCommands === 0 ? { status: "ok", title: "No phone command is waiting on a person", detail: "Every dial got a confirmation or a clear failure." } : { status: "bad", title: `${openCommands} phone command(s) got no confirmation`, detail: "Something was dialled and the network did not say what happened.", fix: "Command centre, Phone bridge: read the phone's messages and mark each one as gone through or not." });
  const unparsedMessages = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM bridge_messages WHERE outcome = 'unparsed'")).rows[0]!.n;
  checks.push(
    unparsedMessages === 0
      ? { status: "ok", title: "Every message that looked like airtime was read", detail: "The parser understood all of them." }
      : { status: "warn", title: `${unparsedMessages} message(s) from the phones could not be read`, detail: "They may be airtime arriving that nobody has been paid for.", fix: "Command centre, Phone bridge: read each one, record real ones under Airtime in, and fix the pattern under Settings, Networks." },
  );

  const codes = await getSetting(db, "network.transfer_code");
  for (const c of NETWORK_CODES) {
    const code = codes.value[c];
    const ok = code.includes("{amount}") && code.includes("{number}");
    checks.push(
      ok
        ? { status: "ok", title: `${c} transfer code is set`, detail: `Senders on ${c} will be told to dial ${code}.` }
        : { status: "bad", title: `${c} transfer code is not set`, detail: code === "" ? "Senders cannot be told what to dial." : `"${code}" is missing {amount} or {number}.`, fix: "Command centre, Settings, Networks: enter the network's own transfer code with {amount}, {number} and {pin} in place." },
    );
  }

  const caps = await getSettingValue(db, "network.daily_transfer_cap_kobo");
  for (const c of NETWORK_CODES) {
    checks.push(
      caps[c] > 0
        ? { status: "ok", title: `${c} daily transfer cap is entered`, detail: `Quotes above ${formatNaira(caps[c])} are refused before ${c} refuses them.` }
        : { status: "warn", title: `${c} daily transfer cap is not entered`, detail: "A sender could be told to transfer more than the network allows in a day.", fix: "Command centre, Settings, Networks: enter the cap from the network's current terms." },
    );
  }

  const floors = await getSettingValue(db, "pool.floor_kobo");
  for (const c of NETWORK_CODES) {
    const pool = await balance(db, `pool:${c}`);
    if (floors[c] === 0) {
      checks.push({ status: "warn", title: `${c} pool has no warning level`, detail: `The pool holds ${formatNaira(pool)} and nothing will warn you when it runs low.`, fix: "Command centre, Settings, Pools: set a warning level." });
    } else {
      checks.push(
        pool >= floors[c]
          ? { status: "ok", title: `${c} pool is above its warning level`, detail: `${formatNaira(pool)} held, warning below ${formatNaira(floors[c])}.` }
          : { status: "bad", title: `${c} pool is low`, detail: `${formatNaira(pool)} held, warning below ${formatNaira(floors[c])}. Payouts on ${c} will be held when the pool cannot cover them.`, fix: `Buy airtime onto the ${c} SIM, then record it under Command centre, Pools.` },
      );
    }
  }

  const feeSettings = [];
  for (const k of ["fee.percent_basis_points", "fee.floor_kobo", "fee.ceiling_kobo"] as const) feeSettings.push(await getSetting(db, k));
  const unset = feeSettings.filter((s) => s.source === "fallback");
  checks.push(
    unset.length === 0
      ? { status: "ok", title: "Fees have been set by you", detail: "Percentage, minimum and maximum fee all come from the command centre." }
      : { status: "warn", title: "Fees are still the built-in defaults", detail: `Not yet set: ${unset.map((s) => SETTINGS[s.key].label.toLowerCase()).join(", ")}. The defaults are in force.`, fix: "Command centre, Settings, Fees: confirm each fee, even if you keep the default." },
  );

  const rail = railFromEnv(env);
  const automatic = await getSettingValue(db, "payout.automatic");
  if (!rail) {
    checks.push({ status: "warn", title: "No top-up provider keys", detail: "Every payout is done by hand from the transfer page until the provider is set up.", fix: "Follow docs/PROVIDER.md: open a VTpass account, put VTPASS_API_KEY, VTPASS_SECRET_KEY and VTPASS_PUBLIC_KEY in /etc/telco/telco.env, restart the service." });
  } else {
    const health = await rail.health();
    checks.push(
      health.ok
        ? { status: "ok", title: `${rail.name} answers`, detail: health.message }
        : { status: "bad", title: `${rail.name} is not working`, detail: health.message, fix: "Check the keys in /etc/telco/telco.env and that VTPASS_ENV is set to live on the real server, then restart the service." },
    );
    const ledgerWallet = await balance(db, rail.fundingAccount);
    if (health.balanceKobo !== undefined) {
      const gap = Math.abs(health.balanceKobo - ledgerWallet);
      checks.push(
        gap <= 100
          ? { status: "ok", title: "Provider wallet matches our ledger", detail: `Provider reports ${formatNaira(health.balanceKobo)}; our ledger has ${formatNaira(ledgerWallet)}.` }
          : { status: "warn", title: "Provider wallet and our ledger disagree", detail: `Provider reports ${formatNaira(health.balanceKobo)}; our ledger has ${formatNaira(ledgerWallet)}.`, fix: "Under Pools, record money added to or lost from the provider wallet so the ledger matches what the provider holds." },
      );
    } else {
      checks.push({ status: "warn", title: "Provider wallet balance is only in our ledger", detail: `Our ledger has ${formatNaira(ledgerWallet)} in the provider wallet. The provider did not report its own figure.`, fix: "Compare with the balance shown at vtpass.com now and then, and record any difference under Pools." });
    }
    checks.push(
      automatic
        ? { status: "ok", title: "Automatic payouts are on", detail: "Confirmed transfers are paid through the provider without a person." }
        : { status: "warn", title: "Automatic payouts are off", detail: "The provider is set up but every payout still waits for a person.", fix: "Command centre, Settings, Guardrails: turn automatic payouts on." },
    );
  }

  const [retail, bankName, bankNumber, bankAccount] = await getSettingValues(db, ["retail.enabled", "retail.bank_name", "retail.bank_account_number", "retail.bank_account_name"] as const);
  const paystack = paystackFromEnv(env);
  const bankReady = bankName !== "" && bankNumber !== "" && bankAccount !== "";
  if (retail) {
    if (!paystack && !bankReady) {
      checks.push({ status: "bad", title: "Airtime is for sale but nobody can pay", detail: "Retail is on with neither bank details nor Paystack keys.", fix: "Command centre, Settings, Retail top-up: enter the bank details, or put PAYSTACK_SECRET_KEY in /etc/telco/telco.env and restart, or turn retail off." });
    } else {
      checks.push({ status: "ok", title: "Buyers can pay", detail: [paystack ? "online through Paystack" : "", bankReady ? "by bank transfer" : ""].filter(Boolean).join(" and ") + "." });
    }
  } else {
    checks.push({ status: "warn", title: "Airtime is not for sale", detail: "The Buy airtime page is closed, so an overfull pool cannot be turned back into cash.", fix: "Command centre, Settings, Retail top-up: turn selling on once a way to pay is set up." });
  }
  if (paystack) {
    const h = await paystack.health();
    checks.push(h.ok ? { status: h.message.includes("test keys") ? "warn" : "ok", title: "Paystack answers", detail: h.message, ...(h.message.includes("test keys") ? { fix: "Put the live secret key in /etc/telco/telco.env before selling for real money." } : {}) } : { status: "bad", title: "Paystack is not working", detail: h.message, fix: "Check PAYSTACK_SECRET_KEY in /etc/telco/telco.env and restart the service." });
    const ledgerCash = await balance(db, paystack.cashAccount);
    if (h.balanceKobo !== undefined && Math.abs(h.balanceKobo - ledgerCash) > 100) {
      checks.push({ status: "warn", title: "Paystack balance and our ledger disagree", detail: `Paystack reports ${formatNaira(h.balanceKobo)}; our ledger has ${formatNaira(ledgerCash)}.`, fix: "Paystack settles to the bank on its own schedule. Under Pools, record each settlement as money lost from Paystack and added to the bank." });
    }
  }
  const stuckOrders = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE state IN ('held', 'delivery_failed') OR (state = 'delivering' AND created_at < now() - interval '1 hour')")).rows[0]!.n;
  checks.push(stuckOrders === 0 ? { status: "ok", title: "No order is waiting on a person", detail: "Nothing is held, failed or stuck delivering." } : { status: "bad", title: `${stuckOrders} order(s) waiting on a person`, detail: "Buyers have paid and are waiting.", fix: "Command centre, Orders, Needs a person." });

  const stuck = (
    await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM transfers WHERE state IN ('held', 'awaiting_approval', 'payout_failed') OR (state = 'paying_out' AND created_at < now() - interval '1 hour')",
    )
  ).rows[0]!.n;
  checks.push(
    stuck === 0
      ? { status: "ok", title: "No transfer is waiting on a person", detail: "Nothing is held, failed, awaiting approval or stuck paying out." }
      : { status: "bad", title: `${stuck} transfer(s) waiting on a person`, detail: "Senders are waiting.", fix: "Command centre, Transfers, Needs a person." },
  );

  const unmatched = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM inbound_notifications WHERE matched_transfer_id IS NULL AND received_at > now() - interval '7 days'")).rows[0]!.n;
  checks.push(
    unmatched === 0
      ? { status: "ok", title: "All airtime received this week is matched", detail: "No unmatched notifications in the last seven days." }
      : { status: "warn", title: `${unmatched} unmatched airtime notification(s) this week`, detail: "Someone sent airtime and is not being paid.", fix: "Command centre, Airtime in: match each one to its transfer or contact the sender." },
  );

  return checks;
}
