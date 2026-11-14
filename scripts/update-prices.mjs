// Prices for the ISINs people hold, in EUR.
//
// 1. Reads the ISINs from the public `symbols` collection in Firestore
//    (doc id = ISIN, written by the app when a holding is saved).
// 2. Looks each ISIN up on onvista (name, type, ticker) and takes the EUR quote,
//    preferring Xetra, then Tradegate.
// 3. Writes data/prices.json, which the portfolio and overview read.
//
//   node scripts/update-prices.mjs
//   node scripts/update-prices.mjs IE00BK5BQT80 US0378331005   (extra ISINs, handy for testing)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { firebaseConfig } from "../js/firebase-config.js";

const OUT = new URL("../data/prices.json", import.meta.url);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

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

// --- onvista (fallback): ISIN → EUR price + change today ---------------------
function pickQuote(obj) {
  // Walk the snapshot and find the first object that looks like a EUR quote.
  const seen = new Set();
  const stack = [obj];
  const found = [];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (typeof o.last === "number" && (o.isoCurrency === "EUR" || o.unitType === "EUR" || o.currency === "EUR" || !o.isoCurrency)) found.push(o);
    for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
  }
  // Prefer Xetra, then Tradegate, then anything with a previous close.
  const rank = (q) => {
    const m = `${q.market?.name || ""} ${q.market?.codeMarket || ""}`.toLowerCase();
    return m.includes("xetra") ? 0 : m.includes("tradegate") ? 1 : q.previousLast != null ? 2 : 3;
  };
  return found.sort((a, b) => rank(a) - rank(b))[0] || null;
}

async function onvista(isin) {
  const s = await fetch(`https://api.onvista.de/api/v1/instruments/search/facet?searchValue=${isin}`, { headers: { "User-Agent": UA } });
  if (!s.ok) throw new Error(`onvista search HTTP ${s.status}`);
  const body = await s.json();
  const hits = (body.facets || []).flatMap((f) => f.results || []);
  const hit = hits.find((h) => h.isin === isin) || hits[0];
  if (!hit) return null;
  const kind = { STOCK: "stocks", FUND: "funds", ETF: "funds", BOND: "bonds" }[hit.entityType] || "stocks";
  const r = await fetch(`https://api.onvista.de/api/v1/${kind}/ISIN:${isin}/snapshot`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`onvista snapshot HTTP ${r.status}`);
  const snap = await r.json();
  const q = pickQuote(snap);
  if (!q) { console.warn(`${isin}: onvista snapshot keys ${Object.keys(snap).join(",")}`); return null; }
  const price = q.last;
  const prevClose = q.previousLast ?? (q.performance != null ? price - q.performance : null);
  const change = q.performance ?? (prevClose != null ? price - prevClose : 0);
  const changePct = q.performancePct ?? (prevClose ? (change / prevClose) * 100 : 0);
  const venue = q.market?.name || "onvista";
  const tv = hit.symbol && /xetra/i.test(venue) ? `XETR:${hit.symbol}` : hit.symbol && /tradegate/i.test(venue) ? `XETR:${hit.symbol}` : "";
  return { price, change, changePct, name: hit.name, type: /FUND|ETF/.test(hit.entityType) ? "etf" : "stock", venue, tv };
}

async function eurUsd(previous) {
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD");
    if (r.ok) return (await r.json()).rates.USD;
    console.warn(`frankfurter: HTTP ${r.status}`);
  } catch (e) { console.warn(`frankfurter: ${e.message}`); }
  return previous ?? null;
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
  const prev = prevByIsin[isin] || {};
  try {
    const q = await onvista(isin);
    if (!q) { failed.push(isin); console.warn(`${isin}: no price found`); continue; }
    byIsin[isin] = {
      isin,
      name: q.name || meta.name || isin,
      type: q.type || meta.type || "stock",
      tv: q.tv,
      venue: q.venue,
      currency: "EUR",
      price: round(q.price),
      change: round(q.change),
      changePct: round(q.changePct, 2),
    };
    console.log(`${isin} ${q.name} €${q.price.toFixed(2)} ${q.changePct.toFixed(2)}% ${q.venue} ${q.tv}`);
  } catch (e) {
    console.warn(`${isin}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
    if (prev.price != null) byIsin[isin] = prev; // keep the last known price
    else failed.push(isin);
  }
  await sleep(400);
}

const fx = { USD: await eurUsd(previous.fx?.USD) };

const payload = { byIsin, failed, fx };
const same = JSON.stringify(payload) === JSON.stringify({ byIsin: previous.byIsin, failed: previous.failed, fx: previous.fx });
if (same) {
  console.log("No price changes, leaving prices.json as is.");
} else {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: "onvista", ...payload }, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(byIsin).length} prices, ${failed.length} unresolved.`);
}
