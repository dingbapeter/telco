import type pg from "pg";
import { agentTerms, spendable, type Agent } from "../agents.ts";
import { agentFromApiKey, type ApiKey } from "../agentkeys.ts";
import { buildStatement, KIND_WORDS, type StatementKind } from "../agentstatement.ts";
import { batchReferenceFor, buyInBulk, MAX_BULK_LINES } from "../bulkorders.ts";
import { describeSize, listBundles } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { normaliseNigerianNumber } from "../phone.ts";
import { createOrder, getOrderByReference, priceFor, type Order } from "../orders.ts";
import { networkForNumber } from "../public/pages.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { rateCheck } from "../throttle.ts";
import type { App, Request, Response } from "../web/http.ts";

// The interface an agent's own till, POS device or shop software talks to.
// Server to server, with a key the agent makes in their portal. Every
// amount in and out is naira, never kobo, because a till that muddles the
// two would sell a customer five naira of airtime instead of five hundred.

type Caller = { agent: Agent; key: ApiKey };

function bearer(req: Request): string | undefined {
  const h = req.raw.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

const fail = (status: number, code: string, message: string): Response => ({ kind: "json", status, body: { ok: false, error: { code, message } } });

function money(kobo: number): { kobo: number; naira: string; shown: string } {
  return { kobo, naira: (kobo / 100).toFixed(2), shown: formatNaira(kobo) };
}

// Amounts arrive as a field called amount, in naira. A field named in kobo
// is refused rather than guessed at.
function amountFrom(req: Request, field = "amount"): number | undefined {
  if (req.form.has(`${field}_kobo`)) throw new UserFacingError("amount_in_naira", `This interface takes amounts in naira, in a field called ${field}. Send 500 for five hundred naira.`);
  const raw = req.form.get(field);
  if (raw === null || raw.trim() === "") return undefined;
  const kobo = parseNaira(raw);
  if (kobo === undefined) throw new UserFacingError("bad_amount", `${field} should be an amount in naira, like 500.`);
  return kobo;
}

async function resolve(db: pg.Pool | pg.PoolClient, numberText: string, networkText: string | null): Promise<{ number: string; network: NetworkCode }> {
  const number = normaliseNigerianNumber(numberText);
  if (!number) throw new UserFacingError("bad_number", "number should be a Nigerian mobile number like 08031234567.");
  if (networkText) {
    const network = networkText.trim().toUpperCase();
    if (!(NETWORK_CODES as readonly string[]).includes(network)) throw new UserFacingError("unknown_network", `network should be one of ${NETWORK_CODES.join(", ")}.`);
    return { number, network: network as NetworkCode };
  }
  const guess = await networkForNumber(db, number);
  if (!guess) throw new UserFacingError("unknown_network", `We do not know which network ${number} is on. Send the network with the request, one of ${NETWORK_CODES.join(", ")}.`);
  return { number, network: guess };
}

function orderBody(order: Order, bundleName?: string | undefined): Record<string, unknown> {
  return {
    reference: order.reference,
    client_reference: order.client_reference,
    state: order.state,
    network: order.network_code,
    number: order.recipient_number,
    bundle: bundleName ?? null,
    face_value: money(order.face_kobo),
    discount: money(order.discount_kobo),
    paid: money(order.price_kobo),
    delivered_at: order.delivered_at,
    failure: order.delivery_last_error,
    hold_reason: order.hold_reason,
    created_at: order.created_at,
  };
}

export function registerAgentApi(app: App): void {
  // Every route behind a key, the switch, the agent's own state and the
  // rate for that key.
  const withKey = (fn: (req: Request, db: pg.Pool, caller: Caller) => Promise<Response>) => async (req: Request, db: pg.Pool): Promise<Response> => {
    const [apiOn, agentsOn, perMinute] = await getSettingValues(db, ["agent.api_enabled", "agent.enabled", "agent.api_rate_per_minute"] as const);
    if (!apiOn) return fail(503, "api_off", "The agent interface is not open at the moment. Your keys still exist and the portal pages still work.");
    const caller = await agentFromApiKey(db, bearer(req));
    if (!caller) return fail(401, "bad_key", "That key is not recognised. Check the Authorization header reads Bearer followed by the key, and that the key has not been revoked in your portal.");
    if (!agentsOn) return fail(403, "agents_off", "Agent accounts are paused at the moment. Your balance is safe.");
    const verdict = rateCheck(`api:${caller.key.key_id}`, perMinute);
    if (!verdict.ok) return { kind: "json", status: 429, body: { ok: false, error: { code: "too_many_requests", message: `This key has made more requests this minute than the ${perMinute} allowed. Wait ${verdict.waitSeconds} seconds and send it again.`, wait_seconds: verdict.waitSeconds } } };
    try {
      return await fn(req, db, caller);
    } catch (err) {
      if (err instanceof UserFacingError) return fail(400, err.code, err.message);
      throw err;
    }
  };

  app.get("/api/v1/ping", withKey(async (_req, _db, caller) => ({ kind: "json", body: { ok: true, agent: { code: caller.agent.code, name: caller.agent.name }, key: caller.key.key_id } })), false);

  app.get(
    "/api/v1/balance",
    withKey(async (_req, db, caller) => {
      const room = await spendable(db, caller.agent.id);
      const terms = await agentTerms(db, caller.agent.id);
      return {
        kind: "json",
        body: {
          ok: true,
          wallet: money(room.balanceKobo),
          withdrawals_requested: money(room.pendingKobo),
          credit_line: money(room.creditLimitKobo),
          owed: money(room.owedKobo),
          credit_left: money(room.creditFreeKobo),
          free_to_spend: money(room.freeKobo),
          credit_closed: room.creditClosed,
          discount_percent: terms.discountBasisPoints / 100,
        },
      };
    }),
    false,
  );

  app.get(
    "/api/v1/catalogue",
    withKey(async (_req, db, caller) => {
      const terms = await agentTerms(db, caller.agent.id);
      const [min, max, retailOn] = await getSettingValues(db, ["retail.min_kobo", "retail.max_kobo", "retail.enabled"] as const);
      const bundles = await listBundles(db, { activeOnly: true });
      return {
        kind: "json",
        body: {
          ok: true,
          selling: retailOn,
          networks: NETWORK_CODES,
          airtime: { smallest: money(min), largest: money(max), whole_naira_only: true, discount_percent: terms.discountBasisPoints / 100 },
          bundles: bundles.map((b) => ({
            network: b.network_code,
            code: b.code,
            name: b.name,
            size: describeSize(b.size_mb),
            validity_days: b.validity_days,
            face_value: money(b.price_kobo),
            you_pay: money(b.price_kobo - Math.round((b.price_kobo * terms.discountBasisPoints) / 10_000)),
          })),
        },
      };
    }),
    false,
  );

  // What a purchase would cost, without buying it.
  app.post(
    "/api/v1/quote",
    withKey(async (req, db, caller) => {
      const { number, network } = await resolve(db, req.form.get("number") ?? "", req.form.get("network"));
      const bundleCode = req.form.get("bundle");
      const amount = amountFrom(req);
      if (bundleCode && amount !== undefined) throw new UserFacingError("one_or_the_other", "Send either an amount of airtime or a bundle code, not both.");
      const terms = await agentTerms(db, caller.agent.id);
      let faceKobo: number;
      let bundleName: string | null = null;
      if (bundleCode) {
        const bundle = (await listBundles(db, { network, activeOnly: true })).find((b) => b.code.toUpperCase() === bundleCode.trim().toUpperCase());
        if (!bundle) throw new UserFacingError("no_such_bundle", `${network} has no bundle with the code ${bundleCode}. The codes are in /api/v1/catalogue.`);
        faceKobo = bundle.price_kobo;
        bundleName = bundle.name;
      } else if (amount !== undefined) {
        faceKobo = amount;
      } else throw new UserFacingError("nothing_asked", "Send an amount of airtime in naira, or a bundle code.");
      const quote = priceFor(faceKobo, terms.discountBasisPoints);
      const room = await spendable(db, caller.agent.id);
      return {
        kind: "json",
        body: {
          ok: true,
          number,
          network,
          bundle: bundleName,
          face_value: money(quote.faceKobo),
          discount: money(quote.discountKobo),
          you_pay: money(quote.priceKobo),
          free_to_spend: money(room.freeKobo),
          affordable: room.freeKobo >= quote.priceKobo,
        },
      };
    }),
    false,
  );

  // Buy for one customer. The client's own reference makes it safe to send
  // again after a timeout: the same reference always gives the same order.
  app.post(
    "/api/v1/purchase",
    withKey(async (req, db, caller) => {
      const clientReference = (req.form.get("client_reference") ?? "").trim();
      if (!clientReference) throw new UserFacingError("missing_client_reference", "Send a client_reference of your own with every purchase, so asking again after a timeout cannot buy twice.");
      if (clientReference.length > 60) throw new UserFacingError("long_client_reference", "Keep client_reference under sixty characters.");
      const already = (await db.query<Order>("SELECT * FROM orders WHERE agent_id = $1 AND client_reference = $2", [caller.agent.id, clientReference])).rows[0];
      if (already) return { kind: "json", body: { ok: true, repeated: true, purchase: orderBody(already) } };
      const { number, network } = await resolve(db, req.form.get("number") ?? "", req.form.get("network"));
      const bundleCode = req.form.get("bundle");
      const amount = amountFrom(req);
      if (bundleCode && amount !== undefined) throw new UserFacingError("one_or_the_other", "Send either an amount of airtime or a bundle code, not both.");
      if (!bundleCode && amount === undefined) throw new UserFacingError("nothing_asked", "Send an amount of airtime in naira, or a bundle code.");
      let bundleId: number | undefined;
      let bundleName: string | undefined;
      if (bundleCode) {
        const bundle = (await listBundles(db, { network, activeOnly: true })).find((b) => b.code.toUpperCase() === bundleCode.trim().toUpperCase());
        if (!bundle) throw new UserFacingError("no_such_bundle", `${network} has no bundle with the code ${bundleCode}. The codes are in /api/v1/catalogue.`);
        bundleId = bundle.id;
        bundleName = bundle.name;
      }
      const actor = `agent-api:${caller.agent.code}:${caller.key.key_id}`;
      try {
        const order = await withActor(actor, (c) => createOrder(c, actor, { network, recipientNumber: number, faceKobo: bundleId ? undefined : amount, bundleId, agentId: caller.agent.id, fromWallet: true, clientReference }), db);
        return { kind: "json", status: 201, body: { ok: true, repeated: false, purchase: orderBody(order, bundleName) } };
      } catch (err) {
        // Two requests with the same reference at the same moment: the one
        // that lost the race answers with the order the winner made.
        if (err instanceof UserFacingError && err.code === "duplicate_client_reference") {
          const raced = (await db.query<Order>("SELECT * FROM orders WHERE agent_id = $1 AND client_reference = $2", [caller.agent.id, clientReference])).rows[0];
          if (raced) return { kind: "json", body: { ok: true, repeated: true, purchase: orderBody(raced) } };
        }
        throw err;
      }
    }),
    false,
  );

  app.get(
    "/api/v1/purchase/:reference",
    withKey(async (req, db, caller) => {
      const reference = req.query.get("reference") ?? "";
      // Either our reference or the caller's own.
      const order = (await getOrderByReference(db, reference)) ?? (await db.query<Order>("SELECT * FROM orders WHERE agent_id = $1 AND client_reference = $2", [caller.agent.id, reference])).rows[0];
      if (!order || order.agent_id !== caller.agent.id) return fail(404, "no_such_purchase", "There is no purchase of yours with that reference.");
      const bundle = order.bundle_id ? (await db.query<{ name: string }>("SELECT name FROM data_bundles WHERE id = $1", [order.bundle_id])).rows[0]?.name : undefined;
      return { kind: "json", body: { ok: true, purchase: orderBody(order, bundle) } };
    }),
    false,
  );

  // Many customers in one request. All of them or none, the same rule the
  // portal's page follows.
  app.post(
    "/api/v1/purchases",
    withKey(async (req, db, caller) => {
      const clientReference = (req.form.get("client_reference") ?? "").trim();
      if (!clientReference) throw new UserFacingError("missing_client_reference", "Send a client_reference of your own with every list, so asking again after a timeout cannot buy twice.");
      if (clientReference.length > 60) throw new UserFacingError("long_client_reference", "Keep client_reference under sixty characters.");
      let lines: unknown;
      try {
        lines = JSON.parse(req.form.get("lines") ?? "null");
      } catch {
        throw new UserFacingError("bad_lines", "lines should be a list, like [{\"number\": \"08031234567\", \"amount\": 500}].");
      }
      if (!Array.isArray(lines) || lines.length === 0) throw new UserFacingError("bad_lines", "lines should be a list with at least one customer in it.");
      if (lines.length > MAX_BULK_LINES) throw new UserFacingError("bulk_too_long", `That is ${lines.length} customers and ${MAX_BULK_LINES} is the most in one request.`);
      // The lines are turned into the same text the portal's page takes, so
      // there is one set of rules for both and they cannot drift apart.
      const text = lines
        .map((line, i) => {
          if (typeof line !== "object" || line === null) throw new UserFacingError("bad_lines", `Line ${i + 1} should be an object with a number and either an amount or a bundle.`);
          const l = line as Record<string, unknown>;
          const number = String(l["number"] ?? "").trim();
          if (!number) throw new UserFacingError("bad_lines", `Line ${i + 1} has no number.`);
          if (l["amount_kobo"] !== undefined) throw new UserFacingError("amount_in_naira", `Line ${i + 1}: this interface takes amounts in naira, in a field called amount. Send 500 for five hundred naira.`);
          const network = l["network"] === undefined ? "" : String(l["network"]).trim();
          const what = l["amount"] !== undefined ? String(l["amount"]).trim() : String(l["bundle"] ?? "").trim();
          if (!what) throw new UserFacingError("bad_lines", `Line ${i + 1} says a number but not what to buy. Send an amount in naira, or a bundle code.`);
          return [number, network, what].filter(Boolean).join(" ");
        })
        .join("\n");
      const actor = `agent-api:${caller.agent.code}:${caller.key.key_id}`;
      const result = await withActor(actor, (c) => buyInBulk(c, caller.agent, actor, { reference: batchReferenceFor(caller.agent.id, clientReference), text }), db);
      return {
        kind: "json",
        status: result.created ? 201 : 200,
        body: {
          ok: true,
          repeated: !result.created,
          batch: { reference: result.batch.reference, client_reference: clientReference, lines: result.batch.lines, total: money(result.batch.total_kobo), created_at: result.batch.created_at },
          purchases: result.orders.map((o) => orderBody(o)),
        },
      };
    }),
    false,
  );

  app.get(
    "/api/v1/statement",
    withKey(async (req, db, caller) => {
      const s = await buildStatement(db, caller.agent, { from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined });
      return {
        kind: "json",
        body: {
          ok: true,
          from: s.from,
          to: s.to,
          opening: money(s.openingKobo),
          closing: money(s.closingKobo),
          bought_face_value: money(s.purchasedFaceKobo),
          bought_for: money(s.purchasedPriceKobo),
          saved: money(s.savedKobo),
          totals: Object.fromEntries((Object.keys(KIND_WORDS) as StatementKind[]).map((k) => [k, { count: s.totals[k].count, ...money(s.totals[k].kobo) }])),
          movements: s.lines.map((l) => ({ at: l.at, kind: l.kind, entry: l.description, reference: l.reference, change: money(l.changeKobo), balance: money(l.balanceKobo) })),
        },
      };
    }),
    false,
  );
}
