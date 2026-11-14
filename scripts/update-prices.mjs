// Prices for the ISINs people hold, in EUR.
//
// 1. Reads the ISINs from the public `symbols` collection in Firestore
//    (doc id = ISIN, written by the app when a holding is saved).
// 2. Looks up name, type and Xetra ticker via OpenFIGI (free, no key needed).
// 3. Fetches the latest EUR price and today's change from Tradegate (Berlin exchange).
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

// "1.234,56" / "1234.56" / "+0,52%" / 12.3 → number
function num(v) {
  if (typeof v === "number") return v;
  if (v == null) return null;
  let s = String(v).replace(/[%\s€+]/g, "").replace(/&nbsp;/g, "");
  if (!s || s === "-" || s === "./.") return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  .replace(/\b(Etf|Ucits|Msci|Ftse|Usd|Eur|Acc|Dist|Ag|Se|Plc|Inc|Nv|Sa|Asa|Ab|Spa|Esg|S&p|Us|Uk|Em)\b/g, (w) => w.toUpperCase());

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

// --- OpenFIGI: ISIN → name, type, Xetra ticker ------------------------------
async function figi(isins) {
  const out = {};
  // 10 jobs per request without an API key; two jobs per ISIN (Xetra first, then any listing).
  for (let i = 0; i < isins.length; i += 5) {
    const chunk = isins.slice(i, i + 5);
    const jobs = chunk.flatMap((isin) => [
      { idType: "ID_ISIN", idValue: isin, exchCode: "GY" },
      { idType: "ID_ISIN", idValue: isin },
    ]);
    const res = await fetch("https://api.openfigi.com/v3/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify(jobs),
    });
    if (!res.ok) { console.warn(`OpenFIGI: HTTP ${res.status}`); await sleep(3000); continue; }
    const body = await res.json();
    chunk.forEach((isin, k) => {
      const xetra = body[2 * k]?.data?.[0];
      const any = body[2 * k + 1]?.data?.[0];
      const d = xetra || any;
      if (!d) return;
      const t = `${d.securityType || ""} ${d.securityType2 || ""}`.toUpperCase();
      out[isin] = {
        name: d.name ? titleCase(d.name) : "",
        type: /ETP|ETF|FUND|MUTUAL/.test(t) ? "etf" : "stock",
        tv: xetra?.ticker ? `XETR:${xetra.ticker}` : "",
      };
    });
    await sleep(2600); // 25 requests/minute without a key
  }
  return out;
}

// --- Tradegate: ISIN → EUR price + change today -----------------------------
async function tradegate(isin) {
  const res = await fetch(`https://www.tradegatebank.de/refresh.php?isin=${isin}`, {
    headers: { "User-Agent": UA, Accept: "application/json, text/javascript, */*", Referer: `https://www.tradegatebank.de/Handelshistorie.php?isin=${isin}` },
  });
  if (!res.ok) throw new Error(`Tradegate HTTP ${res.status}`);
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { throw new Error(`Tradegate: not JSON (${text.slice(0, 80)})`); }
  const bid = num(d.bid), ask = num(d.ask);
  const last = num(d.last);
  const price = last ?? (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask);
  if (price == null || price === 0) return null;
  const close = num(d.close);
  let changePct = num(d.delta);
  let change = null;
  if (close) { change = price - close; changePct ??= (change / close) * 100; }
  else if (changePct != null) change = price - price / (1 + changePct / 100);
  return { price, change: change ?? 0, changePct: changePct ?? 0 };
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

// Only look up static data for ISINs we haven't resolved before.
const needInfo = [...wanted.keys()].filter((i) => !prevByIsin[i]?.infoFrom);
const info = needInfo.length ? await figi(needInfo) : {};

const byIsin = {};
const failed = [];
for (const [isin, meta] of wanted) {
  const prev = prevByIsin[isin] || {};
  const i = info[isin] || {};
  const base = {
    isin,
    name: prev.name || i.name || meta.name || isin,
    type: prev.type || i.type || meta.type || "stock",
    tv: prev.tv ?? i.tv ?? "",
    venue: "Tradegate",
    currency: "EUR",
    infoFrom: prev.infoFrom || (info[isin] ? "openfigi" : undefined),
  };
  try {
    const q = await tradegate(isin);
    if (!q) { failed.push(isin); console.warn(`${isin}: no price on Tradegate`); continue; }
    byIsin[isin] = { ...base, price: round(q.price), change: round(q.change), changePct: round(q.changePct, 2) };
    console.log(`${isin} ${base.name} €${q.price.toFixed(2)} ${q.changePct.toFixed(2)}% ${base.tv}`);
  } catch (e) {
    console.warn(`${isin}: ${e.message}`);
    if (prev.price != null) byIsin[isin] = { ...prev, ...base, price: prev.price, change: prev.change, changePct: prev.changePct };
    else failed.push(isin);
  }
  await sleep(300);
}

const fx = { USD: await eurUsd(previous.fx?.USD) };

const payload = { byIsin, failed, fx };
const same = JSON.stringify(payload) === JSON.stringify({ byIsin: previous.byIsin, failed: previous.failed, fx: previous.fx });
if (same) {
  console.log("No price changes, leaving prices.json as is.");
} else {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: "Tradegate", ...payload }, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(byIsin).length} prices, ${failed.length} unresolved.`);
}
