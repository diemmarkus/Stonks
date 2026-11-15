// Analyst consensus for US-listed companies → data/analysts.json (top lists, small) and
// data/analysts-all.json (everything, loaded by the app only for "Look up a stock").
//
// 1. Companies: all NYSE and Nasdaq listings (datasets/nyse-other-listings, datasets/nasdaq-listings),
//    without ETFs, warrants, units, rights and preferred shares (~5,000).
// 2. Runs every 2 hours and refreshes up to 400 that are due (never fetched, or older than a
//    week), within a 9-minute budget. The first fill takes about a day; after that most runs
//    find nothing due and exit without changing anything.
// 3. ISIN per company: onvista search, matched by name and share class; cached.
// 4. Ratings: Finnhub /stock/recommendation (newest month), 60 requests/minute on the free plan.
//
//   FINNHUB_API_KEY=xxx node scripts/update-analysts.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = new URL("../data/analysts.json", import.meta.url);
const OUT_ALL = new URL("../data/analysts-all.json", import.meta.url);
const NASDAQ = "https://raw.githubusercontent.com/datasets/nasdaq-listings/main/data/nasdaq-listed-symbols.csv";
const OTHER = "https://raw.githubusercontent.com/datasets/nyse-other-listings/main/data/other-listed.csv";
const PER_RUN = 400;       // ratings per run (Finnhub: 60/min → ~7 min)
const ISIN_PER_RUN = 150;  // onvista ISIN lookups per run (the rest follow on later runs)
const STALE_DAYS = 7;      // ratings change monthly; refresh each company about weekly
const BUDGET_MS = 9 * 60e3; // hard stop: whatever is left waits for the next run
const started = Date.now();
const TOP = 5;
const MIN_ANALYSTS_TOP = 15; // top/bottom lists only consider well-covered stocks
const key = process.env.FINNHUB_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!key) { console.error("FINNHUB_API_KEY is not set"); process.exit(1); }

// compact rows in analysts-all.json: [symbol, name, isin, strongBuy, buy, hold, sell, strongSell, period, fetchedAt]
const FIELDS = ["symbol", "name", "isin", "strongBuy", "buy", "hold", "sell", "strongSell", "period", "fetchedAt"];
let previous = { list: [] };
try {
  const all = JSON.parse(await readFile(OUT_ALL, "utf8"));
  previous = { isinVersion: all.isinVersion, list: all.rows.map((r) => Object.fromEntries(FIELDS.map((f, i) => [f, r[i]]))) };
} catch {
  try { const old = JSON.parse(await readFile(OUT, "utf8")); previous = { isinVersion: old.isinVersion, list: old.list || [] }; } catch {}
}
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

async function listing(url, symbolCol) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return parseCsv(await r.text()).map((x) => ({ ...x, symbol: x[symbolCol] }));
}
const SKIP = /\b(warrants?|units?|rights?|preferred|depositary shares? each representing a fraction|notes due|debentures|subordinated|trust preferred|% )/i;
const cleanName = (n) => {
  const cls = (n.match(/\bClass ([A-Z])\b/i) || [])[1];
  const base = n
    .replace(/\s+-\s+.*$/, "")                                   // "Apple Inc. - Common Stock"
    .replace(/\bClass [A-Z]\b.*$/i, "")
    .replace(/\b(Common Stock|Ordinary Shares?|Common Shares?|Capital Stock|American Depositary Shares?|ADS|Shares of Beneficial Interest)\b.*$/i, "")
    .replace(/\s{2,}/g, " ").trim().replace(/,$/, "");
  return cls ? `${base} (Class ${cls.toUpperCase()})` : base;
};
const companies = [];
const seenSym = new Set();
for (const x of [...await listing(NASDAQ, "Symbol"), ...await listing(OTHER, "ACT Symbol")]) {
  const sym = (x.symbol || "").trim();
  const name = x["Security Name"] || x["Company Name"] || "";
  if (!sym || seenSym.has(sym) || x.ETF === "Y" || x["Test Issue"] === "Y" || /[\^$~=]/.test(sym) || SKIP.test(name)) continue;
  seenSym.add(sym);
  companies.push({ symbol: sym.replace("$", "."), name: cleanName(name) || name });
}
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
  // only insist on the class letter if some hit actually carries one ("Alphabet A"/"Alphabet C");
  // single-listing companies like "Snap" have none
  const anyClass = cls && hits.some((h) => new RegExp(`(^|\\s)[A-C](\\s|$|\\))`).test(h.name || "") && words(h.name || "")[0] === want[0]);
  let best = null, bestScore = 0;
  for (const h of hits) {
    if (!h.isin || /\b(CDR|ADR|GDR)\b/.test(h.name || "")) continue;
    const got = words(h.name || "");
    // first significant word must match ("ExxonMobil" ≈ "Exxon Mobil" also counts)
    const joinedW = want.join(""), joinedG = got.join("");
    const sameStart = got[0] === want[0] || joinedG.startsWith(joinedW) || joinedW.startsWith(joinedG) || joinedG.startsWith(want[0]);
    if (!got.length || !sameStart) continue;
    const hasClass = cls && new RegExp(`(^|\\s)${cls}(\\s|$|\\))`).test(h.name);
    if (cls && anyClass && !hasClass) continue; // share classes must match (GOOG = Alphabet C)
    let score = 10 + want.filter((w) => got.includes(w)).length;
    if (/^US/.test(h.isin)) score += 3;
    if (hasClass) score += 5;
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

async function onvistaIsin(c) {
  const plain = c.name.replace(/\(.*?\)/g, "").trim();
  const cleaned = words(c.name).join(" ");
  for (const q of [...new Set([cleaned, plain, c.symbol])]) {
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

const prevBySym = new Map((previous.list || []).map((r) => [r.symbol, r]));
// due: never fetched, or older than a week; never fetched first, then the oldest
const today = new Date().toISOString().slice(0, 10);
const staleBefore = new Date(Date.now() - STALE_DAYS * 864e5).toISOString().slice(0, 10);
const due = companies.filter((c) => (prevBySym.get(c.symbol)?.fetchedAt || "") < staleBefore)
  .sort((x, y) => (prevBySym.get(x.symbol)?.fetchedAt || "").localeCompare(prevBySym.get(y.symbol)?.fetchedAt || ""));
if (!due.length) { console.log("Nothing due — all ratings are less than a week old."); process.exit(0); }
const batch = new Set(due.slice(0, PER_RUN).map((c) => c.symbol));
console.log(`Due: ${due.length}, this run: ${batch.size}`);

const list = [];
let newIsins = 0, noRating = 0, fetched = 0, isinTries = 0;
for (const c of companies) {
  const old = prevBySym.get(c.symbol);
  if (!batch.has(c.symbol)) {
    if (old) list.push({ ...old, name: c.name, isin: old.isin || knownIsin[c.symbol] || null });
    continue;
  }
  if (Date.now() - started > BUDGET_MS) { if (old) list.push(old); continue; } // out of time: next run
  let isin = knownIsin[c.symbol] || old?.isin || null;
  if (!isin && isinTries < ISIN_PER_RUN) { isinTries++; isin = await onvistaIsin(c); if (isin) newIsins++; }
  try {
    const r = await recommendation(c.symbol);
    fetched++;
    const sb = r?.strongBuy || 0, b = r?.buy || 0, h = r?.hold || 0, se = r?.sell || 0, ss = r?.strongSell || 0;
    if (r && sb + b + h + se + ss) {
      list.push({ symbol: c.symbol, name: c.name, isin, strongBuy: sb, buy: b, hold: h, sell: se, strongSell: ss, period: r.period, fetchedAt: today });
    } else {
      noRating++;
      list.push({ symbol: c.symbol, name: c.name, isin, strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, period: null, fetchedAt: today }); // remember we checked
    }
  } catch (e) {
    console.warn(`${c.symbol}: ${e.message}`);
    if (old) list.push(old);
  }
  await sleep(1100);
}
for (const r of list) {
  r.total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
  r.score = r.total ? Math.round(((2 * r.strongBuy + r.buy - r.sell - 2 * r.strongSell) / r.total) * 100) / 100 : null;
}

if (fetched < 50 && !previous.list.length) { console.error(`Only ${fetched} ratings fetched — keeping the previous file.`); process.exit(1); }

const rated = list.filter((r) => r.total > 0);
const ranked = rated.filter((r) => r.total >= MIN_ANALYSTS_TOP).sort((a, b) => b.score - a.score || b.total - a.total);
// The same ISIN on two companies means one match is wrong: drop it from both rather than mislead.
const byIsin = {};
for (const r of list) if (r.isin) (byIsin[r.isin] ||= []).push(r);
const shared = Object.entries(byIsin).filter(([, v]) => v.length > 1);
for (const [, rows] of shared) for (const r of rows) r.isin = null;
if (shared.length) console.log(`Shared ISINs dropped: ${shared.map(([i, v]) => `${i}=${v.map((r) => r.symbol).join("/")}`).join(", ")}`);

const strip = ({ fetchedAt, ...r }) => r;
const data = {
  isinVersion: ISIN_VERSION,
  updatedAt: new Date().toISOString(),
  period: rated.map((r) => r.period).filter(Boolean).sort().at(-1),
  count: rated.length,
  buys: ranked.slice(0, TOP).map(strip),
  sells: ranked.slice(-TOP).reverse().map(strip),
};
const all = {
  isinVersion: ISIN_VERSION,
  updatedAt: data.updatedAt,
  fields: FIELDS,
  rows: list.sort((a, b) => a.name.localeCompare(b.name)).map((r) => FIELDS.map((f) => r[f] ?? null)),
};
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data) + "\n");
await writeFile(OUT_ALL, JSON.stringify(all) + "\n");
console.log(`Fetched ${fetched} (${newIsins} new ISINs, ${noRating} without rating); ${rated.length} rated of ${list.length} known; files ${JSON.stringify(data).length >> 10} KB + ${JSON.stringify(all).length >> 10} KB`);
console.log(`Top: ${data.buys.map((r) => `${r.symbol} ${r.score}`)} · weakest: ${data.sells.map((r) => `${r.symbol} ${r.score}`)}`);
