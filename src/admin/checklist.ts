import { runChecklist } from "../checklist.ts";
import { html, page } from "../web/html.ts";
import type { App } from "../web/http.ts";

export function registerChecklist(app: App): void {
  app.get("/admin/checklist", async (req, db) => {
    const checks = await runChecklist(db);
    const bad = checks.filter((c) => c.status === "bad").length;
    const warn = checks.filter((c) => c.status === "warn").length;
    const body = html`<h1>Launch checklist</h1>
      <p class="muted">Every line is checked as the page opens, by reading the live configuration and the live outcomes. Nothing is green because a setting merely exists.</p>
      <p><strong>${bad === 0 ? "Nothing is blocking launch." : `${bad} thing(s) must be fixed before launch.`}</strong> ${warn > 0 ? `${warn} thing(s) should be looked at.` : ""}</p>
      ${checks.map(
        (c) => html`<div class="check ${c.status}"><div class="dot"></div><div>
          <strong>${c.title}</strong><div class="what">${c.detail}</div>
          ${c.fix ? html`<div><strong>What to do:</strong> ${c.fix}</div>` : ""}
        </div></div>`,
      )}`;
    return { kind: "html", body: page({ title: "Launch checklist", admin: req.admin, current: "/admin/checklist", body }) };
  });
}
