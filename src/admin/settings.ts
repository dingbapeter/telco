import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { parseNaira } from "../money.ts";
import { getAllSettings, NETWORK_CODES, SETTINGS, setSetting, type ResolvedSetting, type SettingKey } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf } from "./shared.ts";

type Shape = "kobo" | "basis_points" | "minutes" | "boolean" | "count" | "text" | "per_network_route" | "per_network_kobo" | "per_network_basis_points" | "per_network_text" | "per_network_longtext" | "json";

// How each setting is shown and typed. Kobo settings are entered in naira.
const SHAPES: Record<SettingKey, Shape> = {
  "fee.percent_basis_points": "basis_points",
  "fee.flat_kobo": "kobo",
  "fee.floor_kobo": "kobo",
  "fee.ceiling_kobo": "kobo",
  "fee.network_share_basis_points": "per_network_basis_points",
  "fee.pair_overrides": "json",
  "transfer.min_kobo": "kobo",
  "transfer.max_kobo": "kobo",
  "transfer.sender_daily_max_kobo": "kobo",
  "transfer.inbound_window_minutes": "minutes",
  "transfer.inbound_grace_minutes": "minutes",
  "payout.auto_approve_max_kobo": "kobo",
  "payout.automatic": "boolean",
  "payout.max_attempts": "count",
  "payout.route": "per_network_route",
  "phone.command_timeout_minutes": "minutes",
  "payout.daily_ceiling_kobo": "per_network_kobo",
  "retail.enabled": "boolean",
  "retail.min_kobo": "kobo",
  "retail.max_kobo": "kobo",
  "retail.discount_basis_points": "per_network_basis_points",
  "retail.order_window_minutes": "minutes",
  "retail.bank_name": "text",
  "retail.bank_account_number": "text",
  "retail.bank_account_name": "text",
  "agent.enabled": "boolean",
  "agent.commission_basis_points": "basis_points",
  "agent.discount_basis_points": "basis_points",
  "agent.min_topup_kobo": "kobo",
  "pool.floor_kobo": "per_network_kobo",
  "network.daily_transfer_cap_kobo": "per_network_kobo",
  "network.sender_ids": "per_network_text",
  "network.inbound_pattern": "per_network_longtext",
  "network.data_gift_code": "per_network_text",
  "network.sent_pattern": "per_network_longtext",
  "network.data_inbound_pattern": "per_network_longtext",
  "network.transfer_code": "per_network_text",
};

const nairaText = (kobo: number) => (kobo % 100 === 0 ? String(kobo / 100) : (kobo / 100).toFixed(2));
const percentText = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2));

function parsePercent(text: string): number {
  const cleaned = text.trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new UserFacingError("bad_percent", "Enter a percentage like 4 or 2.5.");
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function parseWhole(text: string, label: string): number {
  if (!/^\d+$/.test(text.trim())) throw new UserFacingError("bad_number", `${label} should be a whole number.`);
  return Number(text.trim());
}

function parseNairaOrThrow(text: string, label: string): number {
  const kobo = parseNaira(text);
  if (kobo === undefined) throw new UserFacingError("bad_amount", `${label} should be an amount in naira, like 20 or 1,500.`);
  return kobo;
}

// Turns what was typed into the value the registry validates.
export function valueFromForm(key: SettingKey, form: URLSearchParams): unknown {
  const shape = SHAPES[key];
  const label = SETTINGS[key].label;
  const field = (suffix = "") => form.get(`value${suffix}`) ?? "";
  switch (shape) {
    case "kobo":
      return parseNairaOrThrow(field(), label);
    case "basis_points":
      return parsePercent(field());
    case "minutes":
    case "count":
      return parseWhole(field(), label);
    case "boolean":
      return field() === "on";
    case "text":
      return field().trim();
    case "per_network_kobo":
      return Object.fromEntries(NETWORK_CODES.map((c) => [c, parseNairaOrThrow(field(`.${c}`), `${label} for ${c}`)]));
    case "per_network_basis_points":
      return Object.fromEntries(NETWORK_CODES.map((c) => [c, parsePercent(field(`.${c}`))]));
    case "per_network_text":
    case "per_network_longtext":
    case "per_network_route":
      return Object.fromEntries(NETWORK_CODES.map((c) => [c, field(`.${c}`).trim()]));
    case "json": {
      const text = field().trim();
      if (text === "") return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new UserFacingError("bad_json", `${label} must be written as JSON, for example {"MTN>AIRTEL": {"percent_basis_points": 300}}.`);
      }
    }
  }
}

function inputs(s: ResolvedSetting<SettingKey>): Html {
  const shape = SHAPES[s.key];
  const v = s.value as never;
  const one = (name: string, value: string, unit: string, type = "text") =>
    html`<div><label for="${s.key}${name}">${unit}</label><input type="${type}" inputmode="decimal" id="${s.key}${name}" name="value${name}" value="${value}"></div>`;
  switch (shape) {
    case "kobo":
      return one("", nairaText(v as number), "Naira");
    case "basis_points":
      return one("", percentText(v as number), "Percent");
    case "minutes":
      return one("", String(v as number), "Minutes");
    case "count":
      return one("", String(v as number), "Number of times");
    case "text":
      return one("", v as string, "Text");
    case "boolean":
      return html`<label for="${s.key}">Setting</label><select id="${s.key}" name="value"><option value="off" ${v ? "" : "selected"}>Off</option><option value="on" ${v ? "selected" : ""}>On</option></select>`;
    case "per_network_kobo":
      return html`<div class="row">${NETWORK_CODES.map((c) => one(`.${c}`, nairaText((v as Record<string, number>)[c]!), `${c}, naira`))}</div>`;
    case "per_network_basis_points":
      return html`<div class="row">${NETWORK_CODES.map((c) => one(`.${c}`, percentText((v as Record<string, number>)[c]!), `${c}, percent`))}</div>`;
    case "per_network_text":
      return html`<div class="row">${NETWORK_CODES.map((c) => one(`.${c}`, (v as Record<string, string>)[c]!, c))}</div>`;
    case "per_network_route":
      return html`<div class="row">${NETWORK_CODES.map(
        (c) => html`<div><label for="${s.key}.${c}">${c}</label><select id="${s.key}.${c}" name="value.${c}">${["provider", "phone"].map((r) => html`<option value="${r}" ${(v as Record<string, string>)[c] === r ? "selected" : ""}>${r}</option>`)}</select></div>`,
      )}</div>`;
    case "per_network_longtext":
      return html`${NETWORK_CODES.map(
        (c) => html`<label for="${s.key}.${c}">${c}</label><textarea id="${s.key}.${c}" name="value.${c}" rows="2">${(v as Record<string, string>)[c]!}</textarea>`,
      )}`;
    case "json":
      return html`<label for="${s.key}">JSON</label><textarea id="${s.key}" name="value">${JSON.stringify(v, null, 2) === "{}" ? "" : JSON.stringify(v, null, 2)}</textarea>`;
  }
}

function settingsPage(req: Request, all: ResolvedSetting<SettingKey>[], messages: Record<string, Html>, top: Html = html``): string {
  const groups = new Map<string, ResolvedSetting<SettingKey>[]>();
  for (const s of all) {
    const g = SETTINGS[s.key].group;
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const body = html`<h1>Settings</h1>
    <p class="muted">Every change takes effect on the next transfer. Nothing here needs a deploy. Every change is written to the audit log with your name.</p>
    ${top}
    <p class="jump">Jump to: ${[...groups.keys()].map((g) => html`<a href="#group-${g.replaceAll(" ", "-")}">${g}</a>`)}</p>
    ${[...groups.entries()].map(
      ([group, items]) => html`<h2 id="group-${group.replaceAll(" ", "-")}">${group}</h2>
        ${items.map((s) => {
          const spec = SETTINGS[s.key];
          return html`<form method="post" action="/admin/settings/${s.key}" class="panel" id="${s.key}">
            ${csrf(req)}
            <strong>${spec.label}</strong>
            <p class="muted">${spec.description}</p>
            <p>Now: <strong>${(spec.format as (v: unknown) => string)(s.value)}</strong>
              ${s.source === "fallback" ? html`<span class="muted">(built-in default, not yet set here)</span>` : ""}
              ${s.problem ? notice("problem", html`The stored value is not usable (${s.problem}), so the built-in default is in force. Set it again below.`) : ""}
            </p>
            ${messages[s.key] ?? ""}
            ${inputs(s)}
            <button type="submit">Save</button>
          </form>`;
        })}`,
    )}`;
  return page({ title: "Settings", admin: req.admin, current: "/admin/settings", body });
}

export function registerSettings(app: App): void {
  app.get("/admin/settings", async (req, db) => ({ kind: "html", body: settingsPage(req, await getAllSettings(db), {}) }));

  app.post("/admin/settings/:key", async (req, db) => {
    const key = req.query.get("key") as SettingKey;
    if (!Object.hasOwn(SETTINGS, key)) throw new UserFacingError("unknown_setting", "There is no setting by that name.");
    const messages: Record<string, Html> = {};
    let status = 200;
    let top: Html;
    try {
      const value = valueFromForm(key, req.form);
      await withActor(actor(req.admin), (c) => setSetting(c, actor(req.admin), key, value), db);
      messages[key] = notice("ok", `Saved. ${SETTINGS[key].label} is now in force for the next transfer.`);
      top = notice("ok", html`Saved <a href="#${key}">${SETTINGS[key].label}</a>.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      status = 400;
      messages[key] = notice("problem", err.message);
      top = notice("problem", html`<a href="#${key}">${SETTINGS[key].label}</a> was not saved: ${err.message}`);
    }
    // The message is shown at the top and again on the setting it belongs to,
    // and stays until the person moves on.
    return { kind: "html", status, body: settingsPage(req, await getAllSettings(db), messages, top) };
  });
}
