// Prices for the ISINs people hold, in EUR.
//
// 1. Reads the ISINs from the public `symbols` collection in Firestore
//    (doc id = ISIN, written by the app when a holding is saved).
// 2. Resolves each ISIN to a listing via Yahoo Finance search, preferring EUR exchanges (Xetra first).
// 3. Fetches the latest price + previous close, converts to EUR if needed.
// 4. Writes data/prices.json, which the portfolio and overview read.
//
//   node scripts/update-prices.mjs
//   node scripts/update-prices.mjs IE00BK5BQT80 US0378331005   (extra ISINs, handy for testing)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { firebaseConfig } from "../js/firebase-config.js";

const OUT = new URL("../data/prices.json", import.meta.url);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// Preferred listings, best first. EUR venues before others.
const VENUES = [
  { suffix: ".DE", tv: "XETR", label: "Xetra" },
  { suffix: ".VI", tv: "VIE", label: "Vienna" },
  { suffix: ".AS", tv: "EURONEXT", label: "Amsterdam" },
  { suffix: ".PA", tv: "EURONEXT", label: "Paris" },
  { suffix: ".MI", tv: "MIL", label: "Milan" },
  { suffix: ".MC", tv: "BME", label: "Madrid" },
  { suffix: ".BR", tv: "EURONEXT", label: "Brussels" },
  { suffix: ".F", tv: "FWB", label: "Frankfurt" },
  { suffix: ".DU", tv: "DUS", label: "Düsseldorf" },
  { suffix: ".MU", tv: "MUN", label: "Munich" },
  { suffix: ".SG", tv: "SWB", label: "Stuttgart" },
  { suffix: ".SW", tv: "SIX", label: "SIX Swiss" },
  { suffix: ".L", tv: "LSE", label: "London" },
  { suffix: "", tv: "", label: "US" },
];

export function isValidIsin(isin) {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  const digits = isin.split("").map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * i); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`Gave up on ${url}`);
}

async function trackedIsins() {
  const { projectId, apiKey } = firebaseConfig;
  const out = new Map();
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/symbols?pageSize=300&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`Couldn't read symbols: HTTP ${res.status}`); break; }
    const body = await res.json();
    for (const d of body.documents || []) {
      const f = d.fields || {};
      const id = f.symbol?.stringValue;
      if (id && isValidIsin(id)) out.set(id, { type: f.type?.stringValue === "etf" ? "etf" : "stock", name: f.name?.stringValue || "" });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return out;
}

function venueOf(symbol) {
  const dot = symbol.lastIndexOf(".");
  const suffix = dot > 0 ? symbol.slice(dot) : "";
  return VENUES.find((v) => v.suffix === suffix) || null;
}

async function resolve(isin) {
  const data = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=15&newsCount=0&listsCount=0`);
  const quotes = (data.quotes || []).filter((q) => q.symbol && ["EQUITY", "ETF", "MUTUALFUND"].includes(q.quoteType));
  if (!quotes.length) return null;
  let best = null, bestRank = Infinity;
  for (const q of quotes) {
    const v = venueOf(q.symbol);
    const rank = v ? VENUES.indexOf(v) : VENUES.length;
    if (rank < bestRank) { best = q; bestRank = rank; }
  }
  const v = venueOf(best.symbol);
  const base = best.symbol.replace(/\.[A-Z]+$/, "");
  return {
    symbol: best.symbol,
    name: best.longname || best.shortname || "",
    type: best.quoteType === "ETF" || best.quoteType === "MUTUALFUND" ? "etf" : "stock",
    venue: v?.label || best.exchDisp || best.exchange || "",
    tv: v?.tv ? `${v.tv}:${base}` : base,
  };
}

async function chart(symbol) {
  const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const r = data.chart?.result?.[0];
  if (!r) return null;
  const closes = (r.indicators?.quote?.[0]?.close || []).map((c, i) => [r.timestamp?.[i], c]).filter(([, c]) => c != null);
  const price = r.meta.regularMarketPrice ?? closes.at(-1)?.[1];
  const prev = closes.length >= 2 ? closes.at(-2)[1] : r.meta.chartPreviousClose;
  if (price == null) return null;
  let currency = r.meta.currency || "EUR";
  let k = 1;
  if (currency === "GBp" || currency === "GBX") { currency = "GBP"; k = 0.01; }
  return { price: price * k, prev: prev != null ? prev * k : null, currency, time: r.meta.regularMarketTime || closes.at(-1)?.[0] || null };
}

const fxCache = new Map();
async function eurPer(currency) {
  if (currency === "EUR") return 1;
  if (!fxCache.has(currency)) {
    const c = await chart(`EUR${currency}=X`); // units of `currency` per 1 EUR
    fxCache.set(currency, c?.price || null);
  }
  return fxCache.get(currency);
}

// ---------------------------------------------------------------------------

let previous = {};
try { previous = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const prevByIsin = previous.byIsin || {};

const wanted = await trackedIsins();
for (const extra of process.argv.slice(2)) if (isValidIsin(extra)) wanted.set(extra, wanted.get(extra) || { type: "", name: "" });
console.log(`ISINs to price: ${wanted.size}`);

const byIsin = {};
const failed = [];
for (const [isin, meta] of wanted) {
  try {
    const known = prevByIsin[isin];
    const listing = known?.symbol ? known : await resolve(isin);
    if (!listing) { failed.push(isin); console.warn(`${isin}: no listing found`); continue; }
    const c = await chart(listing.symbol);
    if (!c) { failed.push(isin); console.warn(`${isin} (${listing.symbol}): no price`); continue; }
    const rate = await eurPer(c.currency);
    if (!rate) { failed.push(isin); console.warn(`${isin}: no FX rate for ${c.currency}`); continue; }
    const price = c.price / rate;
    const prev = c.prev != null ? c.prev / rate : null;
    byIsin[isin] = {
      isin,
      symbol: listing.symbol,
      tv: listing.tv,
      venue: listing.venue,
      name: listing.name || meta.name || isin,
      type: listing.type || meta.type || "stock",
      currency: "EUR",
      listingCurrency: c.currency,
      price: round(price),
      change: prev != null ? round(price - prev) : 0,
      changePct: prev ? round(((price - prev) / prev) * 100, 2) : 0,
      time: c.time,
    };
    console.log(`${isin} → ${listing.symbol} (${listing.venue}) €${price.toFixed(2)} ${byIsin[isin].changePct}%`);
  } catch (e) {
    failed.push(isin);
    console.warn(`${isin}: ${e.message}`);
    if (prevByIsin[isin]) byIsin[isin] = prevByIsin[isin]; // keep last known price
  }
  await sleep(400);
}

// Rates for older holdings that were entered in USD by ticker.
const fx = { USD: await eurPer("USD").catch(() => previous.fx?.USD ?? null) };

const payload = { byIsin, failed: failed.filter((i) => !byIsin[i]), fx };
const same = JSON.stringify(payload) === JSON.stringify({ byIsin: previous.byIsin, failed: previous.failed, fx: previous.fx });
if (same) {
  console.log("No price changes, leaving prices.json as is.");
} else {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: "Yahoo Finance", ...payload }, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(byIsin).length} prices, ${payload.failed.length} unresolved.`);
}
