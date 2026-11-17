// Smoke test: loads the real page in headless Chromium with every outside request blocked
// (Firebase, onvista, CoinGecko), so it needs no network and touches no real data.
//
//   node tests/smoke.mjs          (needs Playwright with Chromium: npm i -g playwright && npx playwright install chromium)
//
// It guards the things a layout change can silently break:
//   • every element the scripts look up by id still exists in the page
//   • Imprint and Privacy show their full text, signed out and inside the demo
//   • the Imprint / Privacy links are on the start page and on the "You" page
//   • start page and demo portfolio render without script errors
// Screenshots of each step go to tests/out/ (ignored by git).

import { createRequire } from "node:module";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "out");
mkdirSync(OUT, { recursive: true });

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};

/* ---------- 1. ids the scripts need must exist ---------- */
// Every $("id") / getElementById("id") in js/ must be in index.html, or be created by a script
// (an id="…" inside a template string). Catches a removed container like #view-legal.
{
  const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const js = readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(ROOT, "js", f), "utf8")).join("\n");
  const have = new Set([...(html + js).matchAll(/\bid=\\?["']([\w-]+)\\?["']/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/(?:\$|getElementById)\(\s*["']([\w-]+)["']\s*\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !have.has(id));
  ok(`all ${used.size} ids used by the scripts exist`, missing.length === 0, `missing: ${missing.join(", ")}`);
}

/* ---------- 2. the page itself ---------- */
const LEGAL = {
  imprint: {
    title: "Imprint",
    must: ["Markus Diem", "Leitgebgasse 7/25", "1050 Wien", "diemmarkus@gmail.com", "§ 5 ECG", "§ 25 MedienG", "No investment advice"],
  },
  privacy: {
    title: "Privacy policy",
    must: ["Markus Diem", "diemmarkus@gmail.com", "Art. 6", "Firebase", "GitHub Pages", "onvista", "CoinGecko", "Your rights", "Datenschutzbehörde"],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Serve the repo from a fake origin; block everything else so the test is offline and deterministic.
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.host !== "stonks.test") return route.abort();
  const rel = decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
  route.fulfill({ path: file });
});

const BASE = "http://stonks.test/index.html";
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(400); };

async function checkLegal(kind, where) {
  await go(`#/${kind}`);
  const { title, must } = LEGAL[kind];
  const view = page.locator("#view-legal");
  ok(`${kind} (${where}): legal view is visible`, await view.isVisible());
  const text = (await view.innerText().catch(() => "")) || "";
  ok(`${kind} (${where}): title "${title}"`, text.includes(title));
  const absent = must.filter((s) => !text.includes(s));
  ok(`${kind} (${where}): all required details present`, absent.length === 0, `missing: ${absent.join(", ")}`);
  const box = await view.boundingBox();
  ok(`${kind} (${where}): text takes up real space on screen`, (box?.height || 0) > 400, `height ${box?.height}`);
  const others = await page.locator(".view:not(#view-legal)").evaluateAll((els) => els.filter((e) => !e.hidden).map((e) => e.id));
  ok(`${kind} (${where}): no other view showing`, others.length === 0, others.join(", "));
  await shot(`${kind}-${where}`);
}

// Start page, signed out (Firebase can't load, so the app settles as signed out).
await page.goto(`${BASE}#/`);
await page.waitForTimeout(1500);
ok("start page is visible", await page.locator("#view-home").isVisible());
ok("start page links to the Imprint", await page.locator('a[href="#/imprint"]:visible').count() > 0);
ok("start page links to the Privacy policy", await page.locator('a[href="#/privacy"]:visible').count() > 0);
await shot("home");

// Opened directly by link (fresh load), and by navigating inside the app.
for (const kind of ["imprint", "privacy"]) {
  await page.goto(`${BASE}#/${kind}`);
  await page.waitForTimeout(1200);
  await checkLegal(kind, "signed-out");
}

// Inside the demo portfolio (signed-in layout with the tab bar).
await go("#/");
const demo = page.locator("#cta-demo");
if (await demo.isVisible()) {
  await demo.click();
  await page.waitForTimeout(1500);
  ok("demo: overview renders", await page.locator("#view-overview").isVisible());
  await shot("demo-overview");
  // map filters: behind a filter button in the head; 1D · All by default
  ok("demo: map filters folded by default", await page.locator("#ov2-map-filters").isHidden());
  await page.locator("[data-ov2-filter]").click();
  ok("demo: filter button opens the map filters", await page.locator("#ov2-map-filters").isVisible());
  ok("demo: map range defaults to 1D", (await page.locator('[data-ov2-map-range="1D"]').getAttribute("aria-checked")) === "true");
  ok("demo: map class defaults to All", (await page.locator('[data-ov2-map-type="all"]').getAttribute("aria-checked")) === "true");
  const allTiles = await page.locator("#ov2-map .ov2-tile").count();
  const cls = page.locator('[data-ov2-map-type]:not([data-ov2-map-type="all"])').first();
  if (await cls.count()) {
    await cls.click();
    await page.waitForTimeout(200);
    const n = await page.locator("#ov2-map .ov2-tile").count();
    ok("demo: map class filter narrows the map", n > 0 && n <= allTiles, `${n} of ${allTiles}`);
    await shot("demo-map-class");
    await page.locator('[data-ov2-map-type="all"]').click();
  }
  await page.locator('[data-ov2-map-range="1W"]').click();
  await page.waitForTimeout(800);
  ok("demo: map over 1W", (await page.locator("#ov2-map-title").textContent()) === "Your map" && await page.locator("#ov2-map .ov2-tile").count() > 0);
  ok("demo: filter summary shows 1W", ((await page.locator("[data-ov2-filter-sum]").textContent()) || "").includes("1W"));
  await shot("demo-map-1w");
  await page.locator('[data-ov2-map-range="1D"]').click();
  await page.locator("[data-ov2-filter]").click();
  // month by month: one row per position, 12 month columns, a readout on tap
  const hmRows = await page.locator("#ov2-months .ov2-hm__name").count();
  ok("demo: month by month has rows", hmRows > 0);
  ok("demo: month by month has 12 months", (await page.locator("#ov2-months .ov2-hm__m").count()) === 12);
  await page.locator("#ov2-months .ov2-hm__c").first().click();
  ok("demo: month cell shows a readout", ((await page.locator("#ov2-months .ov2-hm__read").textContent()) || "").includes("·"));
  await page.locator("#ov2-months").scrollIntoViewIfNeeded();
  await shot("demo-months");
  await go("#/portfolio");
  ok("demo: portfolio renders", await page.locator("#view-portfolio").isVisible());
  await shot("demo-portfolio");
  await page.locator("#user-btn").click();
  await page.locator("#settings-link").click();
  await page.waitForTimeout(400);
  ok("demo: account menu opens Settings (You page)", await page.locator("#view-you").isVisible());
  await go("#/you");
  ok("demo: You page links to the Imprint", await page.locator('#view-you a[href="#/imprint"]').isVisible());
  ok("demo: You page links to the Privacy policy", await page.locator('#view-you a[href="#/privacy"]').isVisible());
  const avgBtn = page.locator('#view-you [data-cost-method="average"]'), fifoBtn = page.locator('#view-you [data-cost-method="fifo"]');
  ok("demo: cost method defaults to moving average", (await avgBtn.getAttribute("aria-checked")) === "true");
  await fifoBtn.click();
  await page.waitForTimeout(200);
  ok("demo: cost method switches to FIFO", (await fifoBtn.getAttribute("aria-checked")) === "true" && (await avgBtn.getAttribute("aria-checked")) === "false");
  ok("demo: cost method note shown", ((await page.locator("#cost-note").textContent()) || "").length > 20);
  await shot("demo-you");
  await avgBtn.click();
  for (const kind of ["imprint", "privacy"]) await checkLegal(kind, "demo");
} else {
  ok("demo button is on the start page", false);
}

ok("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
