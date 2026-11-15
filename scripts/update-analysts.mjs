// Analyst consensus for all S&P 500 companies → data/analysts.json (runs once a day).
//
// 1. Company list: datasets/s-and-p-500-companies (GitHub, public CSV).
// 2. ISIN per company: onvista search by ticker (then by name); cached in the output file.
// 3. Ratings: Finnhub /stock/recommendation (newest month), 60 requests/minute on the free plan.
// The app searches this file by name, ticker or ISIN, and shows the strongest/weakest 5.
//
//   FINNHUB_API_KEY=xxx node scripts/update-analysts.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = new URL("../data/analysts.json", import.meta.url);
const CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const TOP = 5;
const MIN_ANALYSTS_TOP = 15; // top/bottom lists only consider well-covered stocks
const key = process.env.FINNHUB_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!key) { console.error("FINNHUB_API_KEY is not set"); process.exit(1); }

let previous = {};
try { previous = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const ISIN_VERSION = 2; // bump to re-resolve all ISINs
const knownIsin = previous.isinVersion === ISIN_VERSION
  ? Object.fromEntries((previous.list || []).filter((r) => r.isin).map((r) => [r.symbol, r.isin]))
  : {};

// --- company list -----------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (c === "," && !quoted) { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const csvRes = await fetch(CSV);
if (!csvRes.ok) { console.error(`Company list: HTTP ${csvRes.status}`); process.exit(1); }
const companies = parseCsv(await csvRes.text())
  .map((r) => ({ symbol: r.Symbol, name: r.Security, sector: r["GICS Sector"] }))
  .filter((c) => c.symbol && c.name);
console.log(`Companies: ${companies.length}`);

// --- ISIN via onvista ---------------------------------------------------------
// onvista's search also matches German ticker symbols ("MO", "MA" find other companies),
// so a hit only counts if its name matches the company's name.
const STOP = new Set(["inc", "corp", "corporation", "co", "company", "companies", "ltd", "plc", "holdings", "holding", "group", "the", "class", "and", "of", "incorporated", "nv", "sa", "se", "ag", "lp", "trust", "international", "technologies"]);
const words = (name) => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\(.*?\)/g, " ")
  .replace(/[^a-z0-9& ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const classOf = (name) => (name.match(/\(Class ([A-Z])\)/) || [])[1] || null;

function bestHit(c, hits) {
  const want = words(c.name);
  if (!want.length) return null;
  const cls = classOf(c.name);
  let best = null, bestScore = 0;
  for (const h of hits) {
    if (!h.isin || /\b(CDR|ADR|GDR)\b/.test(h.name || "")) continue;
    const got = words(h.name || "");
    if (got[0] !== want[0]) continue; // first significant word must match
    let score = 10 + want.filter((w) => got.includes(w)).length;
    if (/^US/.test(h.isin)) score += 3;
    if (cls) score += new RegExp(`(^|\\s)${cls}(\\s|$|\\))`).test(h.name) ? 5 : -2;
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

async function onvistaIsin(c) {
  const plain = c.name.replace(/\(.*?\)/g, "").trim();
  for (const q of [plain, c.symbol]) {
    try {
      const r = await fetch(`https://api.onvista.de/api/v1/instruments/search/facet?searchValue=${encodeURIComponent(q)}`);
      if (r.ok) {
        const hits = ((await r.json()).facets || []).filter((f) => f.type === "STOCK").flatMap((f) => f.results || []);
        const h = bestHit(c, hits);
        if (h) return h.isin;
      }
    } catch {}
    await sleep(200);
  }
  return null;
}

// --- Finnhub recommendation ---------------------------------------------------------
async function recommendation(symbol, attempt = 1) {
  const res = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (res.status === 429 && attempt <= 3) { await sleep(5000 * attempt); return recommendation(symbol, attempt + 1); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) && list.length ? list[0] : null;
}

const list = [];
let newIsins = 0, noRating = 0;
for (const c of companies) {
  let isin = knownIsin[c.symbol] || null;
  if (!isin) { isin = await onvistaIsin(c); if (isin) newIsins++; }
  try {
    const r = await recommendation(c.symbol);
    if (r) {
      const sb = r.strongBuy || 0, b = r.buy || 0, h = r.hold || 0, se = r.sell || 0, ss = r.strongSell || 0;
      const total = sb + b + h + se + ss;
      if (total) {
        list.push({ symbol: c.symbol, name: c.name, isin, sector: c.sector, period: r.period, strongBuy: sb, buy: b, hold: h, sell: se, strongSell: ss, total,
          score: Math.round(((2 * sb + b - se - 2 * ss) / total) * 100) / 100 });
      } else noRating++;
    } else noRating++;
  } catch (e) {
    console.warn(`${c.symbol}: ${e.message}`);
    const old = (previous.list || []).find((x) => x.symbol === c.symbol);
    if (old) list.push(old); // keep yesterday's rating
  }
  await sleep(1100);
}

if (list.length < 100) { console.error(`Only ${list.length} ratings — keeping the previous file.`); process.exit(1); }

const ranked = list.filter((r) => r.total >= MIN_ANALYSTS_TOP).sort((a, b) => b.score - a.score || b.total - a.total);
// The same ISIN on two companies means one match is wrong: drop it from both rather than mislead.
const byIsin = {};
for (const r of list) if (r.isin) (byIsin[r.isin] ||= []).push(r);
const shared = Object.entries(byIsin).filter(([, v]) => v.length > 1);
for (const [, rows] of shared) for (const r of rows) r.isin = null;
if (shared.length) console.log(`Shared ISINs dropped: ${shared.map(([i, v]) => `${i}=${v.map((r) => r.symbol).join("/")}`).join(", ")}`);

const data = {
  isinVersion: ISIN_VERSION,
  updatedAt: new Date().toISOString(),
  period: list.map((r) => r.period).sort().at(-1),
  count: list.length,
  buys: ranked.slice(0, TOP),
  sells: ranked.slice(-TOP).reverse(),
  list: list.sort((a, b) => a.name.localeCompare(b.name)),
};
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data) + "\n");
console.log(`Wrote ${list.length} ratings (${newIsins} new ISINs, ${list.filter((r) => !r.isin).length} without ISIN, ${noRating} without rating)`);
console.log(`Top: ${data.buys.map((r) => `${r.symbol} ${r.score}`)} · weakest: ${data.sells.map((r) => `${r.symbol} ${r.score}`)}`);
