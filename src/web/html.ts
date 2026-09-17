// A tagged template that escapes every interpolated value unless it is
// already marked as HTML. There is no other way to build a page, so an
// unescaped value is a type error rather than a bug found in production.

export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}

export function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Child = Html | string | number | boolean | null | undefined | Child[];

function render(value: Child): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}

export function html(strings: TemplateStringsArray, ...values: Child[]): Html {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Html(out);
}

export const raw = (text: string): Html => new Html(text);

export type PageOptions = {
  title: string;
  body: Html;
  admin?: { name: string; email: string } | undefined;
  current?: string | undefined;
};

const NAV: { href: string; label: string }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/transfers", label: "Transfers" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/inbound", label: "Airtime in" },
  { href: "/admin/pools", label: "Pools" },
  { href: "/admin/numbers", label: "Receiving numbers" },
  { href: "/admin/bridge", label: "Phone bridge" },
  { href: "/admin/bundles", label: "Data bundles" },
  { href: "/admin/settlement", label: "Settlement" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/checklist", label: "Launch checklist" },
  { href: "/admin/audit", label: "Audit log" },
];

// One layout for every page. The stylesheet is served from this repository,
// never from a CDN, so nothing outside our server can break the page.
export function page(o: PageOptions): string {
  const nav = o.admin
    ? html`<nav class="nav">
        ${NAV.map((n) => html`<a href="${n.href}" ${n.href === o.current ? raw('aria-current="page"') : ""}>${n.label}</a>`)}
        <form method="post" action="/admin/logout" class="inline"><button class="link" type="submit">Log out ${o.admin.name}</button></form>
      </nav>`
    : "";
  return (
    "<!doctype html>" +
    html`<html lang="en-NG">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${o.title} | Telco command centre</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header class="top"><a class="brand" href="/admin">Telco command centre</a>${nav}</header>
<main class="main">${o.body}</main>
</body>
</html>`.text
  );
}

// A message that stays where the person is looking until they have read it.
export function notice(kind: "ok" | "problem" | "info", body: Child): Html {
  return html`<div class="notice notice-${kind}" role="${kind === "problem" ? "alert" : "status"}">${body}</div>`;
}
