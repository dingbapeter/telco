import { find, KIND_WORDS } from "../find.ts";
import { html, notice, page } from "../web/html.ts";
import type { App } from "../web/http.ts";
import { when } from "./shared.ts";

// The answer to "a customer is on the phone and all I have is this number".
export function registerFind(app: App): void {
  app.get("/admin/find", async (req, db) => {
    const q = req.query.get("q") ?? "";
    const found = await find(db, q);
    const body = html`<h1>Find</h1>
      <form method="get" action="/admin/find" class="panel">
        <label for="q">A number, a reference, a credit code, an agent's name</label>
        <input id="q" name="q" type="search" value="${found.q}" autocapitalize="characters" autofocus>
        <button type="submit">Find</button></form>
      ${found.q === ""
        ? html`<p class="muted">Everything a customer can read out over the phone is looked up here at once: transfers, purchases, sales to us, credit codes, agents, the networks' own messages and what the phones were asked to dial.</p>`
        : found.hits.length === 0
          ? notice("info", html`Nothing anywhere matches <strong>${found.q}</strong>.${found.number ? html` That reads as the number ${found.number}, and nothing matches that either.` : ""} Check the letters, or try the last four digits of a number.`)
          : html`<p class="muted">${found.hits.length} thing${found.hits.length === 1 ? "" : "s"} match ${found.q}${found.number ? html`, read as the number ${found.number}` : ""}, newest first.</p>
            <div class="scroll"><table><tr><th>What</th><th>Which</th><th>Detail</th><th>State</th><th>When</th></tr>
              ${found.hits.map((h) => html`<tr><td>${KIND_WORDS[h.kind]}</td><td><a href="${h.href}">${h.title}</a></td><td>${h.detail}</td><td>${h.state.replaceAll("_", " ")}</td><td>${when(h.when)}</td></tr>`)}
            </table></div>`}`;
    return { kind: "html", body: page({ title: "Find", admin: req.admin, current: "/admin/find", body }) };
  });
}
