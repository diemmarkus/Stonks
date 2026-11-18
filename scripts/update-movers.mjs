// Fetches daily quotes for the watchlist from Finnhub and writes data/movers.json.
// Run by .github/workflows/update-movers.yml — the API key stays in GitHub Secrets
// and never reaches the browser.
//
//   FINNHUB_API_KEY=xxx node scripts/update-movers.mjs
//   node scripts/update-movers.mjs --sample      (writes made-up demo data)

import { writeFile, mkdir } from "node:fs/promises";
import { STOCKS, ETFS } from "./watchlist.mjs";

const OUT = new URL("../data/movers.json", import.meta.url);
const TOP_N = 3;
const sample = process.argv.includes("--sample");
const key = process.env.FINNHUB_API_KEY;

if (!sample && !key) {
  console.error("FINNHUB_API_KEY is not set");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function quote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const q = await res.json(); // { c: current, d: change, dp: change %, pc: previous close, t: unix time }
    if (!q || !q.c || q.dp == null) return null;
    return { price: q.c, change: q.d, changePct: q.dp, time: q.t };
  }
  throw new Error(`${symbol}: rate limited`);
}

function fakeQuote() {
  const price = 20 + Math.random() * 600;
  const changePct = (Math.random() - 0.5) * 2 * (1 + Math.random() * 4);
  return { price, change: (price * changePct) / 100, changePct, time: Math.floor(Date.now() / 1000) };
}

async function collect(list, kind) {
  const out = [];
  for (const [symbol, name] of list) {
    try {
      const q = sample ? fakeQuote() : await quote(symbol);
      if (q) out.push({ symbol, name, kind, price: round(q.price), change: round(q.change), changePct: round(q.changePct), time: q.time });
      else console.warn(`no data for ${symbol}`);
    } catch (e) {
      console.warn(String(e.message || e));
    }
    if (!sample) await sleep(1100); // free plan: 60 calls/minute
  }
  return out;
}

// --- longer ranges (1W, 1M, 6M, 1Y, 5Y, All) from onvista's history ----------------
// A bare ticker search on onvista finds the wrong things ("NVDA" → a Nvidia bond), so we search
// by name and keep the US listing whose price matches Finnhub's. Found listings are cached.
const OV = "https://api.onvista.de/api/v1";
const US_HOME = /nasdaq|nyse|new york|amex|arca|cboe|bats/i;
const SNAP_PATH = { STOCK: "stocks", FUND: "funds", ETF: "funds" };
const RANGES = { "1W": { days: 7 }, "1M": { months: 1 }, "6M": { months: 6 }, "1Y": { years: 1 }, "5Y": { years: 5 } };
const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

async function ovSource(symbol, name, price) {
  const search = async (q) => ((await getJson(`${OV}/instruments/search/facet?searchValue=${encodeURIComponent(q)}`)).facets || []).flatMap((f) => f.results || []);
  const seen = new Set();
  const hits = [...(await search(name)), ...(await search(symbol))]
    .filter((h) => SNAP_PATH[h.entityType] && h.isin && !/\(CDR\)/.test(h.name || "") && !seen.has(h.isin) && seen.add(h.isin));
  for (const h of hits.slice(0, 6)) {
    try {
      const snap = await getJson(`${OV}/${SNAP_PATH[h.entityType]}/ISIN:${h.isin}/snapshot`);
      const us = (snap.quoteList?.list || []).find((q) => q.market?.idNotation && q.isoCurrency === "USD" && US_HOME.test(q.market.name || "") && q.last > price * 0.8 && q.last < price * 1.25);
      if (us && snap.instrument?.entityValue) return { type: snap.instrument.entityType, id: snap.instrument.entityValue, notation: us.market.idNotation };
    } catch {}
  }
  return null;
}

async function performance(src, price) {
  const start = new Date(); start.setFullYear(start.getFullYear() - 5); start.setDate(start.getDate() - 10);
  const p = new URLSearchParams({ chartType: "PRICE", interval: "Y5", resolution: "1D", startDate: start.toISOString().slice(0, 10), idNotation: src.notation, withEarnings: "false" });
  const d = await getJson(`${OV}/instruments/${src.type}/${src.id}/simple_chart_history?${p}`);
  const [ts, vs] = Array.isArray(d.tick) ? [d.datetimeTick, d.tick] : [d.datetimeLast || [], d.last || []];
  const pts = ts.map((t, i) => ({ t: t < 1e11 ? t * 1000 : t, v: vs[i] })).filter((x) => x.v > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const out = {};
  for (const [r, back] of Object.entries(RANGES)) {
    const at = new Date();
    if (back.days) at.setDate(at.getDate() - back.days);
    if (back.months) at.setMonth(at.getMonth() - back.months);
    if (back.years) at.setFullYear(at.getFullYear() - back.years);
    const before = pts.filter((x) => x.t <= at.getTime()).at(-1);
    // no price from back then (listed later): leave that range out
    if (before && at.getTime() - before.t < 10 * 864e5) out[r] = round((price / before.v - 1) * 100);
  }
  return out;
}

async function addPerformance(items, cache) {
  let found = 0;
  for (const q of items) {
    try {
      let src = cache[q.symbol];
      if (!src) { src = await ovSource(q.symbol, q.name, q.price); if (src) cache[q.symbol] = src; }
      if (!src) continue;
      const perf = await performance(src, q.price);
      // All: against the first price onvista has; that never changes, so it's fetched once and cached
      if (src.first == null) {
        try {
          const d = await getJson(`${OV}/instruments/${src.type}/${src.id}/simple_chart_history?${new URLSearchParams({ chartType: "PRICE", interval: "MAX", idNotation: src.notation, withEarnings: "false" })}`);
          const vs = (Array.isArray(d.tick) ? d.tick : d.last || []).filter((v) => v > 0);
          src.first = vs.length ? vs[0] : 0;
        } catch { /* try again next run */ }
      }
      if (perf && src.first > 0) perf.All = round((q.price / src.first - 1) * 100);
      if (perf) { q.perf = perf; found++; }
    } catch (e) { console.warn(`${q.symbol}: history ${e.message}`); }
  }
  console.log(`Longer ranges for ${found} of ${items.length}`);
}

function rank(items) {
  const sorted = [...items].sort((a, b) => b.changePct - a.changePct);
  const strip = ({ symbol, name, price, change, changePct }) => ({ symbol, name, price, change, changePct });
  return {
    gainers: sorted.filter((i) => i.changePct > 0).slice(0, TOP_N).map(strip),
    losers: sorted.filter((i) => i.changePct < 0).reverse().slice(0, TOP_N).map(strip),
  };
}


const stocks = await collect(STOCKS, "stock");
const etfs = await collect(ETFS, "etf");

const known = new Set([...STOCKS, ...ETFS].map(([s]) => s));
const extra = []; // no public list of held tickers anymore
const tracked = [];
for (const [symbol, name, kind] of extra) tracked.push(...(await collect([[symbol, name]], kind)));
if (extra.length) console.log(`Tracked symbols: ${extra.length} requested, ${tracked.length} priced`);

// Analyst ratings now come from scripts/update-analysts.mjs (all S&P 500 companies, daily).
let previous = {};
try { previous = JSON.parse(await (await import("node:fs/promises")).readFile(OUT, "utf8")); } catch {}

const sources = { ...(previous.sources || {}) };
if (!sample) await addPerformance([...stocks, ...etfs], sources);

if (stocks.length + etfs.length < 10) {
  console.error("Too few quotes received — keeping the previous file.");
  process.exit(1);
}

const latest = Math.max(...[...stocks, ...etfs].map((q) => q.time || 0));
const data = {
  updatedAt: new Date().toISOString(),
  marketTime: latest ? new Date(latest * 1000).toISOString() : null,
  source: sample ? "sample" : "Finnhub",
  sample,
  stocks: rank(stocks),
  etfs: rank(etfs),
  quotes: [...stocks, ...etfs].map(({ symbol, name, kind, price, change, changePct, perf }) => ({ symbol, name, kind, price, change, changePct, ...(perf ? { perf } : {}) })),
  sources, // onvista listing per ticker (for the 1W … All changes), with its first price
  tracked: tracked.map(({ symbol, name, kind, price, change, changePct }) => ({ symbol, name, kind, price, change, changePct })),
};

if (!sample && JSON.stringify([previous.quotes, previous.tracked]) === JSON.stringify([data.quotes, data.tracked])) {
  console.log("Quotes unchanged, leaving movers.json as is.");
  process.exit(0);
}
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
console.log(`Wrote ${data.quotes.length} quotes · stocks ↑${data.stocks.gainers.map((g) => g.symbol)} ↓${data.stocks.losers.map((g) => g.symbol)} · etfs ↑${data.etfs.gainers.map((g) => g.symbol)} ↓${data.etfs.losers.map((g) => g.symbol)}`);
