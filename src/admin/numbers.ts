import type pg from "pg";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { normaliseNigerianNumber } from "../phone.ts";
import { NETWORK_CODES } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, requiredField } from "./shared.ts";

const START_OF_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

async function numbersPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const rows = (
    await db.query<{ number: string; network_code: string; label: string; active: boolean; daily_cap_kobo: number; used_today: number }>(
      `SELECT r.*, coalesce((SELECT sum(coalesce(received_kobo, requested_kobo)) FROM transfers t
         WHERE t.receiving_number = r.number AND t.created_at >= ${START_OF_TODAY} AND t.state NOT IN ('expired', 'refunded')), 0)::bigint AS used_today
       FROM receiving_numbers r ORDER BY r.network_code, r.number`,
    )
  ).rows;
  const body = html`<h1>Receiving numbers</h1>
    ${message ?? ""}
    <p class="muted">Our own numbers that senders transfer airtime to, one or more per network. A daily cap of zero means no cap. Keep caps under what the network tolerates so a number is not barred.</p>
    <div class="scroll"><table>
      <tr><th>Network</th><th>Number</th><th>Label</th><th class="num">Daily cap</th><th class="num">Used today</th><th>Active</th><th></th></tr>
      ${rows.map(
        (r) => html`<tr>
          <td>${r.network_code}</td><td>${r.number}</td><td>${r.label}</td>
          <td class="num">${r.daily_cap_kobo === 0 ? "none" : money(r.daily_cap_kobo)}</td><td class="num">${money(r.used_today)}</td>
          <td>${r.active ? "yes" : "no"}</td>
          <td><form method="post" action="/admin/numbers/${r.number}/toggle" class="inline">${csrf(req)}<button type="submit" class="secondary">${r.active ? "Pause" : "Activate"}</button></form></td>
        </tr>`,
      )}
      ${rows.length === 0 ? html`<tr><td colspan="7" class="muted">No receiving numbers yet. Add one below for each network.</td></tr>` : ""}
    </table></div>
    <h2>Add or update a number</h2>
    <form method="post" action="/admin/numbers" class="panel">${csrf(req)}
      <div class="row">
        <div><label for="network">Network</label><select id="network" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
        <div><label for="number">Number</label><input id="number" name="number" type="text" inputmode="tel" required></div>
      </div>
      <div class="row">
        <div><label for="label">Label <span class="hint">for example "MTN phone in the office"</span></label><input id="label" name="label" type="text"></div>
        <div><label for="cap">Daily cap in naira <span class="hint">0 for no cap</span></label><input id="cap" name="cap" type="text" inputmode="decimal" value="0"></div>
      </div>
      <button type="submit">Save number</button>
    </form>`;
  return { kind: "html", status, body: page({ title: "Receiving numbers", admin: req.admin, current: "/admin/numbers", body }) };
}

export function registerNumbers(app: App): void {
  app.get("/admin/numbers", (req, db) => numbersPage(req, db));

  app.post("/admin/numbers", async (req, db) => {
    try {
      const network = requiredField(req.form, "network", "Network");
      if (!(NETWORK_CODES as readonly string[]).includes(network)) throw new UserFacingError("unknown_network", "Choose a network.");
      const number = normaliseNigerianNumber(requiredField(req.form, "number", "Number"));
      if (!number) throw new UserFacingError("bad_number", "The number should be a Nigerian mobile number like 08031234567.");
      const cap = nairaField(req.form, "cap", "Daily cap");
      const label = (req.form.get("label") ?? "").trim();
      await withActor(actor(req.admin), (c) =>
        c.query(
          `INSERT INTO receiving_numbers (number, network_code, label, daily_cap_kobo) VALUES ($1, $2, $3, $4)
           ON CONFLICT (number) DO UPDATE SET network_code = EXCLUDED.network_code, label = EXCLUDED.label, daily_cap_kobo = EXCLUDED.daily_cap_kobo`,
          [number, network, label, cap],
        ),
        db,
      );
      return numbersPage(req, db, notice("ok", `${number} on ${network} is saved and active.`));
    } catch (err) {
      if (err instanceof UserFacingError) return numbersPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/numbers/:number/toggle", async (req, db) => {
    const number = req.query.get("number")!;
    const { rows } = await withActor(actor(req.admin), (c) => c.query<{ active: boolean }>("UPDATE receiving_numbers SET active = NOT active WHERE number = $1 RETURNING active", [number]), db);
    if (!rows[0]) return numbersPage(req, db, notice("problem", "That number is not in the list."), 404);
    return numbersPage(req, db, notice("ok", `${number} is now ${rows[0].active ? "active" : "paused"}.`));
  });
}
