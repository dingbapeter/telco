import { html, page } from "../web/html.ts";
import type { App } from "../web/http.ts";
import { pager, when } from "./shared.ts";

const PAGE = 100;

export function registerAudit(app: App): void {
  app.get("/admin/audit", async (req, db) => {
    const pageNo = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
    const table = (req.query.get("table") ?? "").trim();
    const who = (req.query.get("actor") ?? "").trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (table) where.push(`table_name = $${params.push(table)}`);
    if (who) where.push(`actor ILIKE $${params.push("%" + who + "%")}`);
    params.push(PAGE + 1, (pageNo - 1) * PAGE);
    const rows = (
      await db.query<{ id: number; at: Date; actor: string; table_name: string; row_id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
        `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    const tables = (await db.query<{ table_name: string }>("SELECT DISTINCT table_name FROM audit_log ORDER BY 1")).rows;
    const changed = (before: Record<string, unknown> | null, after: Record<string, unknown> | null): string => {
      if (!before) return JSON.stringify(after);
      if (!after) return "deleted";
      const diff: Record<string, unknown> = {};
      for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) diff[k] = { from: before[k], to: after[k] };
      return JSON.stringify(diff);
    };
    const body = html`<h1>Audit log</h1>
      <p class="muted">Written by the database itself on every change to settings, networks, receiving numbers, transfers, airtime notifications and administrators. Nothing in the code has to remember to log.</p>
      <form method="get" action="/admin/audit" class="panel row">
        <div><label for="table">Table</label><select id="table" name="table"><option value="">Any</option>${tables.map((t) => html`<option value="${t.table_name}" ${t.table_name === table ? "selected" : ""}>${t.table_name}</option>`)}</select></div>
        <div><label for="actor">Who</label><input id="actor" name="actor" type="text" value="${who}"></div>
        <div><label>&nbsp;</label><button type="submit">Filter</button></div>
      </form>
      <div class="scroll"><table>
        <tr><th>When</th><th>Who</th><th>What</th><th>Change</th></tr>
        ${rows.slice(0, PAGE).map((r) => html`<tr><td>${when(r.at)}</td><td>${r.actor}</td><td>${r.action} ${r.table_name} ${r.row_id}</td><td><code>${changed(r.before, r.after)}</code></td></tr>`)}
        ${rows.length === 0 ? html`<tr><td colspan="4" class="muted">Nothing yet.</td></tr>` : ""}
      </table></div>
      ${pager(`/admin/audit?${table ? `table=${table}&` : ""}${who ? `actor=${encodeURIComponent(who)}&` : ""}`, pageNo, rows.length > PAGE)}`;
    return { kind: "html", body: page({ title: "Audit log", admin: req.admin, current: "/admin/audit", body }) };
  });
}
