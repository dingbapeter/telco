// Drives every page the way a person would, on each browser engine given
// (Chromium for Chrome, Edge, Samsung Internet and Opera; WebKit for Safari
// on iPhone, iPad and Mac; Firefox), at phone, tablet and desktop sizes,
// with touch on the phones, and once with script switched off the way Opera
// Mini's extreme mode and blocked scripts leave a page. It fails on a page
// that scrolls sideways, a text field small enough to make an iPhone zoom
// in, a button too small to tap, or any error the browser reports. Run with
// the server already seeded; CI does that. Screenshots go to the folder.
import { chromium, devices, firefox, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3994";
const out = process.env.SHOTS_DIR ?? "browser-shots";
mkdirSync(out, { recursive: true });
const engines = (process.env.ENGINES ?? "chromium").split(",").map((e) => e.trim()).filter(Boolean);

const phone = (name, device) => ({ name, ...devices[device], defaultBrowserType: undefined });
const profiles = [
  phone("iphone-se", "iPhone SE"),
  phone("iphone-13", "iPhone 13"),
  phone("pixel-5", "Pixel 5"),
  phone("galaxy-s9", "Galaxy S9+"),
  { name: "ipad", ...devices["iPad (gen 7)"], defaultBrowserType: undefined },
  { name: "laptop", viewport: { width: 1280, height: 800 } },
  { name: "desktop", viewport: { width: 1920, height: 1080 } },
  { name: "no-script-phone", ...devices["Pixel 5"], defaultBrowserType: undefined, javaScriptEnabled: false },
];

const publicPages = ["/", "/buy", "/agent/login", `/t/${process.env.TRANSFER_REF}`, `/o/${process.env.ORDER_REF}`];
const agentPages = ["/agent", "/agent/buy", "/agent/topup", "/agent/withdraw", "/agent/link"];
const adminPages = ["/admin", "/admin/transfers", "/admin/orders", "/admin/agents", "/admin/inbound", "/admin/pools", "/admin/numbers", "/admin/bridge", "/admin/bundles", "/admin/settlement", "/admin/settings", "/admin/checklist", "/admin/audit", `/admin/transfers/${process.env.TRANSFER_ID}`];

const problems = [];
const launchers = { chromium, webkit, firefox };

async function check(page, label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""}`;
    // Everything past the right edge, widest first, each with the scrolling
    // box that holds it if there is one, so a sideways scroll names its cause
    // whether or not a table wrapper was meant to absorb it.
    const scrollerOf = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") return p;
      }
      return null;
    };
    const past = [...document.querySelectorAll("body *")]
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > doc.clientWidth + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 6)
      .map((x) => {
        const holder = scrollerOf(x.el);
        return `${describe(x.el)} ends at ${Math.round(x.right)}px of ${doc.clientWidth}${holder ? ` inside ${describe(holder)} which scrolls` : ""}`;
      });
    const smallInputs = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .map((el) => ({ name: el.name || el.id, size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((x) => x.size < 16);
    const smallTaps = [...document.querySelectorAll("button, a.button, input[type=submit]")]
      .map((el) => ({ text: (el.textContent || "").trim().slice(0, 30), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
      .filter((x) => x.h > 0 && (x.h < 44 || x.w < 44));
    // The security policy allows no inline style, so a page must carry none.
    // Read before the probe below, which hides elements one at a time.
    const inlineStyles = [...document.querySelectorAll("style, [style]")].slice(0, 5).map(describe);
    // When a page scrolls sideways and nothing obvious sticks out, hide each
    // element in turn and see which one stops the scrolling. The deepest such
    // element is the cause. Deliberately last: it changes the page while it
    // runs and puts it back after each try.
    const culprits = [];
    if (overflow > 1) {
      const depth = (el) => { let d = 0; for (let p = el.parentElement; p; p = p.parentElement) d += 1; return d; };
      for (const el of document.querySelectorAll("body *")) {
        const had = el.getAttribute("style");
        el.style.display = "none";
        const left = doc.scrollWidth - doc.clientWidth;
        if (had === null) el.removeAttribute("style");
        else el.setAttribute("style", had);
        if (left <= 1) culprits.push({ what: describe(el), deep: depth(el) });
      }
      culprits.sort((a, b) => b.deep - a.deep);
    }
    return {
      overflow,
      past,
      culprits: culprits.slice(0, 3).map((c) => c.what),
      bodyWidth: Math.round(document.body.getBoundingClientRect().width),
      viewport: doc.clientWidth,
      smallInputs,
      smallTaps,
      inlineStyles,
    };
  });
  if (r.overflow > 1) {
    const cause = r.culprits.length > 0 ? `hiding ${r.culprits.join(" or ")} stops it` : "hiding any one element does not stop it";
    problems.push(`${label}: page scrolls sideways by ${r.overflow}px, body ${r.bodyWidth}px, page area ${r.viewport}px; ${cause}; past the edge: ${r.past.join("; ") || "no element"}`);
  }
  for (const i of r.smallInputs) problems.push(`${label}: field "${i.name}" is ${i.size}px, iPhones zoom in below 16px`);
  for (const t of r.smallTaps) problems.push(`${label}: button "${t.text}" is ${Math.round(t.w)}x${Math.round(t.h)}px, smaller than a fingertip`);
  for (const e of r.inlineStyles) problems.push(`${label}: ${e} carries an inline style, which the security policy refuses`);
}

for (const engine of engines) {
const browser = await launchers[engine].launch();
for (const p0 of profiles) {
  // Firefox has no mobile mode; it still honours the size and touch.
  const profile = engine === "firefox" ? { ...p0, isMobile: undefined } : p0;
  const label0 = `${engine} ${profile.name}`;
  const ctx = await browser.newContext({ ...profile, name: undefined });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => problems.push(`${label0}: the browser reported an error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Before each WebKit screenshot, Playwright appends an empty <style> to
    // the page to settle animations, and the product's security policy
    // refuses it. The page check proves no page of ours carries an inline
    // style, so that refusal can only be the tool's own.
    if (msg.text().includes("Refused to apply a stylesheet")) return;
    problems.push(`${label0}: console error: ${msg.text()}`);
  });
  const tapOrClick = (sel) => (profile.hasTouch ? page.tap(sel) : page.click(sel));
  // WebKit and Firefox refuse a screenshot taller than 32767 device pixels.
  // A phone draws two to four and a half device pixels per CSS pixel, so the
  // settings page on an iPhone SE passes that long before its CSS height
  // does; such a page keeps its first screen only.
  const scale = profile.deviceScaleFactor ?? 1;
  const shot = async (p) => {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const path = `${out}/${engine}-${profile.name}${p.replace(/[^a-z0-9]+/gi, "-")}.png`;
    await page.screenshot({ path, fullPage: height * scale <= 30_000 });
  };
  for (const p of publicPages) {
    await page.goto(base + p);
    await check(page, `${label0} ${p}`);
    await shot(p);
  }
  // Agent portal, logged in.
  await page.goto(base + "/agent/login");
  await page.fill("#phone", process.env.AGENT_PHONE);
  await page.fill("#password", process.env.AGENT_PASSWORD);
  await tapOrClick("form button[type=submit]");
  await page.waitForURL(base + "/agent");
  for (const p of agentPages) {
    await page.goto(base + p);
    await check(page, `${label0} ${p}`);
    await shot(p);
  }
  // Command centre, logged in.
  await page.goto(base + "/admin/login");
  await page.fill("#email", process.env.ADMIN_EMAIL);
  await page.fill("#password", process.env.ADMIN_PASSWORD);
  await tapOrClick("button[type=submit]");
  await page.waitForURL(base + "/admin");
  for (const p of adminPages) {
    await page.goto(base + p);
    await check(page, `${label0} ${p}`);
    await shot(p);
  }
  // The interactions that matter most, on a touch phone, a desktop and a
  // phone without script: a sender gets a quote choosing the networks by
  // hand, and a buyer places an order. Three profiles, because the product
  // refuses more than a few quotes from one address in ten minutes.
  if (!["iphone-13", "laptop", "no-script-phone"].includes(profile.name)) {
    await ctx.close();
    continue;
  }
  await page.goto(base + "/");
  await page.fill("#sender", "08031234567");
  await page.fill("#recipient", "08021234567");
  await page.selectOption("#from", "MTN");
  await page.selectOption("#to", "AIRTEL");
  await page.fill("#amount", "500");
  await tapOrClick("form#quote button");
  await page.waitForURL(/\/t\/TX-/);
  await check(page, `${label0} quote`);
  // And a buyer places an order.
  await page.goto(base + "/buy");
  await page.fill("#number", "08021234567");
  await page.selectOption("#network", "AIRTEL");
  await page.fill("#amount", "500");
  await tapOrClick("form button[type=submit]");
  await page.waitForURL(/\/o\/RT-/);
  await check(page, `${label0} order`);
  await ctx.close();
}
await browser.close();
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => "  " + p).join("\n")}`);
  process.exit(1);
}
console.log(`Every page fits, reads, taps and works without script on ${engines.join(", ")} at ${profiles.map((p) => p.name).join(", ")}.`);
