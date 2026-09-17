import { login, logout, SESSION_DAYS } from "../auth.ts";
import { UserFacingError } from "../errors.ts";
import { html, notice, page } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { sessionCookie, SESSION_COOKIE } from "../web/http.ts";

function loginPage(req: Request, problem?: string): string {
  const next = req.query.get("next") ?? req.form.get("next") ?? "/admin";
  return page({
    title: "Log in",
    body: html`<h1>Log in</h1>
      ${problem ? notice("problem", problem) : ""}
      <form method="post" action="/admin/login" class="panel">
        <input type="hidden" name="next" value="${next}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${req.form.get("email") ?? ""}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Log in</button>
      </form>`,
  });
}

export function registerLogin(app: App, secureCookies: boolean): void {
  app.get("/admin/login", async (req) => (req.admin ? { kind: "redirect", to: "/admin" } : { kind: "html", body: loginPage(req) }), false);

  app.post(
    "/admin/login",
    async (req, db) => {
      try {
        const { token } = await login(db, req.form.get("email") ?? "", req.form.get("password") ?? "");
        const next = req.form.get("next") ?? "/admin";
        return {
          kind: "redirect",
          to: next.startsWith("/admin") ? next : "/admin",
          headers: { "set-cookie": sessionCookie(token, secureCookies, SESSION_DAYS * 86_400) },
        };
      } catch (err) {
        if (err instanceof UserFacingError) return { kind: "html", status: 401, body: loginPage(req, err.message) };
        throw err;
      }
    },
    false,
  );

  app.post(
    "/admin/logout",
    async (req, db) => {
      await logout(db, req.cookies[SESSION_COOKIE]);
      return { kind: "redirect", to: "/admin/login", headers: { "set-cookie": sessionCookie("", secureCookies, 0) } };
    },
    false,
  );
}
