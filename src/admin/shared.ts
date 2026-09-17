import type { Admin } from "../auth.ts";
import { formatNaira, parseNaira } from "../money.ts";
import { UserFacingError } from "../errors.ts";
import { html, type Html, raw } from "../web/html.ts";
import type { Request } from "../web/http.ts";

export const lagos = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const when = (d: Date | string | null | undefined): string => (d ? lagos.format(new Date(d)) : "");

export const money = (kobo: number | null | undefined): string => (kobo === null || kobo === undefined ? "" : formatNaira(kobo));

export function csrf(req: Request): Html {
  return html`<input type="hidden" name="_csrf" value="${req.csrfToken ?? ""}">`;
}

export function actor(admin: Admin | undefined): string {
  return admin ? `admin:${admin.email}` : "anonymous";
}

export function stateBadge(state: string): Html {
  return html`<span class="state state-${state}">${state.replaceAll("_", " ")}</span>`;
}

// Reads an amount typed in naira and refuses anything that is not one.
export function nairaField(form: URLSearchParams, name: string, label: string): number {
  const kobo = parseNaira(form.get(name) ?? "");
  if (kobo === undefined) throw new UserFacingError("bad_amount", `${label} should be an amount in naira, like 500 or 1,250.50.`);
  return kobo;
}

export function requiredField(form: URLSearchParams, name: string, label: string): string {
  const v = (form.get(name) ?? "").trim();
  if (!v) throw new UserFacingError("missing_field", `${label} is needed.`);
  return v;
}

export function pager(base: string, pageNo: number, hasMore: boolean): Html {
  return html`<div class="pager">
    ${pageNo > 1 ? html`<a href="${base}page=${pageNo - 1}">Newer</a>` : ""}
    ${hasMore ? html`<a href="${base}page=${pageNo + 1}">Older</a>` : ""}
  </div>`;
}

export const nbsp = raw("&nbsp;");
