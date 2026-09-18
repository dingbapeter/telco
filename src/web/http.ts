import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { sessionFromToken, type Admin } from "../auth.ts";
import { UserFacingError } from "../errors.ts";
import { notice, page } from "./html.ts";

export type Request = {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  rawBody: string;
  cookies: Record<string, string>;
  admin?: Admin | undefined;
  csrfToken?: string | undefined;
  ip: string;
  raw: IncomingMessage;
};

export type Response =
  | { kind: "html"; status?: number; body: string; headers?: Record<string, string> }
  | { kind: "redirect"; to: string; headers?: Record<string, string> }
  | { kind: "text"; status?: number; body: string; contentType?: string }
  | { kind: "json"; status?: number; body: unknown };

export type Handler = (req: Request, db: pg.Pool) => Promise<Response>;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean };

export const SESSION_COOKIE = "telco_admin";
const MAX_BODY = 64 * 1024;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

export class App {
  private routes: Route[] = [];
  private db: pg.Pool;
  constructor(db: pg.Pool) {
    this.db = db;
  }

  private add(method: string, pathPattern: string, handler: Handler, auth: boolean): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + pathPattern.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
        keys.push(k);
        return "([^/]+)";
      }) + "$",
    );
    this.routes.push({ method, pattern, keys, handler, auth });
  }
  get(p: string, h: Handler, auth = true): void {
    this.add("GET", p, h, auth);
  }
  post(p: string, h: Handler, auth = true): void {
    this.add("POST", p, h, auth);
  }

  listen(port: number, host = "127.0.0.1"): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        console.error(err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
          res.end(page({ title: "Something went wrong", body: notice("problem", "Something went wrong on the server. It has been logged. Try again, and if it happens again tell the founder what you were doing.") }));
        } else res.end();
      });
    });
    server.listen(port, host);
    return server;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.startsWith("/static/")) return this.serveStatic(url.pathname, res);

    const cookies = parseCookies(req.headers.cookie);
    const { form, rawBody } = req.method === "POST" ? await readForm(req) : { form: new URLSearchParams(), rawBody: "" };
    const request: Request = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      form,
      rawBody,
      cookies,
      ip: req.socket.remoteAddress ?? "",
      raw: req,
    };

    const session = await sessionFromToken(this.db, cookies[SESSION_COOKIE]);
    if (session) {
      request.admin = session.admin;
      request.csrfToken = session.csrfToken;
    }

    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      route.keys.forEach((k, i) => request.query.set(k, decodeURIComponent(m[i + 1]!)));
      if (route.auth && !request.admin) {
        return send(res, { kind: "redirect", to: `/admin/login?next=${encodeURIComponent(url.pathname)}` });
      }
      // Every state-changing request carries the session's token. A form
      // from another site cannot know it.
      if (route.auth && request.method === "POST" && form.get("_csrf") !== request.csrfToken) {
        return send(res, {
          kind: "html",
          status: 403,
          body: page({ title: "Form expired", admin: request.admin, body: notice("problem", "This form was opened before you logged in again, so it was not accepted. Go back, reload the page and try once more.") }),
        });
      }
      let response: Response;
      try {
        response = await route.handler(request, this.db);
      } catch (err) {
        if (err instanceof UserFacingError) {
          response = { kind: "html", status: 400, body: page({ title: "Not done", admin: request.admin, body: notice("problem", err.message) }) };
        } else throw err;
      }
      return send(res, response);
    }
    send(res, { kind: "html", status: 404, body: page({ title: "Not found", admin: request.admin, body: notice("problem", "There is no page at this address.") }) });
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const file = path.normalize(path.join(publicDir, pathname.slice("/static/".length)));
    if (!file.startsWith(publicDir)) return send(res, { kind: "text", status: 404, body: "Not found" });
    try {
      const body = await readFile(file);
      const type = file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
      res.end(body);
    } catch {
      send(res, { kind: "text", status: 404, body: "Not found" });
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readForm(req: IncomingMessage): Promise<{ form: URLSearchParams; rawBody: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new UserFacingError("body_too_large", "That form is larger than the server accepts.");
    chunks.push(chunk as Buffer);
  }
  const type = req.headers["content-type"] ?? "";
  const text = Buffer.concat(chunks).toString("utf8");
  if (type.startsWith("application/json")) {
    const params = new URLSearchParams();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A body that is not JSON is left for the handler to reject with the
      // raw text in hand.
    }
    for (const [k, v] of Object.entries(parsed)) params.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return { form: params, rawBody: text };
  }
  return { form: new URLSearchParams(text), rawBody: text };
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export function send(res: ServerResponse, r: Response): void {
  if (r.kind === "redirect") {
    res.writeHead(303, { location: r.to, ...SECURITY_HEADERS, ...(r.headers ?? {}) });
    res.end();
    return;
  }
  if (r.kind === "json") {
    res.writeHead(r.status ?? 200, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
    res.end(JSON.stringify(r.body));
    return;
  }
  if (r.kind === "text") {
    res.writeHead(r.status ?? 200, { "content-type": r.contentType ?? "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end(r.body);
    return;
  }
  res.writeHead(r.status ?? 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...(r.headers ?? {}) });
  res.end(r.body);
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function cookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
