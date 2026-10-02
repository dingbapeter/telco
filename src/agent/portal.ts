import { randomBytes } from "node:crypto";
import type pg from "pg";
import { agentFromToken, agentLogin, agentLogout, AGENT_SESSION_DAYS, agentPrice, agentTerms, changeAgentPassword, requestWithdrawal, spendable, walletBalance, type Agent, type Withdrawal } from "../agents.ts";
import { createApiKey, listApiKeys, revokeApiKey, MAX_KEYS_PER_AGENT } from "../agentkeys.ts";
import { buildStatement, KIND_WORDS, lagosStamp as when, lagosToday, movementsCsv, purchasesCsv, startOfLagosMonth, statementFileName } from "../agentstatement.ts";
import { batchOrders, buyInBulk, getBatch, MAX_BULK_LINES, newBatchReference, recentBatches } from "../bulkorders.ts";
import { describeBundle, describeSize, listBundles, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { createOrder, type Order } from "../orders.ts";
import { describeMethods, type PaymentGateway } from "../payments/gateway.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { html, notice, type Html } from "../web/html.ts";
import type { App, Request, Response } from "../web/http.ts";
import { cookie } from "../web/http.ts";
import { mask, shell } from "../public/pages.ts";

const NAMES: Record<NetworkCode, string> = { MTN: "MTN", AIRTEL: "Airtel", GLO: "Glo", "9MOBILE": "9mobile" };
export const AGENT_SESSION_COOKIE = "telco_agent_session";

type Session = { agent: Agent; csrfToken: string };

// The agent's pages are public pages with a login: the same light shell,
// built for the same phones.
function portal(title: string, agent: Agent | undefined, body: Html, options: { refreshSeconds?: number } = {}): string {
  const nav = agent
    ? html`<p class="agentnav"><a href="/agent">Wallet</a> · <a href="/agent/buy">Buy for a customer</a> · <a href="/agent/bulk">Buy for many</a> · <a href="/agent/statement">Statement</a> · <a href="/agent/topup">Top up</a> · <a href="/agent/withdraw">Withdraw</a> · <a href="/agent/link">My link</a> · <a href="/agent/keys">Keys</a> · <a href="/agent/password">Password</a></p>`
    : html``;
  return shell(title, html`${nav}${body}`, { ...options, stylesheet: "/static/agent.css" });
}

async function session(req: Request, db: pg.Pool): Promise<Session | undefined> {
  return agentFromToken(db, req.cookies[AGENT_SESSION_COOKIE]);
}

// 200 basis points reads as "2 percent", 250 as "2.5 percent". Always two
// decimals first: without them, stripping trailing zeroes would turn ten
// percent into one.
function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")} percent`;
}

function csrf(s: Session): Html {
  return html`<input type="hidden" name="_csrf" value="${s.csrfToken}">`;
}

function checkCsrf(req: Request, s: Session): void {
  if (req.form.get("_csrf") !== s.csrfToken) throw new UserFacingError("form_expired", "This form was opened before you logged in again. Reload the page and try once more.");
}

export type AgentOptions = { gateway?: PaymentGateway | undefined; publicBaseUrl: string; secureCookies: boolean };

// The reason a payment could not be started is for us, not for the agent:
// it can name the gateway, the address we call and part of their answer.
function payOnlineFailed(gateway: string, err: unknown): string {
  console.error(`${gateway} initialize failed`, err);
  return "Paying online did not start. Try again in a minute, or top up by bank transfer.";
}

export function registerAgentPortal(app: App, options: AgentOptions): void {
  const loginPage = (problem?: string, phone = ""): Response => ({
    kind: "html",
    status: problem ? 401 : 200,
    body: portal("Agent login", undefined, html`<h1>Agent login</h1>${problem ? notice("problem", problem) : ""}
      <form method="post" action="/agent/login" class="panel">
        <div class="field"><label for="phone">Your phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" required value="${phone}"></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required></div>
        <button type="submit">Log in</button></form>
      <p class="muted">No account? Agents are set up by the Telco team. Ask them for one.</p>`),
  });

  // Every agent page needs a session; this wraps a handler with the check
  // and the plain error page.
  const withAgent = (fn: (req: Request, db: pg.Pool, s: Session) => Promise<Response>) => async (req: Request, db: pg.Pool): Promise<Response> => {
    const s = await session(req, db);
    if (!s) return { kind: "redirect", to: "/agent/login" };
    if (!(await getSettingValue(db, "agent.enabled"))) return { kind: "html", status: 403, body: portal("Not open", s.agent, html`${notice("info", "Agent accounts are paused at the moment. Your balance is safe.")}`) };
    try {
      if (req.method === "POST") checkCsrf(req, s);
      return await fn(req, db, s);
    } catch (err) {
      if (err instanceof UserFacingError) return { kind: "html", status: 400, body: portal("Not done", s.agent, html`${notice("problem", err.message)}<p><a href="/agent">Back</a></p>`) };
      throw err;
    }
  };

  app.get("/agent/login", async (req, db) => ((await session(req, db)) ? { kind: "redirect", to: "/agent" } : loginPage()), false);
  app.post(
    "/agent/login",
    async (req, db) => {
      try {
        const { token } = await agentLogin(db, req.form.get("phone") ?? "", req.form.get("password") ?? "", Date.now(), req.ip);
        return { kind: "redirect", to: "/agent", headers: { "set-cookie": cookie(AGENT_SESSION_COOKIE, token, options.secureCookies, AGENT_SESSION_DAYS * 86_400) } };
      } catch (err) {
        if (err instanceof UserFacingError) return loginPage(err.message, req.form.get("phone") ?? "");
        throw err;
      }
    },
    false,
  );
  app.post(
    "/agent/logout",
    async (req, db) => {
      await agentLogout(db, req.cookies[AGENT_SESSION_COOKIE]);
      return { kind: "redirect", to: "/agent/login", headers: { "set-cookie": cookie(AGENT_SESSION_COOKIE, "", options.secureCookies, 0) } };
    },
    false,
  );

  app.get(
    "/agent",
    withAgent(async (_req, db, s) => {
      const room = await spendable(db, s.agent.id);
      const terms = await agentTerms(db, s.agent.id);
      const batches = await recentBatches(db, s.agent.id, 5);
      const month = (await db.query<{ n: number; commission: number }>(
        "SELECT count(*)::int AS n, coalesce(sum(agent_commission_kobo), 0)::bigint AS commission FROM transfers WHERE agent_id = $1 AND state = 'completed' AND paid_out_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'",
        [s.agent.id],
      )).rows[0]!;
      const recent = (await db.query<Order>("SELECT * FROM orders WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10", [s.agent.id])).rows;
      const pending = (await db.query<Withdrawal>("SELECT * FROM agent_withdrawals WHERE agent_id = $1 AND state = 'requested' ORDER BY id", [s.agent.id])).rows;
      return {
        kind: "html",
        body: portal("Your wallet", s.agent, html`<h1>${s.agent.name}</h1>
          <div class="cards"><div class="card"><div class="label">Wallet</div><div class="value">${formatNaira(room.balanceKobo)}</div></div>
            <div class="card"><div class="label">Free to spend</div><div class="value">${formatNaira(room.freeKobo)}</div></div>
            <div class="card"><div class="label">Transfers you brought this month</div><div class="value">${month.n}</div></div>
            <div class="card"><div class="label">Commission this month</div><div class="value">${formatNaira(month.commission)}</div></div></div>
          <p class="muted">You buy at ${percent(terms.discountBasisPoints)} below face value${terms.ownDiscount ? ", the rate agreed with you" : ""}.${terms.creditLimitKobo > 0 ? ` Your credit line is ${formatNaira(terms.creditLimitKobo)}, of which ${formatNaira(room.creditFreeKobo)} is left.` : ""}</p>
          ${room.owedKobo > 0 ? notice("info", `You owe ${formatNaira(room.owedKobo)} on your credit line${room.owingSince ? `, since ${room.owingSince.toISOString().slice(0, 10)}` : ""}. Top up to clear it and it is yours to use again. You have ${terms.creditDays} days from when the wallet went below zero.`) : ""}
          ${room.creditClosed ? notice("problem", room.creditClosed) : ""}
          ${pending.length ? notice("info", `Withdrawal of ${pending.map((w) => formatNaira(w.amount_kobo)).join(", ")} requested and waiting to be paid.`) : ""}
          ${batches.length ? html`<h2>Your last lists</h2>
            <div class="scroll"><table><tr><th>List</th><th class="num">Lines</th><th class="num">Paid</th><th class="num">Delivered</th><th class="num">Needs a look</th></tr>
              ${batches.map((b) => html`<tr><td><a href="/agent/list/${b.reference}">${b.reference}</a></td><td class="num">${b.lines}</td><td class="num">${formatNaira(b.total_kobo)}</td><td class="num">${b.delivered}</td><td class="num">${b.failed}</td></tr>`)}</table></div>` : ""}
          <h2>Your last purchases</h2>
          <div class="scroll"><table><tr><th>Reference</th><th>What</th><th class="num">Paid</th><th>State</th></tr>
            ${recent.map((o) => html`<tr><td><a href="/o/${o.reference}">${o.reference}</a></td><td>${formatNaira(o.face_kobo)} ${NAMES[o.network_code]} to ${mask(o.recipient_number)}</td><td class="num">${formatNaira(o.price_kobo)}</td><td>${o.state.replaceAll("_", " ")}</td></tr>`)}
            ${recent.length === 0 ? html`<tr><td colspan="4" class="muted">Nothing yet.</td></tr>` : ""}</table></div>
          <form method="post" action="/agent/logout">${csrf(s)}<button type="submit" class="secondary">Log out</button></form>`),
      };
    }),
    false,
  );

  const buyForm = async (db: pg.Pool, s: Session, values: Record<string, string>, problem?: Html): Promise<Response> => {
    const terms = await agentTerms(db, s.agent.id);
    const room = await spendable(db, s.agent.id);
    const bundles = await listBundles(db, { activeOnly: true });
    const byNetwork = new Map<string, Bundle[]>();
    for (const b of bundles) byNetwork.set(b.network_code, [...(byNetwork.get(b.network_code) ?? []), b]);
    return {
      kind: "html",
      status: problem ? 400 : 200,
      body: portal("Buy for a customer", s.agent, html`<h1>Buy for a customer</h1>
        <p>Paid from your wallet at ${percent(terms.discountBasisPoints)} below face value. Wallet: ${formatNaira(room.balanceKobo)}, free to spend ${formatNaira(room.freeKobo)}.</p>
        <form method="post" action="/agent/buy" class="panel">${csrf(s)}${problem ?? ""}
          <div class="field"><label for="number">Customer's number</label><input id="number" name="number" type="tel" inputmode="tel" required value="${values["number"] ?? ""}" data-network="network"></div>
          <div class="field"><label for="network">Its network</label><select id="network" name="network" required><option value="">Choose network</option>${NETWORK_CODES.map((c) => html`<option value="${c}" ${c === values["network"] ? "selected" : ""}>${NAMES[c]}</option>`)}</select></div>
          <div class="field"><label for="amount">Airtime amount in naira <span class="muted">(leave empty for a bundle)</span></label><input id="amount" name="amount" type="text" inputmode="numeric" value="${values["amount"] ?? ""}"></div>
          ${bundles.length ? html`<div class="field"><label for="bundle">Or a data bundle</label><select id="bundle" name="bundle"><option value="">No bundle</option>${[...byNetwork.entries()].map(([net, list]) => html`<optgroup label="${NAMES[net as NetworkCode]}">${list.map((b) => html`<option value="${b.id}" ${String(b.id) === values["bundle"] ? "selected" : ""}>${describeBundle(b)}</option>`)}</optgroup>`)}</select></div>` : ""}
          <button type="submit">Buy now from my wallet</button></form>
        <script src="/static/public.js" defer></script>`),
    };
  };
  app.get("/agent/buy", withAgent((_req, db, s) => buyForm(db, s, {})), false);
  app.post(
    "/agent/buy",
    withAgent(async (req, db, s) => {
      const values = { number: req.form.get("number") ?? "", network: req.form.get("network") ?? "", amount: req.form.get("amount") ?? "", bundle: req.form.get("bundle") ?? "" };
      const bundleId = values.bundle ? Number(values.bundle) : undefined;
      const face = bundleId ? undefined : parseNaira(values.amount);
      if (!bundleId && face === undefined) return buyForm(db, s, values, notice("problem", "Enter the amount in naira, or pick a bundle."));
      try {
        const order = await withActor(`agent:${s.agent.code}`, (c) => createOrder(c, `agent:${s.agent.code}`, { network: values.network, recipientNumber: values.number, faceKobo: face, bundleId, agentId: s.agent.id, fromWallet: true }), db);
        return { kind: "redirect", to: `/o/${order.reference}` };
      } catch (err) {
        if (err instanceof UserFacingError) return buyForm(db, s, values, notice("problem", err.message));
        throw err;
      }
    }),
    false,
  );

  const topupPage = async (db: pg.Pool, s: Session, message?: Html): Promise<Response> => {
    const [min, bankName, accountNumber, accountName] = await getSettingValues(db, ["agent.min_topup_kobo", "retail.bank_name", "retail.bank_account_number", "retail.bank_account_name"] as const);
    const bank = bankName && accountNumber && accountName ? { bankName, accountNumber, accountName } : undefined;
    return {
      kind: "html",
      body: portal("Top up your wallet", s.agent, html`<h1>Top up your wallet</h1>${message ?? ""}
        <p>Wallet: ${formatNaira(await walletBalance(db, s.agent.id))}. Smallest top-up ${formatNaira(min)}.</p>
        ${options.gateway ? html`<form method="post" action="/agent/topup" class="panel">${csrf(s)}<div class="field"><label for="amount">Amount in naira</label><input id="amount" name="amount" type="text" inputmode="numeric" required></div><button type="submit">Pay by ${describeMethods(await getSettingValue(db, "retail.payment_methods"))}</button></form>` : ""}
        ${bank ? html`<h2>Or pay by bank transfer</h2><p>Transfer to:</p><dl class="ref"><dt>Bank</dt><dd>${bank.bankName}</dd><dt>Account number</dt><dd><strong>${bank.accountNumber}</strong></dd><dt>Account name</dt><dd>${bank.accountName}</dd><dt>Narration</dt><dd><strong>AGENT ${s.agent.code}</strong></dd></dl><p>Put your agent code in the narration. Bank transfers are added to your wallet by hand during the day.</p>` : ""}
        ${!options.gateway && !bank ? notice("problem", "No way to top up is set up yet. Ask the Telco team.") : ""}`),
    };
  };
  app.get("/agent/topup", withAgent((_req, db, s) => topupPage(db, s)), false);
  app.post(
    "/agent/topup",
    withAgent(async (req, db, s) => {
      const gateway = options.gateway;
      if (!gateway) return topupPage(db, s, notice("problem", "Paying online is not set up. Use the bank transfer details."));
      const amount = parseNaira(req.form.get("amount") ?? "");
      const min = await getSettingValue(db, "agent.min_topup_kobo");
      if (amount === undefined || amount < min) return topupPage(db, s, notice("problem", `Enter an amount of at least ${formatNaira(min)}.`));
      // Random rather than the agent's row number and the time, which
      // would tell anyone holding it who paid and when, and could be
      // guessed.
      const reference = `AT-${randomBytes(6).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      await db.query("INSERT INTO agent_topups (reference, agent_id, amount_kobo) VALUES ($1, $2, $3)", [reference, s.agent.id, amount]);
      try {
        const { url } = await gateway.initialize({
          reference,
          amountKobo: amount,
          email: s.agent.email ?? `agent-${s.agent.phone}@${new URL(options.publicBaseUrl).hostname}`,
          callbackUrl: `${options.publicBaseUrl}/payments/${gateway.name}/callback`,
          methods: await getSettingValue(db, "retail.payment_methods"),
        });
        return { kind: "redirect", to: url };
      } catch (err) {
        return topupPage(db, s, notice("problem", payOnlineFailed(gateway.name, err)));
      }
    }),
    false,
  );

  app.get(
    "/agent/withdraw",
    withAgent(async (_req, db, s) => ({
      kind: "html",
      body: portal("Withdraw", s.agent, html`<h1>Withdraw from your wallet</h1><p>Wallet: ${formatNaira(await walletBalance(db, s.agent.id))}. Paid by bank transfer by the Telco team, usually the same day.</p>
        <form method="post" action="/agent/withdraw" class="panel">${csrf(s)}
          <div class="field"><label for="amount">Amount in naira</label><input id="amount" name="amount" type="text" inputmode="numeric" required></div>
          <div class="field"><label for="bank">Bank, account number and account name</label><input id="bank" name="bank" type="text" required></div>
          <button type="submit">Request withdrawal</button></form>`),
    })),
    false,
  );
  app.post(
    "/agent/withdraw",
    withAgent(async (req, db, s) => {
      const amount = parseNaira(req.form.get("amount") ?? "");
      if (amount === undefined) throw new UserFacingError("bad_amount", "Enter the amount in naira.");
      const w = await withActor(`agent:${s.agent.code}`, (c) => requestWithdrawal(c, s.agent.id, amount, req.form.get("bank") ?? ""), db);
      return { kind: "html", body: portal("Withdraw", s.agent, html`${notice("ok", `Requested ${formatNaira(w.amount_kobo)}. You will see it in your bank once it is paid.`)}<p><a href="/agent">Back to your wallet</a></p>`) };
    }),
    false,
  );

  // Many customers in one go. The reference is made when the form is opened
  // and comes back with it, so a second tap on a slow phone lands on the
  // list that already exists instead of buying everything twice.
  const bulkForm = async (db: pg.Pool, s: Session, reference: string, typed: string, problem?: Html): Promise<Response> => {
    const terms = await agentTerms(db, s.agent.id);
    const room = await spendable(db, s.agent.id);
    const bundles = await listBundles(db, { activeOnly: true });
    return {
      kind: "html",
      status: problem ? 400 : 200,
      body: portal("Buy for many customers", s.agent, html`<h1>Buy for many customers</h1>${problem ?? ""}
        <p>One customer on each line: their number, then the amount in naira, or the size of a data bundle. Up to ${MAX_BULK_LINES} lines at a time, paid from your wallet at ${percent(terms.discountBasisPoints)} below face value. Either every line is bought or none is, so a wallet that runs out part way leaves nothing half done.</p>
        <p>Free to spend: <strong>${formatNaira(room.freeKobo)}</strong>.</p>
        <form method="post" action="/agent/bulk" class="panel">${csrf(s)}
          <input type="hidden" name="reference" value="${reference}">
          <div class="field"><label for="list">Your list</label>
            <textarea id="list" name="list" rows="10" required spellcheck="false" autocapitalize="off">${typed}</textarea></div>
          <p class="muted">Like this:<br><code>08031234567 500</code><br><code>08161234567 1GB</code><br><code>08031234567 airtel 200</code><br>Name the network only when the customer has moved theirs and the number would point at the wrong one. A line starting with # is ignored, so you can keep notes in your list.</p>
          <button type="submit">Buy the whole list from my wallet</button></form>
        ${bundles.length
          ? html`<h2>Bundle sizes you can write</h2>
            <div class="scroll"><table><tr><th>Network</th><th>Write</th><th>Code</th><th class="num">Face value</th></tr>
              ${bundles.map((b) => html`<tr><td>${NAMES[b.network_code]}</td><td>${describeSize(b.size_mb)}</td><td>${b.code}</td><td class="num">${formatNaira(b.price_kobo)}</td></tr>`)}</table></div>`
          : ""}`),
    };
  };
  app.get("/agent/bulk", withAgent((_req, db, s) => bulkForm(db, s, newBatchReference(), "")), false);
  app.post(
    "/agent/bulk",
    withAgent(async (req, db, s) => {
      const reference = req.form.get("reference") ?? "";
      const typed = req.form.get("list") ?? "";
      try {
        const actor = `agent:${s.agent.code}`;
        const result = await withActor(actor, (c) => buyInBulk(c, s.agent, actor, { reference, text: typed }), db);
        return { kind: "redirect", to: `/agent/list/${result.batch.reference}` };
      } catch (err) {
        // The list they typed comes back with the problem, because losing
        // twenty numbers to one bad line would be unforgivable.
        if (err instanceof UserFacingError) return bulkForm(db, s, reference, typed, notice("problem", err.message));
        throw err;
      }
    }),
    false,
  );

  app.get(
    "/agent/list/:reference",
    withAgent(async (req, db, s) => {
      const batch = await getBatch(db, req.query.get("reference") ?? "");
      if (!batch || batch.agent_id !== s.agent.id) return { kind: "html", status: 404, body: portal("No such list", s.agent, html`${notice("problem", "There is no list of yours with that reference.")}<p><a href="/agent/bulk">Buy for many customers</a></p>`) };
      const orders = await batchOrders(db, batch.id);
      const moving = orders.filter((o) => o.state === "paid" || o.state === "delivering" || o.state === "delivery_failed").length;
      const delivered = orders.filter((o) => o.state === "delivered").length;
      return {
        kind: "html",
        body: portal(
          `List ${batch.reference}`,
          s.agent,
          html`<h1>List ${batch.reference}</h1>
            <div class="cards"><div class="card"><div class="label">Customers</div><div class="value">${batch.lines}</div></div>
              <div class="card"><div class="label">Paid from your wallet</div><div class="value">${formatNaira(batch.total_kobo)}</div></div>
              <div class="card"><div class="label">Delivered</div><div class="value">${delivered} of ${orders.length}</div></div></div>
            ${moving > 0 ? notice("info", `${moving} still on the way. This page refreshes itself, so leave it open.`) : ""}
            <div class="scroll"><table><tr><th>Number</th><th>What</th><th class="num">Paid</th><th>State</th><th>Reference</th></tr>
              ${orders.map((o) => html`<tr><td>${o.recipient_number}</td><td>${formatNaira(o.face_kobo)} ${NAMES[o.network_code]}</td><td class="num">${formatNaira(o.price_kobo)}</td><td>${o.state.replaceAll("_", " ")}</td><td><a href="/o/${o.reference}">${o.reference}</a></td></tr>`)}</table></div>
            <p><a href="/agent/bulk">Buy for another list</a></p>`,
          moving > 0 ? { refreshSeconds: 20 } : {},
        ),
      };
    }),
    false,
  );

  // The statement an agent hands their accountant: every movement of the
  // wallet in a period, read straight from the ledger.
  app.get(
    "/agent/statement",
    withAgent(async (req, db, s) => {
      const from = req.query.get("from") ?? startOfLagosMonth();
      const to = req.query.get("to") ?? lagosToday();
      const st = await buildStatement(db, s.agent, { from, to });
      const download = `/agent/statement/download?from=${encodeURIComponent(st.from)}&to=${encodeURIComponent(st.to)}`;
      return {
        kind: "html",
        body: portal("Your statement", s.agent, html`<h1>Your statement</h1>
          <form method="get" action="/agent/statement" class="panel">
            <div class="row"><div class="field"><label for="from">From</label><input id="from" name="from" type="date" value="${st.from}"></div>
              <div class="field"><label for="to">To</label><input id="to" name="to" type="date" value="${st.to}"></div></div>
            <button type="submit">Show</button></form>
          <div class="cards"><div class="card"><div class="label">Opening on ${st.from}</div><div class="value">${formatNaira(st.openingKobo)}</div></div>
            <div class="card"><div class="label">Closing on ${st.to}</div><div class="value">${formatNaira(st.closingKobo)}</div></div>
            <div class="card"><div class="label">Bought, at face value</div><div class="value">${formatNaira(st.purchasedFaceKobo)}</div></div>
            <div class="card"><div class="label">You paid</div><div class="value">${formatNaira(st.purchasedPriceKobo)}</div></div>
            <div class="card"><div class="label">Your margin on it</div><div class="value">${formatNaira(st.savedKobo)}</div></div>
            <div class="card"><div class="label">Commission earned</div><div class="value">${formatNaira(st.totals.commission.kobo)}</div></div></div>
          <p><a href="${download}&what=movements">Download the movements</a> · <a href="${download}&what=purchases">Download the purchases</a>. Both open in any spreadsheet.</p>
          <h2>Movements</h2>
          <div class="scroll"><table><tr><th>When</th><th>What</th><th>Entry</th><th class="num">Change</th><th class="num">Balance</th></tr>
            ${st.lines.map((l) => html`<tr><td>${when(l.at)}</td><td>${KIND_WORDS[l.kind]}</td><td>${l.description}</td><td class="num">${formatNaira(l.changeKobo)}</td><td class="num">${formatNaira(l.balanceKobo)}</td></tr>`)}
            ${st.lines.length === 0 ? html`<tr><td colspan="5" class="muted">Nothing moved in your wallet between those dates.</td></tr>` : ""}</table></div>
          <h2>Purchases</h2>
          <div class="scroll"><table><tr><th>When</th><th>Reference</th><th>Number</th><th>What</th><th class="num">Paid</th><th>State</th></tr>
            ${st.purchases.map((o) => html`<tr><td>${when(o.at)}</td><td><a href="/o/${o.reference}">${o.reference}</a></td><td>${mask(o.recipient_number)}</td><td>${formatNaira(o.face_kobo)} ${NAMES[o.network_code]}</td><td class="num">${formatNaira(o.price_kobo)}</td><td>${o.state.replaceAll("_", " ")}</td></tr>`)}
            ${st.purchases.length === 0 ? html`<tr><td colspan="6" class="muted">You bought nothing between those dates.</td></tr>` : ""}</table></div>`),
      };
    }),
    false,
  );

  app.get(
    "/agent/statement/download",
    withAgent(async (req, db, s) => {
      const what = req.query.get("what") === "purchases" ? "purchases" : "movements";
      const st = await buildStatement(db, s.agent, { from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined });
      return {
        kind: "text",
        body: what === "purchases" ? purchasesCsv(st) : movementsCsv(st),
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="${statementFileName(st, what)}"` },
      };
    }),
    false,
  );

  // Keys for the agent's own till or POS software.
  const keysPage = async (db: pg.Pool, s: Session, message?: Html, status = 200): Promise<Response> => {
    const on = await getSettingValue(db, "agent.api_enabled");
    const keys = await listApiKeys(db, s.agent.id);
    const live = keys.filter((k) => k.active);
    return {
      kind: "html",
      status,
      body: portal("Keys for your own software", s.agent, html`<h1>Keys for your own software</h1>${message ?? ""}
        ${on ? "" : notice("info", "The interface for other software is not open at the moment. You can still make a key here, and it will work the moment we open it.")}
        <p>If your shop runs its own till or POS software, it can buy through our interface instead of this page. Make a key for each machine, keep it on that machine only, and revoke it the day the machine is sold or lost.</p>
        <p>The address is <strong>${options.publicBaseUrl}/api/v1</strong>. Every request carries the key: <code>Authorization: Bearer your-key</code>. Amounts are always in naira.</p>
        <div class="scroll"><table><tr><th>What</th><th>Ask for</th><th>It answers</th></tr>
          <tr><td>Check the key works</td><td>GET /api/v1/ping</td><td>Your name and code</td></tr>
          <tr><td>What you can spend</td><td>GET /api/v1/balance</td><td>Wallet, credit line and free to spend</td></tr>
          <tr><td>What is on offer</td><td>GET /api/v1/catalogue</td><td>Networks, bundle codes and your price</td></tr>
          <tr><td>What it would cost</td><td>POST /api/v1/quote</td><td>Face value, your discount, your price</td></tr>
          <tr><td>Buy for one customer</td><td>POST /api/v1/purchase</td><td>The purchase and its state</td></tr>
          <tr><td>Buy for many at once</td><td>POST /api/v1/purchases</td><td>The list and every purchase in it</td></tr>
          <tr><td>How a purchase went</td><td>GET /api/v1/purchase/your-reference</td><td>Its state, and why if it failed</td></tr>
          <tr><td>Your statement</td><td>GET /api/v1/statement</td><td>Every movement between two dates</td></tr>
        </table></div>
        <p class="muted">Send a <code>client_reference</code> of your own with every purchase. If the network drops and your software asks again with the same one, it gets back the purchase it already made rather than buying twice.</p>
        <h2>Your keys</h2>
        <div class="scroll"><table><tr><th>Name</th><th>Key id</th><th>Made</th><th>Last used</th><th>State</th><th></th></tr>
          ${keys.map((k) => html`<tr><td>${k.label}</td><td><code>${k.key_id}</code></td><td>${when(k.created_at)}</td><td>${k.last_used_at ? when(k.last_used_at) : "never"}</td><td>${k.active ? "in use" : "revoked"}</td>
            <td>${k.active ? html`<form method="post" action="/agent/keys/${k.id}/revoke" class="inline">${csrf(s)}<button type="submit" class="secondary">Revoke</button></form>` : ""}</td></tr>`)}
          ${keys.length === 0 ? html`<tr><td colspan="6" class="muted">No keys yet.</td></tr>` : ""}</table></div>
        ${live.length >= MAX_KEYS_PER_AGENT
          ? notice("info", `You have ${MAX_KEYS_PER_AGENT} keys in use, which is the most allowed. Revoke one you no longer need to make another.`)
          : html`<h2>Make a key</h2>
            <form method="post" action="/agent/keys" class="panel">${csrf(s)}
              <div class="field"><label for="label">What machine is it for</label><input id="label" name="label" type="text" required placeholder="Till at the front counter"></div>
              <button type="submit">Make the key and show it once</button></form>`}`),
    };
  };
  app.get("/agent/keys", withAgent((_req, db, s) => keysPage(db, s)), false);
  app.post(
    "/agent/keys",
    withAgent(async (req, db, s) => {
      const actor = `agent:${s.agent.code}`;
      const { key, token } = await withActor(actor, (c) => createApiKey(c, s.agent.id, req.form.get("label") ?? "", actor), db);
      return keysPage(
        db,
        s,
        notice(
          "ok",
          html`<p>The key for <strong>${key.label}</strong> is below. It is shown this once and we cannot show it again, because we keep only a fingerprint of it. Copy it into that machine now. If you lose it, revoke it here and make another.</p>
            <p class="dial">${token}</p>`,
        ),
      );
    }),
    false,
  );
  app.post(
    "/agent/keys/:id/revoke",
    withAgent(async (req, db, s) => {
      const actor = `agent:${s.agent.code}`;
      const key = await withActor(actor, (c) => revokeApiKey(c, s.agent.id, Number(req.query.get("id"))), db);
      return keysPage(db, s, notice("ok", `The key for ${key.label} is revoked. Anything still using it will be refused from now on.`));
    }),
    false,
  );

  app.get(
    "/agent/link",
    withAgent(async (_req, _db, s) => ({
      kind: "html",
      body: portal("Your link", s.agent, html`<h1>Your link and code</h1>
        <p>Anyone who opens your link and then moves airtime or buys within thirty days counts as yours. You earn a share of our fee on every transfer they make.</p>
        <p class="dial">${options.publicBaseUrl}/a/${s.agent.code}</p>
        <p>Your code, to say aloud: <strong>${s.agent.code}</strong>. They can also type it as ${options.publicBaseUrl}/a/${s.agent.code} on their phone.</p>`),
    })),
    false,
  );

  app.get(
    "/agent/password",
    withAgent(async (_req, _db, s) => ({
      kind: "html",
      body: portal("Password", s.agent, html`<h1>Change your password</h1>
        <form method="post" action="/agent/password" class="panel">${csrf(s)}
          <div class="field"><label for="current">Current password</label><input id="current" name="current" type="password" required></div>
          <div class="field"><label for="next">New password, at least 12 characters</label><input id="next" name="next" type="password" required></div>
          <button type="submit">Change password</button></form>`),
    })),
    false,
  );
  app.post(
    "/agent/password",
    withAgent(async (req, db, s) => {
      await withActor(`agent:${s.agent.code}`, (c) => changeAgentPassword(c, s.agent.id, req.form.get("current") ?? "", req.form.get("next") ?? ""), db);
      return { kind: "redirect", to: "/agent/login", headers: { "set-cookie": cookie(AGENT_SESSION_COOKIE, "", options.secureCookies, 0) } };
    }),
    false,
  );
}

export { agentPrice };
