// ISIN → name, type, chart ticker and the latest EUR quote (Xetra preferred), from onvista.
// Shared by the browser (instant prices for newly added ISINs) and scripts/update-prices.mjs.
// onvista's API allows cross-origin requests, so the browser can call it directly.

function pickQuote(obj) {
  // Walk the snapshot and collect everything that looks like a EUR quote.
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

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export async function lookupIsin(isin, fetchOpts = {}) {
  const s = await fetch(`https://api.onvista.de/api/v1/instruments/search/facet?searchValue=${isin}`, fetchOpts);
  if (!s.ok) throw new Error(`onvista search HTTP ${s.status}`);
  const body = await s.json();
  const hits = (body.facets || []).flatMap((f) => f.results || []);
  const hit = hits.find((h) => h.isin === isin) || hits[0];
  if (!hit) return null;
  const kind = { STOCK: "stocks", FUND: "funds", ETF: "funds", BOND: "bonds" }[hit.entityType] || "stocks";
  const r = await fetch(`https://api.onvista.de/api/v1/${kind}/ISIN:${isin}/snapshot`, fetchOpts);
  if (!r.ok) throw new Error(`onvista snapshot HTTP ${r.status}`);
  const q = pickQuote(await r.json());
  if (!q) return null;
  const price = q.last;
  const prevClose = q.previousLast ?? (q.performance != null ? price - q.performance : null);
  const change = q.performance ?? (prevClose != null ? price - prevClose : 0);
  const changePct = q.performancePct ?? (prevClose ? (change / prevClose) * 100 : 0);
  const venue = q.market?.name || "onvista";
  const tv = hit.symbol && /xetra|tradegate/i.test(venue) ? `XETR:${hit.symbol}` : "";
  return {
    isin,
    name: hit.name || isin,
    type: /FUND|ETF/.test(hit.entityType) ? "etf" : "stock",
    tv,
    venue,
    currency: "EUR",
    price: round(price),
    change: round(change),
    changePct: round(changePct, 2),
  };
}
