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
  // Prefer gettex (trades 8–22h; flatex values your depot with its prices), then Xetra,
  // then Tradegate, then anything with a previous close.
  const rank = (q) => {
    const m = `${q.market?.name || ""} ${q.market?.codeMarket || ""}`.toLowerCase();
    return m.includes("gettex") ? 0 : m.includes("xetra") ? 1 : m.includes("tradegate") ? 2 : q.previousLast != null ? 3 : 4;
  };
  return found.sort((a, b) => rank(a) - rank(b))[0] || null;
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export async function lookupIsin(isin, fetchOpts = {}) {
  const s = await fetch(`https://api.onvista.de/api/v1/instruments/search/facet?searchValue=${isin}`, fetchOpts);
  if (!s.ok) throw new Error(`onvista search HTTP ${s.status}`);
  const body = await s.json();
  const hits = (body.facets || []).flatMap((f) => f.results || []);
  // ETCs and some other products aren't in the search index, so without a hit we just try the endpoints.
  const hit = hits.find((h) => h.isin === isin) || hits[0] || {};
  const byType = { STOCK: "stocks", FUND: "funds", ETF: "funds", BOND: "bonds", DERIVATIVE: "derivatives" };
  const first = byType[hit.entityType] || "stocks";
  const kinds = [first, ...["funds", "stocks", "derivatives", "bonds"].filter((k) => k !== first)];
  let q = null, instrument = null, snapUsed = null;
  for (const kind of kinds) {
    const r = await fetch(`https://api.onvista.de/api/v1/${kind}/ISIN:${isin}/snapshot`, fetchOpts);
    if (!r.ok) continue;
    const snap = await r.json();
    q = pickQuote(snap);
    instrument = snap.instrument || null;
    snapUsed = snap;
    if (q) break;
  }
  if (!q) return null;
  const price = q.last;
  const prevClose = q.previousLast ?? (q.performance != null ? price - q.performance : null);
  const change = q.performance ?? (prevClose != null ? price - prevClose : 0);
  const changePct = q.performancePct ?? (prevClose ? (change / prevClose) * 100 : 0);
  const venue = q.market?.name || "onvista";
  const symbol = hit.symbol || instrument?.symbol;
  const tv = symbol && /xetra|tradegate|gettex/i.test(venue) ? `XETR:${symbol}` : "";
  const entityType = hit.entityType || instrument?.entityType || "";
  return {
    isin,
    name: hit.name || instrument?.name || isin,
    // ETCs/ETNs (e.g. physical gold) are certificates in onvista's DERIVATIVE category
    type: /DERIVATIVE|CERTIFICATE/.test(entityType) ? "certificate" : /FUND|ETF/.test(entityType) ? "etf" : "stock",
    tv,
    venue,
    currency: "EUR",
    price: round(price),
    change: round(change),
    changePct: round(changePct, 2),
    quotes: venueQuotes(snapUsed),
  };
}

// Every EUR exchange with a price, so you can value a position like your broker does.
function venueQuotes(snap) {
  const out = [];
  const seen = new Set();
  for (const v of snap?.quoteList?.list || []) {
    const name = v.market?.name;
    if (!name || v.isoCurrency !== "EUR" || typeof v.last !== "number" || seen.has(name)) continue;
    seen.add(name);
    const prev = typeof v.previousLast === "number" ? v.previousLast : null;
    out.push({
      venue: name,
      price: round(v.last),
      change: prev != null ? round(v.last - prev) : 0,
      changePct: prev ? round(((v.last - prev) / prev) * 100, 2) : 0,
      notation: v.market.idNotation || null,
    });
  }
  return out;
}
