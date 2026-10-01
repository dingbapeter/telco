import type pg from "pg";
import { formatNaira } from "../money.ts";
import { balanceSheet, profitAndLoss, type Day, type Line, type ProfitAndLoss } from "../report.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request, Response } from "../web/http.ts";
import { money, when } from "./shared.ts";

// What a founder running a float business has to be able to answer: how
// much of this money is mine, and did this week make any. Both are read
// from the ledger when the page is opened.

const rows = (lines: Line[], empty: string): Html =>
  lines.length === 0
    ? html`<tr><td colspan="2" class="muted">${empty}</td></tr>`
    : html`${lines.map((l) => html`<tr><td>${l.name}</td><td class="num">${money(l.kobo)}</td></tr>`)}`;

// A chart drawn as plain shapes on the server: no script to download, and
// no written style, which the security policy refuses anyway. Bars are
// coloured by a class in the stylesheet.
function bars(days: Day[]): Html {
  if (days.length === 0) return html`<p class="muted">Nothing moved between those dates.</p>`;
  const most = Math.max(...days.map((d) => Math.abs(d.profitKobo)), 1);
  // A fixed width per day, kept in shape rather than stretched to fill the
  // page: one day on its own should look like one day, not a green wall.
  const w = 6;
  const gap = 1;
  const width = Math.max(days.length * w, 36);
  return html`<svg class="bars" viewBox="0 0 ${width} 60" width="100%" height="140" preserveAspectRatio="xMinYMid meet" role="img"
      aria-label="Profit for each day from ${days[0]!.day} to ${days[days.length - 1]!.day}">
    <line x1="0" y1="30" x2="${width}" y2="30" class="axis"></line>
    ${days.map((d, i) => {
      const h = Math.max(1, Math.round((Math.abs(d.profitKobo) / most) * 28));
      const up = d.profitKobo >= 0;
      return html`<rect x="${i * w}" y="${up ? 30 - h : 30}" width="${w - gap}" height="${h}" class="${up ? "up" : "down"}">
        <title>${d.day}: ${formatNaira(d.profitKobo)}</title></rect>`;
    })}
  </svg>`;
}

function csv(p: ProfitAndLoss): string {
  const cell = (v: string | number): string => {
    const text = String(v);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const amount = (kobo: number): string => (kobo / 100).toFixed(2);
  const out: (string | number)[][] = [["Telco money report", `${p.from} to ${p.to}`]];
  out.push([], ["Earned", "Naira"]);
  for (const l of p.earned) out.push([l.name, amount(l.kobo)]);
  out.push(["Earned in all", amount(p.earnedKobo)]);
  out.push([], ["Spent", "Naira"]);
  for (const l of p.spent) out.push([l.name, amount(l.kobo)]);
  out.push(["Spent in all", amount(p.spentKobo)]);
  out.push([], ["Profit", amount(p.profitKobo)]);
  out.push(["Held for the networks", amount(p.networkShareKobo)]);
  out.push([], ["Day", "Earned", "Spent", "Profit"]);
  for (const d of p.days) out.push([d.day, amount(d.earnedKobo), amount(d.spentKobo), amount(d.profitKobo)]);
  return out.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

async function moneyPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<Response> {
  const sheet = await balanceSheet(db);
  const p = await profitAndLoss(db, { from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined });
  const v = p.volumes;
  const body = html`<h1>Money</h1>${message ?? ""}
    <p class="muted">Every figure on this page is read from the ledger when the page is opened. The ledger cannot be edited, so this and the books can never disagree.</p>
    <h2>What is ours right now</h2>
    <div class="cards">
      <div class="card"><div class="label">What we hold</div><div class="value">${money(sheet.heldKobo)}</div><span class="muted">airtime, data, cash</span></div>
      <div class="card"><div class="label">What we owe</div><div class="value">${money(sheet.owedKobo)}</div><span class="muted">senders, buyers, sellers, agents, networks</span></div>
      <div class="card ${sheet.ownKobo >= sheet.putInKobo ? "ok" : "bad"}"><div class="label">What is ours</div><div class="value">${money(sheet.ownKobo)}</div>
        <span class="muted">${money(sheet.putInKobo)} put in, ${money(sheet.earnedKobo)} earned since</span></div>
    </div>
    ${sheet.addsUp
      ? ""
      : notice("problem", `The books do not add up: what we hold less what we owe is ${formatNaira(sheet.ownKobo)}, and what was put in plus what was earned is ${formatNaira(sheet.putInKobo + sheet.earnedKobo)}. Nothing should be able to do this. Send the founder this page.`)}
    <div class="pair">
      <div><h3>What we hold</h3><div class="scroll"><table><tr><th>Where</th><th class="num">How much</th></tr>
        ${rows(sheet.held, "Nothing yet.")}
        <tr><th>In all</th><th class="num">${money(sheet.heldKobo)}</th></tr></table></div></div>
      <div><h3>What we owe</h3><div class="scroll"><table><tr><th>To whom</th><th class="num">How much</th></tr>
        ${rows(sheet.owed, "Nobody.")}
        <tr><th>In all</th><th class="num">${money(sheet.owedKobo)}</th></tr></table></div></div>
    </div>

    <h2>What it earned</h2>
    <form method="get" action="/admin/money" class="panel">
      <div class="row"><div><label for="from">From</label><input id="from" name="from" type="date" value="${p.from}"></div>
        <div><label for="to">To</label><input id="to" name="to" type="date" value="${p.to}"></div>
        <div><label>&nbsp;</label><button type="submit">Show</button></div></div>
      <p class="muted">Lagos days, both ends included. <a href="/admin/money?from=${p.from}&to=${p.to}&what=csv">Download this period</a> for a spreadsheet.</p></form>
    <div class="cards">
      <div class="card"><div class="label">Earned</div><div class="value">${money(p.earnedKobo)}</div></div>
      <div class="card"><div class="label">Spent</div><div class="value">${money(p.spentKobo)}</div></div>
      <div class="card ${p.profitKobo >= 0 ? "ok" : "bad"}"><div class="label">Profit</div><div class="value">${money(p.profitKobo)}</div></div>
      <div class="card"><div class="label">Held for the networks</div><div class="value">${money(p.networkShareKobo)}</div><span class="muted">theirs, not ours</span></div>
    </div>
    ${bars(p.days)}
    <div class="pair">
      <div><h3>Earned</h3><div class="scroll"><table><tr><th>From</th><th class="num">How much</th></tr>
        ${rows(p.earned, "Nothing earned in this period.")}
        <tr><th>In all</th><th class="num">${money(p.earnedKobo)}</th></tr></table></div></div>
      <div><h3>Spent</h3><div class="scroll"><table><tr><th>On what</th><th class="num">How much</th></tr>
        ${rows(p.spent, "Nothing spent in this period.")}
        <tr><th>In all</th><th class="num">${money(p.spentKobo)}</th></tr></table></div></div>
    </div>

    <h2>What was done</h2>
    <div class="scroll"><table><tr><th>What</th><th class="num">How many</th><th class="num">Worth</th></tr>
      <tr><td>Transfers paid out</td><td class="num">${v.transfers}</td><td class="num">${money(v.movedKobo)}</td></tr>
      <tr><td>Airtime and data sold</td><td class="num">${v.orders}</td><td class="num">${money(v.soldKobo)}</td></tr>
      <tr><td>of which bought by agents</td><td class="num">${v.agentOrders}</td><td class="num">${money(v.agentKobo)}</td></tr>
      <tr><td>Bought back from people</td><td class="num">${v.sales}</td><td class="num">${money(v.boughtKobo)}</td></tr>
    </table></div>

    <h2>Day by day</h2>
    <div class="scroll"><table><tr><th>Day</th><th class="num">Earned</th><th class="num">Spent</th><th class="num">Profit</th></tr>
      ${p.days.map((d) => html`<tr><td>${d.day}</td><td class="num">${money(d.earnedKobo)}</td><td class="num">${money(d.spentKobo)}</td><td class="num">${money(d.profitKobo)}</td></tr>`)}
      ${p.days.length === 0 ? html`<tr><td colspan="4" class="muted">Nothing between those dates.</td></tr>` : ""}</table></div>
    <p class="muted">Read at ${when(new Date())} Lagos time.</p>`;
  return { kind: "html", status, body: page({ title: "Money", admin: req.admin, current: "/admin/money", body }) };
}

export function registerMoney(app: App): void {
  app.get("/admin/money", async (req, db) => {
    if (req.query.get("what") === "csv") {
      const p = await profitAndLoss(db, { from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined });
      return {
        kind: "text",
        body: csv(p),
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="telco-money-${p.from}-to-${p.to}.csv"` },
      };
    }
    return moneyPage(req, db);
  });
}
