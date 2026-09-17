// Breaks the code on purpose, one way at a time, and checks that the suite
// turns red. A mutation that leaves the suite green is reported, not fixed:
// the method says investigate first, because it may be a second defence.
// Run with: node scripts/mutation-check.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type Mutation = { name: string; file: string; find: string; replace: string; suite: string; also?: { find: string; replace: string }[] };

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
  { name: "pool balance check removed", file: "src/transfers.ts", find: "  if (available < payout) {", replace: "  if (available < payout && false) {", suite: "tests/transfers.test.ts" },
  { name: "approval threshold ignored", file: "src/transfers.ts", find: "if (payout > autoMax && !t.approved_by) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "daily payout ceiling ignored", file: "src/transfers.ts", find: "if (paidToday.rows[0]!.total + payout > ceiling) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "sender daily limit ignored", file: "src/transfers.ts", find: "if (usedToday + amount > dailyMax) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
  { name: "expired quotes count against the daily limit", file: "src/transfers.ts", find: "WHERE sender_number = $1 AND created_at >= ${START_OF_TODAY} AND state NOT IN ('expired', 'refunded')`,", replace: "WHERE sender_number = $1 AND created_at >= ${START_OF_TODAY}`,", suite: "tests/transfers.test.ts" },
  { name: "late airtime in the grace period not matched", file: "src/transfers.ts", find: "AND state IN ('awaiting_inbound', 'expired')\n       AND expires_at + make_interval(mins => $5) > now()", replace: "AND state IN ('awaiting_inbound')\n       AND expires_at + make_interval(mins => $5) > now()", suite: "tests/transfers.test.ts" },
  { name: "grace period never ends", file: "src/transfers.ts", find: "AND expires_at + make_interval(mins => $5) > now()", replace: "AND ($5::int IS NOT NULL)", suite: "tests/transfers.test.ts" },
  { name: "fee not recomputed on the amount that arrived", file: "src/transfers.ts", find: "return { fee: computeFee(amount, await loadFeeRule(db, t.from_network, t.to_network)), holdReason: null };", replace: "return { fee: computeFee(t.requested_kobo, await loadFeeRule(db, t.from_network, t.to_network)), holdReason: null };", suite: "tests/transfers.test.ts" },
  { name: "network share never booked", file: "src/transfers.ts", find: "if (moved.network_share_kobo! > 0) postings.push", replace: "if (false) postings.push", suite: "tests/transfers.test.ts" },
  { name: "refund books to the wrong pool", file: "src/transfers.ts", find: "{ account: inboundAccount(moved), amountKobo: -moved.received_kobo! },", replace: "{ account: `pool:${moved.to_network}`, amountKobo: -moved.received_kobo! },", suite: "tests/transfers.test.ts" },
  { name: "held transfer below minimum can be released", file: "src/transfers.ts", find: "  if (t.payout_kobo === null) {\n    throw new UserFacingError(\n      \"held_amount_outside_limits\",", replace: "  if (false) {\n    throw new UserFacingError(\n      \"held_amount_outside_limits\",", suite: "tests/transfers.test.ts" },
  { name: "full receiving number still chosen", file: "src/transfers.ts", find: "WHERE r.network_code = $1 AND r.active AND (r.daily_cap_kobo = 0 OR u.used + $2 <= r.daily_cap_kobo)", replace: "WHERE r.network_code = $1 AND r.active AND ($2::bigint IS NOT NULL)", suite: "tests/transfers.test.ts" },
  { name: "network daily cap ignored", file: "src/transfers.ts", find: "if (!inBundle && networkCap > 0 && amount > networkCap) {", replace: "if (false) {", suite: "tests/transfers.test.ts" },
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
  { name: "custom pattern ignored", file: "src/bridge.ts", find: ": parseNetworkMessage(msg.body, patterns[device.network_code]);", replace: ": parseNetworkMessage(msg.body, \"\");", suite: "tests/bridge.test.ts" },
  { name: "unreadable airtime message dropped silently", file: "src/bridge.ts", find: "return finish(looksLikeValue ? \"unparsed\" : \"ignored\", null, `${parsed.problem} ${data.problem}`);", replace: "return finish(\"ignored\", null, `${parsed.problem} ${data.problem}`);", suite: "tests/bridge.test.ts" },
  { name: "phone heartbeat not recorded", file: "src/web/bridge.ts", find: "await withActor(`bridge:${device.label}`, (c) => heartbeat(c, device.id, status), db);", replace: "", suite: "tests/bridge.test.ts" },
  { name: "phone token stored in clear", file: "src/bridge.ts", find: "[label.trim(), code, hashToken(token)],", replace: "[label.trim(), code, token],", suite: "tests/bridge.test.ts" },
  { name: "sender numbers shown in full on the status page", file: "src/public/pages.ts", find: "return `${number.slice(0, 4)} *** ${number.slice(-4)}`;", replace: "return number;", suite: "tests/public.test.ts" },
  { name: "quote flood not slowed", file: "src/public/pages.ts", find: "if (tooManyQuotes(`n:${sender}`) || tooManyQuotes(`ip:${req.ip}`)) {", replace: "if (false) {", suite: "tests/public.test.ts" },
  { name: "bot form accepted", file: "src/public/pages.ts", find: "if ((req.form.get(\"website\") ?? \"\") !== \"\") return homePage", replace: "if (false) return homePage", suite: "tests/public.test.ts" },
  { name: "expired quote still tells the sender to send", file: "src/public/pages.ts", find: "${t.state === \"expired\" || expired", replace: "${false", suite: "tests/public.test.ts" },
  { name: "dial code shows the placeholder instead of the amount", file: "src/public/pages.ts", find: "code.replace(\"{amount}\", amountNaira).replace(\"{number}\", t.receiving_number)", replace: "code.replace(\"{number}\", t.receiving_number)", suite: "tests/public.test.ts" },
  { name: "network suggestion from the prefix broken", file: "src/public/pages.ts", find: "WHERE prefix = $1\", [prefixOf(local)]", replace: "WHERE prefix = $1\", [local]", suite: "tests/public.test.ts" },
  { name: "automatic payouts run while switched off", file: "src/worker.ts", find: "  if (!automatic) {", replace: "  if (false) {", suite: "tests/rails.test.ts" },
  { name: "attempt limit ignored", file: "src/worker.ts", find: "AND payout_attempts < $2)", replace: "AND $2 IS NOT NULL)", suite: "tests/rails.test.ts" },
  { name: "unanswered payout sent again instead of checked", file: "src/worker.ts", find: "    const result = await rail.check(t.payout_request_id!);", replace: "    const result = await rail.send({ requestId: t.payout_request_id!, network: t.to_network, number: t.recipient_number, amountKobo: t.payout_kobo! });", suite: "tests/rails.test.ts" },
  { name: "provider commission not booked", file: "src/transfers.ts", find: "    if (via.commissionKobo > 0) postings.push({ account: \"revenue:provider_commission\", amountKobo: -via.commissionKobo });", replace: "    postings.push({ account: via.account, amountKobo: -via.commissionKobo });", suite: "tests/rails.test.ts" },
  { name: "provider figures not checked", file: "src/transfers.ts", find: "    if (via.chargedKobo + via.commissionKobo !== moved.payout_kobo!) {", replace: "    if (false) {", suite: "tests/rails.test.ts" },
  { name: "final failure retried anyway", file: "src/transfers.ts", find: "const nextAttempt = options.retryable ? new Date(Date.now() + wait * 60_000) : null;", replace: "const nextAttempt = new Date(Date.now() + wait * 60_000);", suite: "tests/rails.test.ts" },
  { name: "low wallet read as final failure", file: "src/rails/vtpass.ts", find: "if (code === \"018\") return { kind: \"retry\"", replace: "if (code === \"018\") return { kind: \"failed\"", suite: "tests/rails.test.ts" },
  { name: "request id without the Lagos timestamp", file: "src/rails/vtpass.ts", find: "return `${parts[\"year\"]}${parts[\"month\"]}${parts[\"day\"]}${parts[\"hour\"]}${parts[\"minute\"]}${randomBytes(6).toString(\"hex\")}`;", replace: "return randomBytes(12).toString(\"hex\");", suite: "tests/rails.test.ts" },
  { name: "wrong service id for 9mobile", file: "src/rails/vtpass.ts", find: "\"9MOBILE\": \"etisalat\"", replace: "\"9MOBILE\": \"9mobile\"", suite: "tests/rails.test.ts" },
  { name: "wallet balance not checked before sending", file: "src/transfers.ts", find: "  if (available < payout) {", replace: "  if (false) {", suite: "tests/rails.test.ts" },
  { name: "webhook signature not checked", file: "src/public/buy.ts", find: "if (!options.paystack.verifySignature(req.rawBody, req.raw.headers[\"x-paystack-signature\"] as string | undefined)) {", replace: "if (false) {", suite: "tests/retail.test.ts" },
  { name: "webhook processed again on repeat", file: "src/public/buy.ts", find: "VALUES ('paystack', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING id", replace: "VALUES ('paystack', $1, $2 || clock_timestamp()::text, $3::jsonb) RETURNING id", suite: "tests/retail.test.ts" },
  { name: "return from Paystack trusted without verifying", file: "src/public/buy.ts", find: "if (v.status === \"success\") {", replace: "if (true) {", suite: "tests/retail.test.ts" },
  { name: "underpayment accepted as paid", file: "src/orders.ts", find: "const short = p.paidKobo < current.price_kobo;", replace: "const short = false;", suite: "tests/retail.test.ts" },
  { name: "discount not taken off the price", file: "src/orders.ts", find: "return { faceKobo, discountKobo, priceKobo: faceKobo - discountKobo };", replace: "return { faceKobo, discountKobo, priceKobo: faceKobo };", suite: "tests/retail.test.ts" },
  { name: "sale booked while selling is off", file: "src/orders.ts", find: "if (!enabled) throw new UserFacingError(\"retail_off\"", replace: "if (false) throw new UserFacingError(\"retail_off\"", suite: "tests/retail.test.ts" },
  { name: "settlement payment above what is owed accepted", file: "src/admin/settlement.ts", find: "if (amount > owed) throw new UserFacingError(\"overpaid\"", replace: "if (false) throw new UserFacingError(\"overpaid\"", suite: "tests/retail.test.ts" },
  { name: "payment fee not booked", file: "src/orders.ts", find: "if (p.feeKobo > 0) postings.push({ account: \"expense:payment_fees\", amountKobo: p.feeKobo });", replace: "postings[0]!.amountKobo = p.paidKobo;", suite: "tests/retail.test.ts" },
  { name: "buyer numbers shown in full on the order page", file: "src/public/buy.ts", find: "<p>For ${mask(o.recipient_number)}.", replace: "<p>For ${o.recipient_number}.", suite: "tests/retail.test.ts" },
  { name: "bundle transfer accepts a different amount", file: "src/transfers.ts", find: "if (amount !== t.requested_kobo) return { fee: null, holdReason: amount < t.requested_kobo ? \"amount_below_required\" : \"amount_above_required\" };", replace: "", suite: "tests/data.test.ts" },
  { name: "required amount one naira short", file: "src/fees.ts", find: "      if (computeFee(amount - 100, rule).payoutKobo < priceKobo) break;", replace: "      if (computeFee(amount - 200, rule).payoutKobo < priceKobo) break;", suite: "tests/data.test.ts" },
  { name: "gifted data booked in the airtime pool", file: "src/transfers.ts", find: "return t.in_kind === \"data\" ? `datapool:${t.from_network}` : `pool:${t.from_network}`;", replace: "return `pool:${t.from_network}`;", suite: "tests/data.test.ts" },
  { name: "airtime matched to a transfer waiting for data", file: "src/transfers.ts", find: "WHERE from_network = $1 AND receiving_number = $2 AND sender_number = $3 AND in_kind = 'airtime'", replace: "WHERE from_network = $1 AND receiving_number = $2 AND sender_number = $3", suite: "tests/data.test.ts" },
  { name: "bundle sent to the provider as airtime", file: "src/rails/vtpass.ts", find: "const serviceID = input.bundle ? `${VTPASS_SERVICE_IDS[input.network]}-data` : VTPASS_SERVICE_IDS[input.network];", replace: "const serviceID = VTPASS_SERVICE_IDS[input.network];", suite: "tests/data.test.ts" },
  { name: "bundle without provider code sent anyway", file: "src/worker.ts", find: "    if (bundle && !bundle.provider_variation_code) {\n      // The provider does not know this bundle; a person delivers it from our SIM.", replace: "    if (false) {\n      // The provider does not know this bundle; a person delivers it from our SIM.", suite: "tests/data.test.ts" },
  { name: "data message read as one naira of airtime (both defences off)", file: "src/bridge.ts", find: "const mentionsData = /\\d\\s*[GM]B/i.test(msg.body);", replace: "const mentionsData = false;", also: [{ find: "(?!\\s*[GM]B)", replace: "" }], suite: "tests/data.test.ts" },
  { name: "hand-set bundle price overwritten by a fetch", file: "src/bundles.ts", find: "price_kobo = CASE WHEN data_bundles.source = 'manual' AND EXCLUDED.source = 'vtpass' THEN data_bundles.price_kobo ELSE EXCLUDED.price_kobo END,", replace: "price_kobo = EXCLUDED.price_kobo,", suite: "tests/data.test.ts" },
  { name: "bundle not giftable offered as the thing sent", file: "src/transfers.ts", find: "if (inBundle && !inBundle.giftable) throw new UserFacingError(\"not_giftable\"", replace: "if (false) throw new UserFacingError(\"not_giftable\"", suite: "tests/data.test.ts" },
  { name: "phone numbers with a country code rejected", file: "src/phone.ts", find: "if (digits.length === 13 && digits.startsWith(\"234\")) local = \"0\" + digits.slice(3);", replace: "if (false) local = digits;", suite: "tests/phone.test.ts" },
];

const only = process.argv[2];
const results: { name: string; suite: string; outcome: "red" | "GREEN" | "did not apply" }[] = [];

for (const m of MUTATIONS) {
  if (only && !m.name.includes(only)) continue;
  const original = readFileSync(m.file, "utf8");
  const edits = [{ find: m.find, replace: m.replace }, ...(m.also ?? [])];
  if (edits.some((e) => !original.includes(e.find))) {
    results.push({ name: m.name, suite: m.suite, outcome: "did not apply" });
    continue;
  }
  writeFileSync(m.file, edits.reduce((text, e) => text.replace(e.find, e.replace), original));
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
  // Every file must be back exactly as it was, whatever else happened. A
  // mutation that did not apply is reported below, not here.
  const applied = results.find((r) => r.name === m.name)?.outcome !== "did not apply";
  if (applied && !readFileSync(m.file, "utf8").includes(m.find)) throw new Error(`${m.file} was not restored after "${m.name}"`);
}

const survivors = results.filter((r) => r.outcome !== "red");
console.log(`\n${results.length} mutations, ${results.length - survivors.length} caught.`);
if (survivors.length > 0) {
  console.log("Not caught (investigate before changing anything):");
  for (const s of survivors) console.log(`  ${s.outcome}: ${s.name} (${s.suite})`);
  process.exit(1);
}
