// Breaks the code on purpose, one way at a time, and checks that the suite
// turns red. A mutation that leaves the suite green is reported, not fixed:
// the method says investigate first, because it may be a second defence.
// Run with: node scripts/mutation-check.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type Mutation = { name: string; file: string; find: string; replace: string; suite: string };

const MUTATIONS: Mutation[] = [
  { name: "fee floor removed", file: "src/fees.ts", find: "if (fee < rule.floorKobo) fee = rule.floorKobo;", replace: "", suite: "tests/fees.test.ts" },
  { name: "fee ceiling removed", file: "src/fees.ts", find: "if (fee > rule.ceilingKobo) fee = rule.ceilingKobo;", replace: "", suite: "tests/fees.test.ts" },
  { name: "network share rounds to nearest instead of down", file: "src/fees.ts", find: "Math.floor((fee * rule.networkShareBasisPoints) / 10_000)", replace: "Math.round((fee * rule.networkShareBasisPoints) / 10_000)", suite: "tests/fees.test.ts" },
  { name: "fee allowed to swallow the amount", file: "src/fees.ts", find: "if (fee >= amountKobo) {", replace: "if (fee > amountKobo * 2) {", suite: "tests/fees.test.ts" },
  { name: "basis points truncate instead of rounding half up", file: "src/money.ts", find: "Math.floor((kobo * basisPoints + 5000) / 10000)", replace: "Math.floor((kobo * basisPoints) / 10000)", suite: "tests/money.test.ts" },
  { name: "setting written without validation", file: "src/settings.ts", find: "  if (!r.ok) {\n    throw new UserFacingError(\"setting_out_of_range\"", replace: "  if (false) {\n    throw new UserFacingError(\"setting_out_of_range\"", suite: "tests/settings.test.ts" },
  { name: "invalid stored setting used instead of fallback", file: "src/settings.ts", find: "return { key, value: spec.fallback, source: \"fallback\", problem: `stored value ${r.reason}` };", replace: "return { key, value: row.value as SettingValue<K>, source: \"database\", problem: `stored value ${r.reason}` };", suite: "tests/settings.test.ts" },
  { name: "application balance check removed", file: "src/ledger.ts", find: "  assertBalanced(input.postings);\n  const inserted", replace: "  const inserted", suite: "tests/ledger.test.ts" },
  { name: "journal idempotency removed", file: "src/ledger.ts", find: "VALUES ($1, $2, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id", replace: "VALUES ($1, $2, $3 || '-' || clock_timestamp()::text) RETURNING id", suite: "tests/ledger.test.ts" },
  { name: "database balance trigger removed", file: "migrations/0001_foundation.sql", find: "  IF total <> 0 THEN\n    RAISE EXCEPTION 'journal % does not balance", replace: "  IF false THEN\n    RAISE EXCEPTION 'journal % does not balance", suite: "tests/ledger.test.ts" },
  { name: "postings made editable", file: "migrations/0001_foundation.sql", find: "    BEFORE UPDATE OR DELETE ON ledger_postings\n    FOR EACH ROW EXECUTE FUNCTION forbid_change();", replace: "    BEFORE UPDATE OR DELETE ON ledger_postings\n    FOR EACH ROW WHEN (false) EXECUTE FUNCTION forbid_change();", suite: "tests/ledger.test.ts" },
  { name: "audit hook dropped from settings", file: "migrations/0001_foundation.sql", find: "  CREATE TRIGGER settings_audit AFTER INSERT OR UPDATE OR DELETE ON settings\n    FOR EACH ROW EXECUTE FUNCTION audit_row_change('key');", replace: "  CREATE TRIGGER settings_audit AFTER INSERT OR UPDATE OR DELETE ON settings\n    FOR EACH ROW WHEN (false) EXECUTE FUNCTION audit_row_change('key');", suite: "tests/settings.test.ts" },
  { name: "audit actor ignored", file: "migrations/0001_foundation.sql", find: "actor  text := coalesce(nullif(current_setting('app.actor', true), ''), 'system');", replace: "actor  text := 'system';", suite: "tests/settings.test.ts" },
  { name: "state claim no longer conditional", file: "src/transfers.ts", find: "WHERE id = $1 AND state = ANY($3::text[]) RETURNING *", replace: "WHERE id = $1 AND ($3::text[]) IS NOT NULL RETURNING *", suite: "tests/transfers.test.ts" },
  { name: "duplicate notification processed again", file: "src/transfers.ts", find: "ON CONFLICT (dedupe_hash) DO NOTHING RETURNING id`,\n    [network, receiving, sender, amount, n.rawText, n.source, n.occurredAt ?? null, actor, hash],", replace: "ON CONFLICT (dedupe_hash) DO UPDATE SET recorded_by = EXCLUDED.recorded_by RETURNING id`,\n    [network, receiving, sender, amount, n.rawText, n.source, n.occurredAt ?? null, actor, hash],", suite: "tests/transfers.test.ts" },
  { name: "pool balance check removed", file: "src/transfers.ts", find: "  if (pool < payout) {", replace: "  if (pool < payout && false) {", suite: "tests/transfers.test.ts" },
  { name: "approval threshold ignored", file: "src/transfers.ts", find: "if (payout > autoMax && !t.approved_by) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "daily payout ceiling ignored", file: "src/transfers.ts", find: "if (paidToday.rows[0]!.total + payout > ceiling) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "sender daily limit ignored", file: "src/transfers.ts", find: "if (usedToday + amount > dailyMax) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "expired quotes count against the daily limit", file: "src/transfers.ts", find: "WHERE sender_number = $1 AND created_at >= ${START_OF_TODAY} AND state NOT IN ('expired', 'refunded')`,", replace: "WHERE sender_number = $1 AND created_at >= ${START_OF_TODAY}`,", suite: "tests/transfers.test.ts" },
  { name: "late airtime in the grace period not matched", file: "src/transfers.ts", find: "AND state IN ('awaiting_inbound', 'expired')\n       AND expires_at + make_interval(mins => $5) > now()", replace: "AND state IN ('awaiting_inbound')\n       AND expires_at + make_interval(mins => $5) > now()", suite: "tests/transfers.test.ts" },
  { name: "grace period never ends", file: "src/transfers.ts", find: "AND expires_at + make_interval(mins => $5) > now()", replace: "AND ($5::int IS NOT NULL)", suite: "tests/transfers.test.ts" },
  { name: "fee not recomputed on the amount that arrived", file: "src/transfers.ts", find: "fee = computeFee(amount, await loadFeeRule(db, candidate.from_network, candidate.to_network));", replace: "fee = computeFee(candidate.requested_kobo, await loadFeeRule(db, candidate.from_network, candidate.to_network));", suite: "tests/transfers.test.ts" },
  { name: "network share never booked", file: "src/transfers.ts", find: "if (moved.network_share_kobo! > 0) postings.push", replace: "if (false) postings.push", suite: "tests/transfers.test.ts" },
  { name: "refund books to the wrong pool", file: "src/transfers.ts", find: "{ account: `pool:${moved.from_network}`, amountKobo: -moved.received_kobo! },", replace: "{ account: `pool:${moved.to_network}`, amountKobo: -moved.received_kobo! },", suite: "tests/transfers.test.ts" },
  { name: "held transfer below minimum can be released", file: "src/transfers.ts", find: "  if (t.payout_kobo === null) {\n    throw new UserFacingError(\n      \"held_amount_outside_limits\",", replace: "  if (false) {\n    throw new UserFacingError(\n      \"held_amount_outside_limits\",", suite: "tests/transfers.test.ts" },
  { name: "full receiving number still chosen", file: "src/transfers.ts", find: "WHERE r.network_code = $1 AND r.active AND (r.daily_cap_kobo = 0 OR u.used + $2 <= r.daily_cap_kobo)", replace: "WHERE r.network_code = $1 AND r.active AND ($2::bigint IS NOT NULL)", suite: "tests/transfers.test.ts" },
  { name: "network daily cap ignored", file: "src/transfers.ts", find: "if (networkCap > 0 && amount > networkCap) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "migration runner records nothing", file: "src/migrate.ts", find: "await db.query(\"INSERT INTO schema_migrations (name) VALUES ($1)\", [name]);", replace: "", suite: "tests/migrations.test.ts" },
  { name: "login wall removed", file: "src/web/http.ts", find: "if (route.auth && !request.admin) {", replace: "if (false) {", suite: "tests/admin.test.ts" },
  { name: "form token not checked", file: "src/web/http.ts", find: "if (route.auth && request.method === \"POST\" && form.get(\"_csrf\") !== request.csrfToken) {", replace: "if (false) {", suite: "tests/admin.test.ts" },
  { name: "wrong password accepted", file: "src/auth.ts", find: "const ok = admin !== undefined && admin.active && (await verifyPassword(password, admin.password_hash));", replace: "const ok = admin !== undefined && admin.active;", suite: "tests/admin.test.ts" },
  { name: "logout keeps the session", file: "src/auth.ts", find: "if (token) await db.query(\"DELETE FROM admin_sessions WHERE token_hash = $1\", [hashToken(token)]);", replace: "", suite: "tests/admin.test.ts" },
  { name: "page values not escaped", file: "src/web/html.ts", find: "  return escape(value);\n}", replace: "  return String(value);\n}", suite: "tests/admin.test.ts" },
  { name: "pool form double submit books twice", file: "src/admin/pools.ts", find: "idempotencyKey: `admin:${kind}:${key}`,", replace: "idempotencyKey: `admin:${kind}:${key}:${Date.now()}`,", suite: "tests/admin.test.ts" },
  { name: "checklist green without a receiving number", file: "src/checklist.ts", find: "      n > 0\n        ? { status: \"ok\", title: `${c} has a receiving number`", replace: "      true\n        ? { status: \"ok\", title: `${c} has a receiving number`", suite: "tests/admin.test.ts" },
  { name: "phone token not checked", file: "src/bridge.ts", find: "WHERE token_hash = $1 AND active\",\n    [hashToken(token)],", replace: "WHERE active\",\n    [],", suite: "tests/bridge.test.ts" },
  { name: "phone message dedupe removed", file: "src/bridge.ts", find: "VALUES ($1, $2, $3, $4, $5, 'ignored') ON CONFLICT (dedupe_hash) DO NOTHING RETURNING id`,", replace: "VALUES ($1, $2, $3, $4, $5 || clock_timestamp()::text, 'ignored') RETURNING id`,", suite: "tests/bridge.test.ts" },
  { name: "custom pattern ignored", file: "src/bridge.ts", find: "const parsed = parseNetworkMessage(msg.body, patterns[device.network_code]);", replace: "const parsed = parseNetworkMessage(msg.body, \"\");", suite: "tests/bridge.test.ts" },
  { name: "unreadable airtime message dropped silently", file: "src/bridge.ts", find: "return finish(looksLikeAirtime ? \"unparsed\" : \"ignored\", null, parsed.problem);", replace: "return finish(\"ignored\", null, parsed.problem);", suite: "tests/bridge.test.ts" },
  { name: "phone heartbeat not recorded", file: "src/web/bridge.ts", find: "await withActor(`bridge:${device.label}`, (c) => heartbeat(c, device.id, status), db);", replace: "", suite: "tests/bridge.test.ts" },
  { name: "phone token stored in clear", file: "src/bridge.ts", find: "[label.trim(), code, hashToken(token)],", replace: "[label.trim(), code, token],", suite: "tests/bridge.test.ts" },
  { name: "sender numbers shown in full on the status page", file: "src/public/pages.ts", find: "return `${number.slice(0, 4)} *** ${number.slice(-4)}`;", replace: "return number;", suite: "tests/public.test.ts" },
  { name: "quote flood not slowed", file: "src/public/pages.ts", find: "if (tooManyQuotes(`n:${sender}`) || tooManyQuotes(`ip:${req.ip}`)) {", replace: "if (false) {", suite: "tests/public.test.ts" },
  { name: "bot form accepted", file: "src/public/pages.ts", find: "if ((req.form.get(\"website\") ?? \"\") !== \"\") return homePage", replace: "if (false) return homePage", suite: "tests/public.test.ts" },
  { name: "expired quote still tells the sender to send", file: "src/public/pages.ts", find: "${t.state === \"expired\" || expired", replace: "${false", suite: "tests/public.test.ts" },
  { name: "dial code shows the placeholder instead of the amount", file: "src/public/pages.ts", find: "const dial = code ? code.replace(\"{amount}\", amountNaira).replace(\"{number}\", t.receiving_number) : \"\";", replace: "const dial = code ? code.replace(\"{number}\", t.receiving_number) : \"\";", suite: "tests/public.test.ts" },
  { name: "network suggestion from the prefix broken", file: "src/public/pages.ts", find: "WHERE prefix = $1\", [prefixOf(local)]", replace: "WHERE prefix = $1\", [local]", suite: "tests/public.test.ts" },
  { name: "phone numbers with a country code rejected", file: "src/phone.ts", find: "if (digits.length === 13 && digits.startsWith(\"234\")) local = \"0\" + digits.slice(3);", replace: "if (false) local = digits;", suite: "tests/phone.test.ts" },
];

const only = process.argv[2];
const results: { name: string; suite: string; outcome: "red" | "GREEN" | "did not apply" }[] = [];

for (const m of MUTATIONS) {
  if (only && !m.name.includes(only)) continue;
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.find)) {
    results.push({ name: m.name, suite: m.suite, outcome: "did not apply" });
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace));
  try {
    const run = spawnSync("scripts/test.sh", [m.suite], { encoding: "utf8", env: process.env });
    const output = run.stdout + run.stderr;
    const failed = /ℹ fail (\d+)/.exec(output);
    const red = run.status !== 0 || (failed !== null && Number(failed[1]) > 0);
    results.push({ name: m.name, suite: m.suite, outcome: red ? "red" : "GREEN" });
    process.stdout.write(`${red ? "red  " : "GREEN"}  ${m.name}\n`);
  } finally {
    writeFileSync(m.file, original);
  }
}
for (const m of MUTATIONS) {
  // Every file must be back exactly as it was, whatever else happened.
  const now = readFileSync(m.file, "utf8");
  if (!now.includes(m.find)) throw new Error(`${m.file} was not restored after "${m.name}"`);
}

const survivors = results.filter((r) => r.outcome !== "red");
console.log(`\n${results.length} mutations, ${results.length - survivors.length} caught.`);
if (survivors.length > 0) {
  console.log("Not caught (investigate before changing anything):");
  for (const s of survivors) console.log(`  ${s.outcome}: ${s.name} (${s.suite})`);
  process.exit(1);
}
