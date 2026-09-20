import type { Server } from "node:http";
import { buildApp } from "../../src/app.ts";
import { createAdmin } from "../../src/auth.ts";
import { as, pool } from "./db.ts";

export const ADMIN = { email: "founder@example.com", name: "Founder", password: "correct horse battery" };

// A real server on a random port, and a client that keeps cookies the way a
// browser does and never follows redirects, so every test sees exactly what
// the browser would be told.
export async function startServer(options: { knowsItsAddress?: boolean } = {}): Promise<{ base: string; server: Server }> {
  // Two servers in the tests: most know nothing of their public address,
  // as a developer's machine does; one is told its own address so the
  // check on where a form came from can be exercised.
  const server = buildApp(pool, { secureCookies: false }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  if (!options.knowsItsAddress) return { base, server };
  server.close();
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
  const told = buildApp(pool, { secureCookies: false, publicBaseUrl: base }).listen(port);
  await new Promise<void>((resolve) => told.once("listening", resolve));
  return { base, server: told };
}

export class Browser {
  private cookies = new Map<string, string>();
  private base: string;
  csrf = "";
  constructor(base: string) {
    this.base = base;
  }

  private header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private remember(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [k, v] = pair!.split("=");
      if (attrs.some((a) => a.trim() === "Max-Age=0")) this.cookies.delete(k!);
      else this.cookies.set(k!, v ?? "");
    }
  }

  async get(path: string): Promise<{ status: number; location: string | null; text: string }> {
    const res = await fetch(this.base + path, { headers: { cookie: this.header() }, redirect: "manual" });
    this.remember(res);
    const text = await res.text();
    const m = /name="_csrf" value="([^"]*)"/.exec(text);
    if (m) this.csrf = m[1]!;
    return { status: res.status, location: res.headers.get("location"), text };
  }

  async post(path: string, fields: Record<string, string>, withCsrf = true, extraHeaders: Record<string, string> = {}): Promise<{ status: number; location: string | null; text: string }> {
    const body = new URLSearchParams(withCsrf ? { _csrf: this.csrf, ...fields } : fields);
    const res = await fetch(this.base + path, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
      body: body.toString(),
      redirect: "manual",
    });
    this.remember(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  }

  async login(email = ADMIN.email, password = ADMIN.password) {
    const r = await this.post("/admin/login", { email, password }, false);
    if (r.status === 303) await this.get("/admin");
    return r;
  }
}

export async function seedAdmin(): Promise<void> {
  await as("test", (c) => createAdmin(c, ADMIN));
}

export const problems = (text: string): string[] => [...text.matchAll(/class="notice notice-problem"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1]!));
export const oks = (text: string): string[] => [...text.matchAll(/class="notice notice-(?:ok|info)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1]!));
const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
