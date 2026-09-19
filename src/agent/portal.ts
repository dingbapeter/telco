import type pg from "pg";
import { agentFromToken, agentLogin, agentLogout, AGENT_SESSION_DAYS, agentPrice, changeAgentPassword, requestWithdrawal, walletBalance, type Agent, type Withdrawal } from "../agents.ts";
import { describeBundle, listBundles, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { createOrder, type Order } from "../orders.ts";
import type { PaystackProvider } from "../payments/paystack.ts";
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
function portal(title: string, agent: Agent | undefined, body: Html): string {
  const nav = agent
    ? html`<p class="agentnav"><a href="/agent">Wallet</a> · <a href="/agent/buy">Buy for a customer</a> · <a href="/agent/topup">Top up</a> · <a href="/agent/withdraw">Withdraw</a> · <a href="/agent/link">My link</a> · <a href="/agent/password">Password</a></p>`
    : html``;
  return shell(title, html`${nav}${body}`);
}

async function session(req: Request, db: pg.Pool): Promise<Session | undefined> {
  return agentFromToken(db, req.cookies[AGENT_SESSION_COOKIE]);
}

function csrf(s: Session): Html {
  return html`<input type="hidden" name="_csrf" value="${s.csrfToken}">`;
}

function checkCsrf(req: Request, s: Session): void {
  if (req.form.get("_csrf") !== s.csrfToken) throw new UserFacingError("form_expired", "This form was opened before you logged in again. Reload the page and try once more.");
}

export type AgentOptions = { paystack?: PaystackProvider | undefined; publicBaseUrl: string; secureCookies: boolean };

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
        const { token } = await agentLogin(db, req.form.get("phone") ?? "", req.form.get("password") ?? "");
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
      const have = await walletBalance(db, s.agent.id);
      const month = (await db.query<{ n: number; commission: number }>(
        "SELECT count(*)::int AS n, coalesce(sum(agent_commission_kobo), 0)::bigint AS commission FROM transfers WHERE agent_id = $1 AND state = 'completed' AND paid_out_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'",
        [s.agent.id],
      )).rows[0]!;
      const recent = (await db.query<Order>("SELECT * FROM orders WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10", [s.agent.id])).rows;
      const pending = (await db.query<Withdrawal>("SELECT * FROM agent_withdrawals WHERE agent_id = $1 AND state = 'requested' ORDER BY id", [s.agent.id])).rows;
      return {
        kind: "html",
        body: portal("Your wallet", s.agent, html`<h1>${s.agent.name}</h1>
          <div class="cards"><div class="card"><div class="label">Wallet</div><div class="value">${formatNaira(have)}</div></div>
            <div class="card"><div class="label">Transfers you brought this month</div><div class="value">${month.n}</div></div>
            <div class="card"><div class="label">Commission this month</div><div class="value">${formatNaira(month.commission)}</div></div></div>
          ${pending.length ? notice("info", `Withdrawal of ${pending.map((w) => formatNaira(w.amount_kobo)).join(", ")} requested and waiting to be paid.`) : ""}
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
    const [bp] = await getSettingValues(db, ["agent.discount_basis_points"] as const);
    const bundles = await listBundles(db, { activeOnly: true });
    const byNetwork = new Map<string, Bundle[]>();
    for (const b of bundles) byNetwork.set(b.network_code, [...(byNetwork.get(b.network_code) ?? []), b]);
    return {
      kind: "html",
      status: problem ? 400 : 200,
      body: portal("Buy for a customer", s.agent, html`<h1>Buy for a customer</h1>
        <p>Paid from your wallet at ${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)} percent below face value. Wallet: ${formatNaira(await walletBalance(db, s.agent.id))}.</p>
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
        ${options.paystack ? html`<form method="post" action="/agent/topup" class="panel">${csrf(s)}<div class="field"><label for="amount">Amount in naira</label><input id="amount" name="amount" type="text" inputmode="numeric" required></div><button type="submit">Pay by card, bank or USSD</button></form>` : ""}
        ${bank ? html`<h2>Or pay by bank transfer</h2><p>Transfer to:</p><dl class="ref"><dt>Bank</dt><dd>${bank.bankName}</dd><dt>Account number</dt><dd><strong>${bank.accountNumber}</strong></dd><dt>Account name</dt><dd>${bank.accountName}</dd><dt>Narration</dt><dd><strong>AGENT ${s.agent.code}</strong></dd></dl><p>Put your agent code in the narration. Bank transfers are added to your wallet by hand during the day.</p>` : ""}
        ${!options.paystack && !bank ? notice("problem", "No way to top up is set up yet. Ask the Telco team.") : ""}`),
    };
  };
  app.get("/agent/topup", withAgent((_req, db, s) => topupPage(db, s)), false);
  app.post(
    "/agent/topup",
    withAgent(async (req, db, s) => {
      if (!options.paystack) return topupPage(db, s, notice("problem", "Paying online is not set up. Use the bank transfer details."));
      const amount = parseNaira(req.form.get("amount") ?? "");
      const min = await getSettingValue(db, "agent.min_topup_kobo");
      if (amount === undefined || amount < min) return topupPage(db, s, notice("problem", `Enter an amount of at least ${formatNaira(min)}.`));
      const reference = `AT-${s.agent.id}-${Date.now().toString(36).toUpperCase()}`;
      await db.query("INSERT INTO agent_topups (reference, agent_id, amount_kobo) VALUES ($1, $2, $3)", [reference, s.agent.id, amount]);
      try {
        const { url } = await options.paystack.initialize({ reference, amountKobo: amount, email: s.agent.email ?? `agent-${s.agent.phone}@${new URL(options.publicBaseUrl).hostname}`, callbackUrl: `${options.publicBaseUrl}/payments/paystack/callback` });
        return { kind: "redirect", to: url };
      } catch (err) {
        return topupPage(db, s, notice("problem", `Paying online did not start: ${(err as Error).message}. Try again in a minute, or pay by bank transfer.`));
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
