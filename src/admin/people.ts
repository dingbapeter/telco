import type pg from "pg";
import { createAdmin, listAdmins, resetAdminPassword, setAdminRole, toggleAdmin, FOUNDER_ONLY } from "../auth.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, requiredField, when } from "./shared.ts";

// Who can log in, and what each of them may do. Kept for the founder,
// because this is the page that decides who holds the keys.
async function peoplePage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const people = await listAdmins(db);
  const founders = people.filter((p) => p.active && p.role === "founder").length;
  const body = html`<h1>People</h1>${message ?? ""}
    <p class="muted">Everybody here can do the day's work: releasing a hold, paying somebody what they are owed, refunding, answering a customer. A founder can also do the things below, which staff cannot.</p>
    <div class="scroll"><table><tr><th>Name</th><th>Email</th><th>What they may do</th><th>Last seen</th><th>Since</th><th></th></tr>
      ${people.map((p) => html`<tr><td>${p.name}${p.id === req.admin?.id ? " (you)" : ""}</td><td>${p.email}</td>
        <td>${p.role === "founder" ? "everything" : "the day's work"}${p.active ? "" : ", paused"}</td>
        <td>${p.last_seen ? when(p.last_seen) : "never"}</td><td>${when(p.created_at)}</td>
        <td>${p.id === req.admin?.id
          ? html`<span class="muted">you cannot change your own</span>`
          : html`<form method="post" action="/admin/people/${p.id}/role" class="inline">${csrf(req)}
              <input type="hidden" name="role" value="${p.role === "founder" ? "staff" : "founder"}">
              <button type="submit" class="secondary" ${p.role === "founder" && founders < 2 ? "disabled" : ""}>Make ${p.role === "founder" ? "staff" : "a founder"}</button></form>
            <form method="post" action="/admin/people/${p.id}/toggle" class="inline">${csrf(req)}<button type="submit" class="secondary">${p.active ? "Pause" : "Let back in"}</button></form>
            <form method="post" action="/admin/people/${p.id}/reset" class="inline">${csrf(req)}<button type="submit" class="secondary">New password</button></form>`}</td></tr>`)}
    </table></div>
    ${founders < 2 ? notice("info", "There is one founder, so that account cannot be made staff: somebody has to be able to change the settings.") : ""}
    <h2>Kept for a founder</h2>
    <ul class="facts">${FOUNDER_ONLY.map((r) => html`<li>${r.why[0]!.toUpperCase()}${r.why.slice(1)}.</li>`)}</ul>
    <h2>Add somebody</h2>
    <form method="post" action="/admin/people" class="panel">${csrf(req)}
      <div class="row"><div><label for="name">Name</label><input id="name" name="name" type="text" required></div>
        <div><label for="email">Email, their login</label><input id="email" name="email" type="email" required></div>
        <div><label for="role">What they may do</label><select id="role" name="role"><option value="staff">The day's work</option><option value="founder">Everything</option></select></div></div>
      <button type="submit">Add them and show their first password</button>
      <p class="muted">The password is shown once, here, and never again. Give it to them yourself; they change it when they log in.</p></form>`;
  return { kind: "html", status, body: page({ title: "People", admin: req.admin, current: "/admin/people", body }) };
}

export function registerPeople(app: App): void {
  app.get("/admin/people", (req, db) => peoplePage(req, db));

  app.post("/admin/people", async (req, db) => {
    try {
      const role = req.form.get("role") === "founder" ? "founder" : "staff";
      const password = `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      const admin = await withActor(actor(req.admin), (c) => createAdmin(c, { email: requiredField(req.form, "email", "An email"), name: requiredField(req.form, "name", "A name"), password, role }), db);
      return peoplePage(
        req,
        db,
        notice("ok", html`<p><strong>${admin.name}</strong> can now log in at /admin/login with ${admin.email} and may do ${role === "founder" ? "everything" : "the day's work"}. This password is shown once:</p><p><code>${password}</code></p>`),
      );
    } catch (err) {
      if (err instanceof UserFacingError) return peoplePage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  const act = (path: string, fn: (req: Request, db: pg.Pool, id: number) => Promise<Html>) =>
    app.post(`/admin/people/:id/${path}`, async (req, db) => {
      try {
        return await peoplePage(req, db, await fn(req, db, Number(req.query.get("id"))));
      } catch (err) {
        if (err instanceof UserFacingError) return peoplePage(req, db, notice("problem", err.message), 400);
        throw err;
      }
    });

  // There is no separate rule here about the last founder, and there does
  // not need to be. Only a founder can open this page, so the only way to
  // leave the business without one is to demote or pause yourself, and
  // nobody may do either.
  act("role", async (req, db, id) => {
    const role = req.form.get("role") === "founder" ? "founder" : "staff";
    const changed = await withActor(actor(req.admin), (c) => setAdminRole(c, req.admin!.id, id, role), db);
    return notice("ok", `${changed.name} may now do ${role === "founder" ? "everything" : "the day's work"}.`);
  });

  act("toggle", async (req, db, id) => {
    const changed = await withActor(actor(req.admin), (c) => toggleAdmin(c, req.admin!.id, id), db);
    return notice("ok", changed.active ? `${changed.name} can log in again.` : `${changed.name} is paused and has been put out of the command centre.`);
  });

  act("reset", async (req, db, id) => {
    const { admin, password } = await withActor(actor(req.admin), (c) => resetAdminPassword(c, id), db);
    return notice("ok", html`<p>New password for <strong>${admin.name}</strong>, shown once. They are logged out everywhere.</p><p><code>${password}</code></p>`);
  });
}
