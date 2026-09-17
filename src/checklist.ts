import type pg from "pg";
import { countAdmins } from "./auth.ts";
import { balance } from "./ledger.ts";
import { formatNaira } from "./money.ts";
import { listMigrations } from "./migrate.ts";
import { getSetting, getSettingValue, NETWORK_CODES, SETTINGS } from "./settings.ts";
import { STALE_AFTER_MINUTES } from "./admin/bridge.ts";

export type Check = {
  status: "ok" | "bad" | "warn";
  title: string;
  detail: string;
  fix?: string;
};

// The launch checklist reads live configuration and live outcomes. Nothing
// here is green because a setting exists; each row says what it found and,
// when red, exactly what to set and where.
export async function runChecklist(db: pg.Pool): Promise<Check[]> {
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
