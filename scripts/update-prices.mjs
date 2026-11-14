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
import { lookupIsin } from "../js/onvista.js";

const OUT = new URL("../data/prices.json", import.meta.url);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const q = await lookupIsin(isin, { headers: { "User-Agent": UA } });
    if (!q) { failed.push(isin); console.warn(`${isin}: no price found`); continue; }
    if (q.name === isin && meta.name) q.name = meta.name;
    byIsin[isin] = q;
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
