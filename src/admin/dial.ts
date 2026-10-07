import { html, page } from "../web/html.ts";
import type { App } from "../web/http.ts";
import { pager, when } from "./shared.ts";

// What callers did on the dial code.
//
// The reason this page exists is the caller who rings up to say they were
// shown something else, or that they keyed a different number. Every screen
// we sent and every key they pressed is in the session's transcript, so the
// answer is a reading rather than an argument.

const PAGE = 50;

type Row = {
  id: number;
  session_id: string;
  caller_number: string;
  service_code: string;
  network_code: string | null;
  step: string;
  reference: string | null;
  keypresses: number;
  outcome: string | null;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
};

type Line = { at: string; keyed?: string; screen: string };

// A session's standing in one word, which is the column the founder scans.
function standing(r: Row): string {
  if (!r.ended_at) return "open";
  if (r.outcome === null) return "ended";
  return r.outcome.replace("refused:", "refused, ").replaceAll("_", " ");
}

export function registerDial(app: App): void {
  app.get("/admin/dial", async (req, db) => {
    const pageNo = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
    const caller = (req.query.get("caller") ?? "").trim();
    const params: unknown[] = [];
    const where = caller ? `WHERE caller_number LIKE $${params.push("%" + caller.replace(/\D/g, "") + "%")}` : "";
    params.push(PAGE + 1, (pageNo - 1) * PAGE);
    const rows = (
      await db.query<Row>(
        `SELECT * FROM ussd_sessions ${where} ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    const body = html`<h1>Dial code</h1>
      <p class="muted">Every session on the short code, newest first. Open one to read exactly what the caller was shown and what they keyed. The code itself, and whether it answers at all, are on the Settings page under Dial service.</p>
      <form method="get" action="/admin/dial" class="panel row">
        <div><label for="caller">Caller's number</label><input id="caller" name="caller" type="text" inputmode="numeric" value="${caller}"></div>
        <div><label>&nbsp;</label><button type="submit">Filter</button></div>
      </form>
      <div class="scroll"><table>
        <tr><th>Started</th><th>Caller</th><th>Network</th><th>Keys</th><th>Standing</th><th>Made</th><th></th></tr>
        ${rows.slice(0, PAGE).map(
          (r) => html`<tr>
            <td>${when(r.started_at)}</td>
            <td>${r.caller_number}</td>
            <td>${r.network_code ?? "not said"}</td>
            <td>${String(r.keypresses)}</td>
            <td>${standing(r)}</td>
            <td>${r.reference ? html`<a href="/admin/find?q=${r.reference}">${r.reference}</a>` : ""}</td>
            <td><a href="/admin/dial/${String(r.id)}">Read</a></td>
          </tr>`,
        )}
        ${rows.length === 0 ? html`<tr><td colspan="7" class="muted">Nobody has dialled yet.</td></tr>` : ""}
      </table></div>
      ${pager(`/admin/dial?${caller ? `caller=${encodeURIComponent(caller)}&` : ""}`, pageNo, rows.length > PAGE)}`;
    return { kind: "html", body: page({ title: "Dial code", admin: req.admin, current: "/admin/dial", body }) };
  });

  app.get("/admin/dial/:id", async (req, db) => {
    const id = Number(req.query.get("id"));
    const row = Number.isSafeInteger(id) ? (await db.query<Row & { transcript: Line[] }>("SELECT * FROM ussd_sessions WHERE id = $1", [id])).rows[0] : undefined;
    if (!row) {
      return {
        kind: "html",
        status: 404,
        body: page({
          title: "No such session",
          admin: req.admin,
          current: "/admin/dial",
          body: html`<h1>No such session</h1>
            <p>There is no dialled session with that number. It may have been from before this was kept. <a href="/admin/dial">Back to the dial code</a>.</p>`,
        }),
      };
    }
    const body = html`<h1>${row.caller_number} on ${row.service_code || "the dial code"}</h1>
      <div class="panel">
        <p>
          Started ${when(row.started_at)}, last heard from ${when(row.last_seen_at)}${row.ended_at ? html`, ended ${when(row.ended_at)}` : ""}.
          ${String(row.keypresses)} keypresses. Standing: ${standing(row)}.
          ${row.reference ? html`It made <a href="/admin/find?q=${row.reference}">${row.reference}</a>.` : "It made nothing."}
        </p>
        <p class="muted">The network's own id for this session was <code>${row.session_id}</code>. Quote it to the aggregator when something needs looking into at their end.</p>
      </div>
      <div class="scroll"><table>
        <tr><th>When</th><th>Keyed</th><th>Shown</th></tr>
        ${row.transcript.map((l) => html`<tr><td>${when(l.at)}</td><td>${l.keyed ?? ""}</td><td><pre class="screen">${l.screen}</pre></td></tr>`)}
      </table></div>
      <p><a href="/admin/dial">Back to the dial code</a></p>`;
    return { kind: "html", body: page({ title: "Dialled session", admin: req.admin, current: "/admin/dial", body }) };
  });
}
