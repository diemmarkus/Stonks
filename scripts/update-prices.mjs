// Crypto prices (CoinGecko) and the EUR/USD rate (ECB via frankfurter.app) → data/prices.json.
// Stock, ETF and certificate prices are fetched in the browser from onvista.
//
//   node scripts/update-prices.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { CRYPTO, lookupCrypto } from "../js/crypto.js";

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

// Your holdings are priced in the browser (straight from onvista), so nothing here reveals
// which securities anyone holds. This job only keeps crypto prices and the EUR/USD rate.
const byIsin = {};
const failed = [];

// Crypto: all coins flatex lists, one CoinGecko request.
try {
  const coins = await lookupCrypto(Object.keys(CRYPTO), { headers: { "User-Agent": UA } });
  Object.assign(byIsin, coins);
  console.log(`Crypto: ${Object.keys(coins).length} coins priced`);
} catch (e) {
  console.warn(`Crypto: ${e.message}`);
  for (const code of Object.keys(CRYPTO)) if (prevByIsin[code]) byIsin[code] = prevByIsin[code];
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
