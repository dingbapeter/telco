import type pg from "pg";
import { createDevice, listDevices, parseNetworkMessage } from "../bridge.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { formatNaira } from "../money.ts";
import { getSettingValue, NETWORK_CODES } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, requiredField, when } from "./shared.ts";

export const STALE_AFTER_MINUTES = 30;

async function bridgePage(req: Request, db: pg.Pool, message?: Html, status = 200, tester?: Html): Promise<{ kind: "html"; status: number; body: string }> {
  const [devices, unparsed, patterns] = await Promise.all([
    listDevices(db),
    db.query<{ id: number; label: string; network_code: string; from_address: string; body: string; received_at: Date; note: string | null }>(
      `SELECT m.id, d.label, d.network_code, m.from_address, m.body, m.received_at, m.note
       FROM bridge_messages m JOIN bridge_devices d ON d.id = m.device_id WHERE m.outcome = 'unparsed' ORDER BY m.received_at DESC LIMIT 50`,
    ),
    getSettingValue(db, "network.inbound_pattern"),
  ]);
  const body = html`<h1>Phone bridge</h1>
    ${message ?? ""}
    <p class="muted">One Android phone per network holds our receiving SIM and forwards every text message it gets. A phone is healthy when it has been heard from in the last ${STALE_AFTER_MINUTES} minutes. Set-up steps are in docs/BRIDGE.md in the repository.</p>
    <h2>Phones</h2>
    <div class="scroll"><table>
      <tr><th>Network</th><th>Label</th><th>Last heard</th><th>App</th><th>Battery</th><th>Waiting on phone</th><th>Active</th><th></th></tr>
      ${devices.map((d) => {
        const stale = !d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > STALE_AFTER_MINUTES * 60_000;
        return html`<tr>
          <td>${d.network_code}</td><td>${d.label}</td>
          <td>${d.last_seen_at ? when(d.last_seen_at) : html`<span class="muted">never</span>`} ${d.active && stale ? html`<span class="state state-held">not heard from</span>` : ""}</td>
          <td>${d.app_version ?? ""}</td><td>${d.battery === null ? "" : `${d.battery}%`}</td><td>${d.queue_size ?? ""}</td>
          <td>${d.active ? "yes" : "no"}</td>
          <td><form method="post" action="/admin/bridge/${d.id}/toggle" class="inline">${csrf(req)}<button type="submit" class="secondary">${d.active ? "Pause" : "Activate"}</button></form></td>
        </tr>`;
      })}
      ${devices.length === 0 ? html`<tr><td colspan="8" class="muted">No phones yet. Add one below for each network.</td></tr>` : ""}
    </table></div>
    <h2>Add a phone</h2>
    <form method="post" action="/admin/bridge" class="panel">${csrf(req)}
      <div class="row">
        <div><label for="network">Network of the SIM in it</label><select id="network" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
        <div><label for="label">Label <span class="hint">include the receiving number if this network has more than one</span></label><input id="label" name="label" type="text" required></div>
      </div>
      <button type="submit">Create phone and show its token</button>
    </form>
    <h2>Try a pattern on a real message</h2>
    <p class="muted">Paste the text message a network sent when airtime arrived, pick the network, and see what the current pattern reads from it. If it reads wrongly, change the pattern under Settings, Networks, and try again here before saving.</p>
    <form method="post" action="/admin/bridge/try" class="panel">${csrf(req)}
      <div class="row">
        <div><label for="tnet">Network</label><select id="tnet" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}" ${req.form.get("network") === c ? "selected" : ""}>${c}</option>`)}</select></div>
      </div>
      <label for="tbody">The message</label><textarea id="tbody" name="body">${req.form.get("body") ?? ""}</textarea>
      <label for="tpat">Pattern to try <span class="hint">leave empty to try the one in force: ${NETWORK_CODES.map((c) => `${c} ${patterns[c] === "" ? "built-in" : "custom"}`).join(", ")}</span></label>
      <input id="tpat" name="pattern" type="text" value="${req.form.get("pattern") ?? ""}">
      <button type="submit" class="secondary">Try it</button>
      ${tester ?? ""}
    </form>
    <h2>Messages the parser did not understand (${unparsed.rows.length})</h2>
    <p class="muted">These looked like they might be airtime arriving but could not be read. Record any that are, under Airtime in, copying the message exactly.</p>
    ${unparsed.rows.length === 0 ? html`<p class="muted">None.</p>` : ""}
    ${unparsed.rows.map(
      (m) => html`<div class="panel"><strong>${m.network_code}</strong> from ${m.from_address} on ${m.label}, ${when(m.received_at)}<p><code>${m.body}</code></p><p class="muted">${m.note ?? ""}</p>
        <form method="post" action="/admin/bridge/messages/${m.id}/dismiss" class="inline">${csrf(req)}<button type="submit" class="secondary">Not airtime, dismiss</button></form></div>`,
    )}`;
  return { kind: "html", status, body: page({ title: "Phone bridge", admin: req.admin, current: "/admin/bridge", body }) };
}

export function registerBridgeAdmin(app: App): void {
  app.get("/admin/bridge", (req, db) => bridgePage(req, db));

  app.post("/admin/bridge", async (req, db) => {
    try {
      const { device, token } = await withActor(actor(req.admin), (c) => createDevice(c, req.form.get("label") ?? "", req.form.get("network") ?? ""), db);
      return bridgePage(
        req,
        db,
        notice("ok", html`<p><strong>${device.label}</strong> on ${device.network_code} is created. Type this token into the app on that phone. It is shown once and is not stored anywhere readable.</p>
          <p><code>${token}</code></p>
          <p>If it is lost, pause this phone and create it again.</p>`),
      );
    } catch (err) {
      if (err instanceof UserFacingError) return bridgePage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/bridge/:id/toggle", async (req, db) => {
    const { rows } = await withActor(actor(req.admin), (c) => c.query<{ active: boolean; label: string }>("UPDATE bridge_devices SET active = NOT active WHERE id = $1 RETURNING active, label", [Number(req.query.get("id"))]), db);
    if (!rows[0]) return bridgePage(req, db, notice("problem", "That phone is not in the list."), 404);
    return bridgePage(req, db, notice("ok", `${rows[0].label} is now ${rows[0].active ? "active" : "paused"}.`));
  });

  app.post("/admin/bridge/try", async (req, db) => {
    const network = requiredField(req.form, "network", "Network");
    const body = req.form.get("body") ?? "";
    const patterns = await getSettingValue(db, "network.inbound_pattern");
    const pattern = (req.form.get("pattern") ?? "").trim() || patterns[network as keyof typeof patterns] || "";
    const parsed = parseNetworkMessage(body, pattern);
    const result =
      "problem" in parsed
        ? notice("problem", `Not read: ${parsed.problem}`)
        : notice("ok", `Read as ${formatNaira(parsed.amountKobo)} from ${parsed.senderNumber}. If that is right and you typed a new pattern, save it under Settings, Networks.`);
    return bridgePage(req, db, undefined, 200, result);
  });

  app.post("/admin/bridge/messages/:id/dismiss", async (req, db) => {
    await withActor(actor(req.admin), (c) => c.query("UPDATE bridge_messages SET outcome = 'ignored', note = $2 WHERE id = $1 AND outcome = 'unparsed'", [Number(req.query.get("id")), `Dismissed by ${actor(req.admin)}`]), db);
    return bridgePage(req, db, notice("ok", "Dismissed."));
  });
}
