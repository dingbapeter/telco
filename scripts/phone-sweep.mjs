// Drives every page the way a phone would, at iPhone and Android sizes with
// touch, and fails on anything that would make a page hard to use on a
// cheap phone: sideways scrolling, text fields smaller than 16 pixels
// (iPhones zoom in on those), and buttons too small to tap. Run with the
// server already seeded; CI does that. Screenshots go to the given folder.
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3994";
const out = process.env.SHOTS_DIR ?? "phone-shots";
mkdirSync(out, { recursive: true });

const profiles = [
  { name: "iphone-se", ...devices["iPhone SE"], defaultBrowserType: undefined },
  { name: "iphone-13", ...devices["iPhone 13"], defaultBrowserType: undefined },
  { name: "pixel-5", ...devices["Pixel 5"], defaultBrowserType: undefined },
  { name: "galaxy-s9", ...devices["Galaxy S9+"], defaultBrowserType: undefined },
];

const publicPages = ["/", "/buy", "/agent/login", `/t/${process.env.TRANSFER_REF}`, `/o/${process.env.ORDER_REF}`];
const agentPages = ["/agent", "/agent/buy", "/agent/topup", "/agent/withdraw", "/agent/link"];
const adminPages = ["/admin", "/admin/transfers", "/admin/orders", "/admin/agents", "/admin/inbound", "/admin/pools", "/admin/numbers", "/admin/bridge", "/admin/bundles", "/admin/settlement", "/admin/settings", "/admin/checklist", "/admin/audit", `/admin/transfers/${process.env.TRANSFER_ID}`];

const browser = await chromium.launch();
const problems = [];

async function check(page, label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const smallInputs = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .map((el) => ({ name: el.name || el.id, size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((x) => x.size < 16);
    const smallTaps = [...document.querySelectorAll("button, a.button, input[type=submit]")]
      .map((el) => ({ text: (el.textContent || "").trim().slice(0, 30), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
      .filter((x) => x.h > 0 && (x.h < 44 || x.w < 44));
    return { overflow, smallInputs, smallTaps };
  });
  if (r.overflow > 1) problems.push(`${label}: page scrolls sideways by ${r.overflow}px`);
  for (const i of r.smallInputs) problems.push(`${label}: field "${i.name}" is ${i.size}px, iPhones zoom in below 16px`);
  for (const t of r.smallTaps) problems.push(`${label}: button "${t.text}" is ${Math.round(t.w)}x${Math.round(t.h)}px, smaller than a fingertip`);
}

for (const profile of profiles) {
  const ctx = await browser.newContext({ ...profile });
  const page = await ctx.newPage();
  for (const p of publicPages) {
    await page.goto(base + p);
    await check(page, `${profile.name} ${p}`);
    await page.screenshot({ path: `${out}/${profile.name}${p.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: true });
  }
  // Agent portal, logged in.
  await page.goto(base + "/agent/login");
  await page.fill("#phone", process.env.AGENT_PHONE);
  await page.fill("#password", process.env.AGENT_PASSWORD);
  await page.tap("form button[type=submit]");
  await page.waitForURL(base + "/agent");
  for (const p of agentPages) {
    await page.goto(base + p);
    await check(page, `${profile.name} ${p}`);
    await page.screenshot({ path: `${out}/${profile.name}${p.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: true });
  }
  // Command centre, logged in.
  await page.goto(base + "/admin/login");
  await page.fill("#email", process.env.ADMIN_EMAIL);
  await page.fill("#password", process.env.ADMIN_PASSWORD);
  await page.tap("button[type=submit]");
  await page.waitForURL(base + "/admin");
  for (const p of adminPages) {
    await page.goto(base + p);
    await check(page, `${profile.name} ${p}`);
    await page.screenshot({ path: `${out}/${profile.name}${p.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: true });
  }
  // The one interaction that matters most: a sender gets a quote by touch.
  await page.goto(base + "/");
  await page.fill("#sender", "08031234567");
  await page.fill("#recipient", "08021234567");
  await page.selectOption("#from", "MTN");
  await page.selectOption("#to", "AIRTEL");
  await page.fill("#amount", "500");
  await page.tap("form#quote button");
  await page.waitForURL(/\/t\/TX-/);
  await check(page, `${profile.name} quote by touch`);
  await ctx.close();
}
await browser.close();

if (problems.length) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => "  " + p).join("\n")}`);
  process.exit(1);
}
console.log(`Every page fits, reads and taps on ${profiles.map((p) => p.name).join(", ")}.`);
