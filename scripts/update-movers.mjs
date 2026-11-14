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

// ---- Analyst consensus (Finnhub /stock/recommendation), refreshed at most once a day ----
// Ratings are analysts' 12-month views; we show the 3 strongest and 3 weakest consensus.
let previous = {};
try { previous = JSON.parse(await (await import("node:fs/promises")).readFile(OUT, "utf8")); } catch {}

async function recommendation(symbol) {
  const res = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (res.status === 429) { await sleep(5000); return recommendation(symbol); }
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) && list.length ? list[0] : null; // newest period first
}

async function analysts() {
  const fresh = previous.analysts?.updatedAt && Date.now() - Date.parse(previous.analysts.updatedAt) < 20 * 3600e3;
  if (sample || fresh) return previous.analysts || null;
  const rows = [];
  for (const [symbol, name] of STOCKS) {
    try {
      const r = await recommendation(symbol);
      if (r) {
        const sb = r.strongBuy || 0, b = r.buy || 0, h = r.hold || 0, se = r.sell || 0, ss = r.strongSell || 0;
        const total = sb + b + h + se + ss;
        // score from -2 (all strong sell) to +2 (all strong buy)
        if (total >= 8) rows.push({ symbol, name, period: r.period, strongBuy: sb, buy: b, hold: h, sell: se, strongSell: ss, total, score: Math.round(((2 * sb + b - se - 2 * ss) / total) * 100) / 100 });
      }
    } catch (e) { console.warn(`analysts ${symbol}: ${e.message}`); }
    await sleep(1100);
  }
  if (rows.length < 6) return previous.analysts || null;
  const sorted = [...rows].sort((a, b) => b.score - a.score || b.total - a.total);
  return {
    updatedAt: new Date().toISOString(),
    period: rows.map((r) => r.period).sort().at(-1),
    buys: sorted.slice(0, TOP_N),
    sells: sorted.slice(-TOP_N).reverse(),
    count: rows.length,
  };
}
const analystData = await analysts();
if (analystData) console.log(`Analysts: buy ${analystData.buys.map((r) => `${r.symbol} ${r.score}`)} · weakest ${analystData.sells.map((r) => `${r.symbol} ${r.score}`)}`);

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
  quotes: [...stocks, ...etfs].map(({ symbol, name, kind, price, change, changePct }) => ({ symbol, name, kind, price, change, changePct })),
  tracked: tracked.map(({ symbol, name, kind, price, change, changePct }) => ({ symbol, name, kind, price, change, changePct })),
  analysts: analystData,
};

if (!sample && JSON.stringify([previous.quotes, previous.tracked, previous.analysts]) === JSON.stringify([data.quotes, data.tracked, data.analysts])) {
  console.log("Quotes unchanged, leaving movers.json as is.");
  process.exit(0);
}
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
console.log(`Wrote ${data.quotes.length} quotes · stocks ↑${data.stocks.gainers.map((g) => g.symbol)} ↓${data.stocks.losers.map((g) => g.symbol)} · etfs ↑${data.etfs.gainers.map((g) => g.symbol)} ↓${data.etfs.losers.map((g) => g.symbol)}`);
