// Our own price chart: history from onvista (stocks, ETFs, certificates) or CoinGecko (crypto),
// drawn as an SVG area chart with range buttons and a touch/mouse crosshair.
// Both APIs allow browser requests, so no third-party widget, logo or consent prompt is needed.
import { CRYPTO, isCryptoCode } from "./crypto.js?v=178";

const OV = "https://api.onvista.de/api/v1";
const RANGES = {
  // res: onvista resolution (tested: 1m, 5m, 15m, 30m, 60m, 2h, 4h are valid)
  "1D": { ov: "D1", back: { days: 6 }, cg: 1, res: "1m" },
  "1W": { ov: "W1", back: { days: 7 }, cg: 7, res: "15m" },
  "1M": { ov: "M1", back: { months: 1 }, cg: 30, res: "60m" },
  "6M": { ov: "Y1", back: { months: 6 }, cg: 180, res: "1D", trim: true }, // a year's daily history, cut to 6 months
  "1Y": { ov: "Y1", back: { years: 1 }, cg: 365, res: "1D" },
  "5Y": { ov: "Y5", back: { years: 5 }, cg: null, res: "1D" },   // default would be weekly
  "All": { ov: "MAX", back: { years: 40 }, cg: null, res: "1D" }, // default would be monthly
};
const RANGE_KEY = "stonks-chart-range";
// Price charts: "hybrid" (default: candlesticks for 1D and 1W, a line for longer ranges), "line" or
// "candles" everywhere; picked on the You page, kept on this device (not stored for the default)
export const STYLE_KEY = "stonks-chart-style";
const chartStyle = () => { try { const v = localStorage.getItem(STYLE_KEY); return v === "candles" || v === "line" ? v : "hybrid"; } catch { return "hybrid"; } };
const candlesFor = (range) => { const st = chartStyle(); return st === "candles" || (st === "hybrid" && (range === "1D" || range === "1W")); };

const iso = (d) => d.toISOString().slice(0, 10);
function startDate(back) {
  const d = new Date();
  if (back.days) d.setDate(d.getDate() - back.days);
  if (back.months) d.setMonth(d.getMonth() - back.months);
  if (back.years) d.setFullYear(d.getFullYear() - back.years);
  return iso(d);
}

/* ---------- resolving an instrument on onvista (cached) ---------- */
const sourceCache = new Map();

// `id` is an ISIN, a flatex crypto code or a US ticker (movers). `currency` picks the listing.
// `hint` ({ name, price }) is used for US tickers: onvista's search can't be trusted with a bare
// ticker ("V" finds Nvidia, "NVDA" a Nvidia bond), so we search by name and keep only a listing
// whose current US price matches the one we already show.
function resolve(id, currency, venue, hint) {
  const key = `${id}|${currency}|${venue || ""}`;
  if (!sourceCache.has(key)) {
    const run = hint?.name && !isIsin(id) && !isCryptoCode(id) ? resolveTicker(id, hint) : resolveUncached(id, currency, venue);
    sourceCache.set(key, run.catch((e) => { sourceCache.delete(key); throw e; }));
  }
  return sourceCache.get(key);
}
const isIsin = (v) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(v);
const US_HOME = /nasdaq|nyse|new york|amex|arca|cboe|bats/i;
const SNAP_PATH = { STOCK: "stocks", FUND: "funds", ETF: "funds" };

async function resolveTicker(id, { name, price }) {
  const search = async (q) => {
    const r = await fetch(`${OV}/instruments/search/facet?searchValue=${encodeURIComponent(q)}`);
    return r.ok ? ((await r.json()).facets || []).flatMap((f) => f.results || []) : [];
  };
  const [byName, byTicker] = await Promise.all([search(name), search(id)]);
  const seen = new Set();
  const candidates = [...byName, ...byTicker].filter((h) => SNAP_PATH[h.entityType] && h.isin && !/\(CDR\)/.test(h.name || "") && !seen.has(h.isin) && seen.add(h.isin));
  for (const h of candidates.slice(0, 6)) {
    const r = await fetch(`${OV}/${SNAP_PATH[h.entityType]}/ISIN:${h.isin}/snapshot`);
    if (!r.ok) continue;
    const snap = await r.json();
    const inst = snap.instrument;
    if (!inst?.entityValue) continue;
    const us = (snap.quoteList?.list || []).filter((q) => q.market?.idNotation && q.isoCurrency === "USD" && US_HOME.test(q.market.name || ""));
    const ok = us.find((q) => !price || (q.last > price * 0.8 && q.last < price * 1.25));
    if (ok) return { kind: "onvista", type: inst.entityType, id: inst.entityValue, notation: ok.market.idNotation, currency: "USD", credit: "onvista" };
  }
  throw new Error(`No onvista listing for ${id}`);
}

async function resolveUncached(id, currency, venue) {
  if (isCryptoCode(id)) return { kind: "crypto", cg: CRYPTO[id].cg, currency: "EUR", credit: "CoinGecko" };
  const s = await fetch(`${OV}/instruments/search/facet?searchValue=${encodeURIComponent(id)}`);
  const hits = s.ok ? ((await s.json()).facets || []).flatMap((f) => f.results || []) : [];
  // A ticker like "NVDA" also matches bonds, indices and leveraged products named after it:
  // only shares and funds count, the company's own share first.
  const tradable = hits.filter((h) => ["STOCK", "FUND", "ETF"].includes(h.entityType) && h.isin && !/\(CDR\)/.test(h.name || ""));
  const hit = hits.find((h) => h.isin === id)
    || tradable.find((h) => h.symbol === id)
    || (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(id) ? null : tradable.find((h) => h.entityType === "STOCK") || tradable[0])
    || hits[0] || {};
  const byType = { STOCK: "stocks", FUND: "funds", ETF: "funds", BOND: "bonds", DERIVATIVE: "derivatives" };
  const first = byType[hit.entityType] || "stocks";
  const isinOrId = hit.isin ? `ISIN:${hit.isin}` : `ISIN:${id}`;
  for (const k of [first, ...["funds", "stocks", "derivatives", "bonds"].filter((x) => x !== first)]) {
    const r = await fetch(`${OV}/${k}/${isinOrId}/snapshot`);
    if (!r.ok) continue;
    const snap = await r.json();
    const inst = snap.instrument;
    if (!inst?.entityValue) continue;
    const quotes = (snap.quoteList?.list || []).filter((q) => q.market?.idNotation);
    // same exchange as the price list: gettex first (flatex values with it), then Xetra
    const usHome = (q) => q.isoCurrency === "USD" && /nasdaq|nyse|new york|amex|arca|cboe|bats/i.test(q.market.name || "");
    const want = (q) => (currency === "USD" ? usHome(q) : /gettex/i.test(q.market.name || ""));
    const want2 = (q) => currency !== "USD" && /xetra/i.test(q.market.name || "");
    const chosen = venue && quotes.find((q) => q.market.name === venue);
    const pick = chosen || quotes.find(want) || quotes.find(want2) || quotes.find((q) => q.isoCurrency === currency) || null;
    const notation = pick?.market.idNotation || snap.chart?.idNotation || snap.quote?.market?.idNotation;
    return { kind: "onvista", type: inst.entityType, id: inst.entityValue, notation, currency: pick?.isoCurrency || currency, credit: "onvista" };
  }
  throw new Error(`No onvista instrument for ${id}`);
}

/* ---------- history ---------- */
const histCache = new Map();

async function history(src, range) {
  const key = `${src.kind}|${src.id || src.cg}|${src.notation || ""}|${range}`;
  if (histCache.has(key)) return histCache.get(key);
  const R = RANGES[range];
  let pts = [];
  if (src.kind === "crypto") {
    if (!R.cg) throw new Error("range not available");
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${src.cg}/market_chart?vs_currency=eur&days=${R.cg}`);
    if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
    pts = ((await r.json()).prices || []).map(([t, v]) => ({ t, v }));
  } else {
    const p = new URLSearchParams({ chartType: "PRICE", interval: R.ov, startDate: startDate(R.back), endDate: iso(new Date(Date.now() + 864e5)), withEarnings: "false" });
    if (src.notation) p.set("idNotation", src.notation);
    if (R.res) p.set("resolution", R.res);
    const r = await fetch(`${OV}/instruments/${src.type}/${src.id}/simple_chart_history?${p}`);
    if (!r.ok) throw new Error(`onvista HTTP ${r.status}`);
    const d = await r.json();
    // keep timestamps and prices from the same pair of arrays (tick ↔ datetimeTick, last ↔ datetimeLast)
    const ticks = Array.isArray(d.tick) && Array.isArray(d.datetimeTick);
    const [ts, vs] = ticks ? [d.datetimeTick, d.tick] : [d.datetimeLast || [], d.last || []];
    // bars also carry first / high / low (for candlesticks); only when they line up with the closes
    const ohlc = !ticks && [d.first, d.high, d.low].every((a) => Array.isArray(a) && a.length === vs.length);
    const num = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : undefined);
    pts = clean(ts.map((t, i) => (ohlc ? { t: toMs(t), v: vs[i], o: num(d.first[i]), h: num(d.high[i]), l: num(d.low[i]) } : { t: toMs(t), v: vs[i] })));
    if (R.trim) { const from = new Date(`${startDate(R.back)}T00:00:00`).getTime(); pts = pts.filter((p) => p.t >= from); }
    if (range === "1D" && pts.length) {
      // only the last trading day
      const lastDay = new Date(pts[pts.length - 1].t).toDateString();
      pts = pts.filter((p) => new Date(p.t).toDateString() === lastDay);
    }
  }
  pts = clean(pts);
  pts = thin(pts, 1500);
  histCache.set(key, pts);
  return pts;
}

// onvista timestamps come in seconds, sometimes in ms or µs: normalise to ms.
function toMs(t) {
  if (typeof t !== "number" || !isFinite(t)) return NaN;
  if (t > 1e14) return t / 1000;  // microseconds
  if (t < 1e11) return t * 1000;  // seconds
  return t;
}

// Drop broken points: impossible dates, zero/negative prices, and one-off spikes
// (a single tick far away from its neighbours, e.g. a bad print near 0).
function clean(pts) {
  const min = Date.UTC(1970, 0, 2), max = Date.now() + 2 * 864e5;
  let out = pts.filter((p) => isFinite(p.t) && p.t >= min && p.t <= max && typeof p.v === "number" && isFinite(p.v) && p.v > 0);
  out.sort((a, b) => a.t - b.t);
  out = out.filter((p, i) => i === 0 || p.t !== out[i - 1].t);
  if (out.length < 5) return out;
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  return out.filter((p, i) => {
    const nb = out.slice(Math.max(0, i - 3), i).concat(out.slice(i + 1, i + 4)).map((q) => q.v);
    const m = med(nb);
    return p.v > m * 0.4 && p.v < m * 2.5;
  });
}

// Keep long series light without losing their shape: per bucket keep the low and the high point.
function thin(pts, max) {
  if (pts.length <= max) return pts;
  const size = Math.ceil(pts.length / (max / 2));
  const out = [];
  for (let i = 0; i < pts.length; i += size) {
    const b = pts.slice(i, i + size);
    let lo = b[0], hi = b[0];
    for (const p of b) { if (p.v < lo.v) lo = p; if (p.v > hi.v) hi = p; }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t < hi.t ? [lo, hi] : [hi, lo]));
  }
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/* ---------- drawing ---------- */
// gain / loss colours come from the theme (light or dark), read when a chart is drawn
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function fmtMoney(v, currency) {
  const digits = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v).replace(/^(-?)€/, "$1€");
}
// "Today" / "Yesterday" / "Tomorrow" for dates close to now, else null
function relDay(when) {
  const d = new Date(when), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 864e5);
  return { "-1": "Yesterday", 0: "Today", 1: "Tomorrow" }[diff] || null;
}
function fmtWhen(t, range) {
  const d = new Date(t), rel = relDay(t);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (range === "1D") return rel ? `${rel} ${time}` : time;
  if (range === "1W") return rel || d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); // axis: day only
  if (range === "1W+time") return `${rel || d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`; // readout while scrubbing
  return rel || d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Points → candles: one per time bucket (15 min for 1D, 2 h for 1W, a day for 1M, a week for 1Y,
// a week for 6M, a month for 5Y, a quarter or a year for All); at most ~90, merging neighbours when there are more.
// open = the bucket's first price (or the bar's own open), close = its last, high / low = its extremes.
function toCandles(pts, range) {
  const H = 36e5, D = 864e5;
  const local = (t) => { const d = new Date(t); return d; };
  const key = {
    "1D": (t) => Math.floor(t / (15 * 6e4)),
    "1W": (t) => Math.floor(t / (2 * H)),
    "1M": (t) => local(t).toDateString(),
    "6M": (t) => Math.floor((t + 3 * D) / (7 * D)), // weeks starting Monday
    "1Y": (t) => Math.floor((t + 3 * D) / (7 * D)),
    "5Y": (t) => { const d = local(t); return d.getFullYear() * 12 + d.getMonth(); },
    "All": (t) => { const d = local(t); return pts.length && pts[pts.length - 1].t - pts[0].t > 20 * 365 * D ? d.getFullYear() : d.getFullYear() * 4 + Math.floor(d.getMonth() / 3); },
  }[range] || ((t) => Math.floor(t / D));
  let out = [];
  for (const p of pts) {
    const k = key(p.t), last = out[out.length - 1];
    const hi = Math.max(p.v, p.h ?? p.v, p.o ?? p.v), lo = Math.min(p.v, p.l ?? p.v, p.o ?? p.v);
    if (last && last.k === k) { last.c = p.v; last.h = Math.max(last.h, hi); last.l = Math.min(last.l, lo); last.t1 = p.t; }
    else out.push({ k, t: p.t, t1: p.t, o: p.o ?? p.v, c: p.v, h: hi, l: lo });
  }
  while (out.length > 90) {
    const m = [];
    for (let i = 0; i < out.length; i += 2) {
      const a = out[i], b = out[i + 1];
      m.push(b ? { k: a.k, t: a.t, t1: b.t1, o: a.o, c: b.c, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l) } : a);
    }
    out = m;
  }
  return out;
}

// Your buys and sales on a chart: a thin dashed line at the day of each, cyan for buys and pink for
// sales (as in the Latest feed). trades: [{ date: "YYYY-MM-DD", side: "buy" | "sell", qty, price, name? }].
// slotDay(i) is the local day ("YYYY-MM-DD") of slot i (a point or a candle); a trade goes on the first
// slot on or after its day, and only when that day is inside the chart.
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function placeTrades(trades, count, slotDay) {
  if (!trades?.length || !count) return [];
  const first = slotDay(0), last = slotDay(count - 1), out = [];
  for (const tr of trades) {
    if (!tr.date || tr.date < first || tr.date > last) continue;
    let lo = 0, hi = count - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (slotDay(m) >= tr.date) hi = m; else lo = m + 1; }
    out.push({ ...tr, i: lo });
  }
  return out;
}
const fmtQtyT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
// Hidden until you tap the chart; the next tap hides them again. Kept for the session, so the
// next chart (or range) you open looks the same.
let tradesShown = false;
function tradeMarkup(marks, x, top, bottom) {
  const seen = new Set();
  return `<g class="pchart__trades pchart__mine"${tradesShown ? "" : " hidden"}>` + marks.filter((m) => { const k = `${m.i}|${m.side}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((m) => `<g class="pchart__trade pchart__trade--${m.side}"><line x1="${x(m.i).toFixed(1)}" x2="${x(m.i).toFixed(1)}" y1="${top}" y2="${bottom}"/><circle cx="${x(m.i).toFixed(1)}" cy="${bottom}" r="3.5"/></g>`).join("") + "</g>";
}
// a tap (not a drag) on the chart shows or hides your trades
// (your average line too: everything about your own trades comes and goes together)
function tapToggleTrades(svg, marks, cost) {
  if (!marks.length && !cost) return;
  let down = null;
  svg.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  svg.addEventListener("pointerup", (e) => {
    if (!down || Date.now() - down.t > 350 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    tradesShown = !tradesShown;
    svg.querySelectorAll(".pchart__mine").forEach((g) => g.toggleAttribute("hidden", !tradesShown));
  });
}
// readout line for the trades near slot i (within `near` slots)
function tradeNote(marks, i, near, currency) {
  if (!tradesShown) return "";
  const hit = marks.filter((m) => Math.abs(m.i - i) <= near);
  if (!hit.length) return "";
  return `<span class="pchart__tradenote">${hit.slice(0, 3).map((m) => `<span class="pchart__tradenote--${m.side}">${m.side === "sell" ? "Sold" : "Bought"}</span> ${m.name ? `${m.name} · ` : ""}${fmtQtyT.format(m.qty)} × ${fmtMoney(m.price, currency)}`).join(" · ")}${hit.length > 3 ? ` · +${hit.length - 3} more` : ""}</span>`;
}
const tradeAria = (marks) => {
  const b = marks.filter((m) => m.side !== "sell").length, s2 = marks.length - b;
  return marks.length ? `; your ${b ? `${b} ${b === 1 ? "buy" : "buys"}` : ""}${b && s2 ? " and " : ""}${s2 ? `${s2} ${s2 === 1 ? "sale" : "sales"}` : ""} marked` : "";
};

// Your average buy price as a dashed line on a position's chart. steps: [{ date: "YYYY-MM-DD", avg | null }]
// in date order (null: none held); slotDay(i) as for placeTrades → one value (or null) per slot.
function costSeries(steps, count, slotDay) {
  if (!steps?.length) return null;
  const out = [];
  let k = -1;
  for (let i = 0; i < count; i++) {
    const d = slotDay(i);
    while (k + 1 < steps.length && steps[k + 1].date <= d) k++;
    out.push(k >= 0 ? steps[k].avg : null);
  }
  return out.some((v) => v != null) ? out : null;
}
// dashed path through the non-null values; a gap where you held none
function costPath(cost, x, y) {
  let d = "", on = false;
  cost.forEach((v, i) => {
    if (v == null) { on = false; return; }
    // flat steps: the average changes on the day of a buy, not in between
    if (on && v !== cost[i - 1]) d += `L${x(i).toFixed(1)},${y(cost[i - 1]).toFixed(1)}`;
    d += `${on ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    on = true;
  });
  return d;
}
const costNote = (cost, i, currency) => (tradesShown && cost?.[i] != null ? `<span class="pchart__costnote">Your average ${fmtMoney(cost[i], currency)}</span>` : "");
// the label at the right end of the line, unless it would sit on the high / low labels
function costLabel(cost, x, y, labR, hiY, loY, currency) {
  const last = cost?.[cost.length - 1];
  if (last == null) return "";
  const ly = y(last) - 6;
  if (Math.abs(ly - hiY) < 14 || Math.abs(ly - loY) < 14) return "";
  return `<text x="${labR}" y="${ly.toFixed(1)}" text-anchor="end" class="pchart__axis pchart__costlabel">avg ${fmtMoney(last, currency)}</text>`;
}

function drawCandles(plot, pts, range, currency, opts = {}) {
  const cs = toCandles(pts, range);
  const W = plot.clientWidth || 320, H = plot.clientHeight || 220;
  const inset = parseFloat(getComputedStyle(plot).getPropertyValue("--chart-inset")) || 0;
  const padT = 42, padB = 36, padR = inset ? 0 : 4; // room for the low label under its line
  const labR = W - padR - inset;
  const cost = costSeries(opts.costSteps, cs.length, (i) => localDay(cs[i].t1));
  const costVals = cost ? cost.filter((v) => v != null) : [];
  let lo = Math.min(...cs.map((c) => c.l), ...costVals), hi = Math.max(...cs.map((c) => c.h), ...costVals);
  if (hi === lo) { hi += hi * 0.01 || 1; lo -= lo * 0.01 || 1; }
  // even slots, like the line (nights and weekends take no room); a little air at both ends
  const slot = (W - padR - 2 * Math.max(inset, 4)) / cs.length, x0 = Math.max(inset, 4);
  const xc = (i) => x0 + (i + 0.5) * slot;
  const bw = Math.max(1, Math.min(14, slot * 0.62));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const first = pts[0].v, lastV = pts[pts.length - 1].v;
  const change = lastV - first, pct = first ? (change / first) * 100 : 0;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const up = cssVar("--up", "#2EE6A6"), down = cssVar("--down", "#FF4D6A");
  const bars = cs.map((c, i) => {
    const col = c.c >= c.o ? up : down, x = xc(i);
    const top = y(Math.max(c.o, c.c)), h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`
      + `<rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${bw > 4 ? 1 : 0}" fill="${col}"/>`;
  }).join("");
  const when = (t) => fmtWhen(t, range === "1D" || range === "1W" ? "1W+time" : range);
  const marks = placeTrades(opts.trades, cs.length, (i) => localDay(cs[i].t1));
  plot.innerHTML = `
    <svg class="pchart__svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="Candlesticks over ${range}: from ${fmtMoney(first, currency)} to ${fmtMoney(lastV, currency)}, ${sign}${Math.abs(pct).toFixed(2)}%, high ${fmtMoney(hi, currency)}, low ${fmtMoney(lo, currency)}${tradeAria(marks)}">
      <line x1="0" x2="${W}" y1="${y(hi)}" y2="${y(hi)}" class="pchart__grid"/>
      <line x1="0" x2="${W}" y1="${y(lo)}" y2="${y(lo)}" class="pchart__grid"/>
      <rect class="pchart__band" y="${padT - 6}" height="${H - padB - padT + 12}" width="${slot.toFixed(1)}" style="display:none"/>
      ${tradeMarkup(marks, xc, padT - 6, H - padB + 6)}
      ${cost ? `<g class="pchart__mine"${tradesShown ? "" : " hidden"}><path d="${costPath(cost, xc, y)}" fill="none" class="pchart__ref" vector-effect="non-scaling-stroke"/></g>` : ""}
      ${bars}
      ${cost ? `<g class="pchart__mine"${tradesShown ? "" : " hidden"}>${costLabel(cost, xc, y, labR, y(hi) - 6, y(lo) + 13, currency)}</g>` : ""}
      <text x="${labR}" y="${y(hi) - 6}" text-anchor="end" class="pchart__axis">${fmtMoney(hi, currency)}</text>
      <text x="${labR}" y="${y(lo) + 13}" text-anchor="end" class="pchart__axis">${fmtMoney(lo, currency)}</text>
      <text x="${inset}" y="${H - 4}" class="pchart__axis">${fmtWhen(pts[0].t, range)}</text>
      <text x="${labR}" y="${H - 4}" text-anchor="end" class="pchart__axis">${fmtWhen(pts[pts.length - 1].t, range)}</text>
    </svg>
    <div class="pchart__read"><b class="${change >= 0 ? "up" : "down"}">${sign}${Math.abs(pct).toFixed(2)}%</b> <span>${range === "All" ? "all time" : `over ${range}`}</span></div>`;

  // tap or hover a candle: its open, high, low and close
  const svg = plot.querySelector("svg"), band = svg.querySelector(".pchart__band"), read = plot.querySelector(".pchart__read");
  const resting = read.innerHTML;
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(cs.length - 1, Math.floor((((e.clientX - r.left) / r.width) * W - x0) / slot)));
    const c = cs[i], d = c.c - c.o, dp = c.o ? (d / c.o) * 100 : 0;
    band.style.display = ""; band.setAttribute("x", (x0 + i * slot).toFixed(1));
    const m = (v) => fmtMoney(v, currency);
    read.innerHTML = `<b>${m(c.c)}</b> <span class="${d >= 0 ? "up" : "down"}">${dp > 0 ? "+" : dp < 0 ? "−" : ""}${Math.abs(dp).toFixed(2)}%</span> <span>${when(c.t)}</span>`
      + `<span class="pchart__ohlc">O ${m(c.o)} · H ${m(c.h)} · L ${m(c.l)}</span>` + costNote(cost, i, currency) + tradeNote(marks, i, 0, currency);
  };
  const hide = () => { band.style.display = "none"; read.innerHTML = resting; };
  tapToggleTrades(svg, marks, cost);
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); show(e); });
  svg.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) show(e); });
  svg.addEventListener("pointerup", hide);
  svg.addEventListener("pointercancel", hide);
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
}

function draw(plot, pts, range, currency, opts = {}) {
  // a single security's price, as candlesticks when the setting asks for them at this range
  // (the portfolio chart stays a line)
  if (opts.candles && candlesFor(range) && pts.length >= 2) return drawCandles(plot, pts, range, currency, opts);
  const ref = opts.ref || null; // e.g. invested amount, drawn dashed
  const W = plot.clientWidth || 320, H = plot.clientHeight || 220;
  // --chart-inset (CSS): the line runs edge to edge, while labels keep this margin
  const inset = parseFloat(getComputedStyle(plot).getPropertyValue("--chart-inset")) || 0;
  const padT = 26, padB = 22, padR = inset ? 0 : 4;
  const labR = W - padR - inset;
  const vals = pts.map((p) => p.v);
  const cost = ref ? null : costSeries(opts.costSteps, pts.length, (i) => localDay(pts[i].t));
  const all = ref ? vals.concat(ref) : cost ? vals.concat(cost.filter((v) => v != null)) : vals;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += hi * 0.01 || 1; lo -= lo * 0.01 || 1; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  // x follows the order of the points, not clock time: nights and weekends don't become flat stretches
  const n = pts.length - 1 || 1;
  const xi = (i) => (i / n) * (W - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const change = ref ? vals[vals.length - 1] - ref[ref.length - 1] : vals[vals.length - 1] - vals[0];
  const pct = ref ? (ref[ref.length - 1] ? (change / ref[ref.length - 1]) * 100 : 0) : vals[0] ? (change / vals[0]) * 100 : 0;
  const color = change >= 0 ? cssVar("--up", "#2EE6A6") : cssVar("--down", "#FF4D6A");
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xi(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${xi(n).toFixed(1)},${H - padB}L0,${H - padB}Z`;
  const refLine = ref ? ref.map((v, i) => `${i ? "L" : "M"}${xi(i).toFixed(1)},${y(v).toFixed(1)}`).join("") : "";
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const marks = placeTrades(opts.trades, pts.length, (i) => localDay(pts[i].t));
  const near = Math.max(1, Math.round(n / 60)); // the readout names a trade when the finger is this close

  plot.innerHTML = `
    <svg class="pchart__svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="${ref ? "Value" : "Price"} over ${range}: from ${fmtMoney(vals[0], currency)} to ${fmtMoney(vals[vals.length - 1], currency)}, ${sign}${Math.abs(pct).toFixed(2)}%${tradeAria(marks)}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <line x1="0" x2="${W}" y1="${y(hi)}" y2="${y(hi)}" class="pchart__grid"/>
      <line x1="0" x2="${W}" y1="${y(lo)}" y2="${y(lo)}" class="pchart__grid"/>
      <path d="${area}" fill="url(#${gid})"/>
      ${tradeMarkup(marks, xi, padT - 6, H - padB)}
      ${ref ? `<path d="${refLine}" fill="none" class="pchart__ref" vector-effect="non-scaling-stroke"/>` : ""}
      ${cost ? `<g class="pchart__mine"${tradesShown ? "" : " hidden"}><path d="${costPath(cost, xi, y)}" fill="none" class="pchart__ref" vector-effect="non-scaling-stroke"/></g>` : ""}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <text x="${labR}" y="${y(hi) - 6}" text-anchor="end" class="pchart__axis">${fmtMoney(hi, currency)}</text>
      <text x="${labR}" y="${y(lo) - 6}" text-anchor="end" class="pchart__axis">${fmtMoney(lo, currency)}</text>
      ${cost ? `<g class="pchart__mine"${tradesShown ? "" : " hidden"}>${costLabel(cost, xi, y, labR, y(hi) - 6, y(lo) - 6, currency)}</g>` : ""}
      <text x="${inset}" y="${H - 4}" class="pchart__axis">${fmtWhen(t0, range)}</text>
      <text x="${labR}" y="${H - 4}" text-anchor="end" class="pchart__axis">${fmtWhen(t1, range)}</text>
      <g class="pchart__hover" style="display:none">
        <line class="pchart__cross" y1="${padT - 6}" y2="${H - padB}"/>
        <circle r="4.5" class="pchart__dot" fill="${color}"/>
      </g>
    </svg>
    <div class="pchart__read">${opts.rest ? opts.rest({ change, pct, sign }) : `<b class="${change >= 0 ? "up" : "down"}">${sign}${Math.abs(pct).toFixed(2)}%</b> <span>${range === "All" ? "all time" : `over ${range}`}</span>`}</div>`;

  // crosshair: finger or mouse anywhere on the plot
  const svg = plot.querySelector("svg"), hover = svg.querySelector(".pchart__hover");
  const cross = hover.querySelector("line"), dot = hover.querySelector("circle");
  const read = plot.querySelector(".pchart__read");
  const resting = read.innerHTML;
  const at = (clientX) => {
    const r = svg.getBoundingClientRect();
    const i = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * n);
    return Math.min(i, pts.length - 1);
  };
  const show = (e) => {
    const i = at(e.clientX), p = pts[i];
    const px = xi(i), py = y(p.v);
    hover.style.display = "";
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    const note = tradeNote(marks, i, near, opts.tradeCurrency || currency);
    if (opts.hover) { read.innerHTML = opts.hover(p, i, fmtWhen(p.t, range === "1D" || range === "1W" ? "1W+time" : range)) + note; return; }
    const d = p.v - vals[0], dp = vals[0] ? (d / vals[0]) * 100 : 0;
    read.innerHTML = `<b>${fmtMoney(p.v, currency)}</b> <span class="${d >= 0 ? "up" : "down"}">${dp > 0 ? "+" : dp < 0 ? "−" : ""}${Math.abs(dp).toFixed(2)}%</span> <span>${fmtWhen(p.t, range === "1D" || range === "1W" ? "1W+time" : range)}</span>` + costNote(cost, i, currency) + note;
  };
  const hide = () => { hover.style.display = "none"; read.innerHTML = resting; };
  tapToggleTrades(svg, marks, cost);
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); show(e); });
  svg.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) show(e); });
  svg.addEventListener("pointerup", hide);
  svg.addEventListener("pointercancel", hide);
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
}

/* ---------- public ---------- */
// Range buttons + loading/error states; `loader(range)` returns { pts, currency, credit, opts }.
function mountRanged(host, ranges, loader) {
  let range = "1M";
  try { const saved = localStorage.getItem(RANGE_KEY) === "Max" ? "All" : localStorage.getItem(RANGE_KEY); if (ranges.includes(saved)) range = saved; } catch {}
  if (!ranges.includes(range)) range = ranges[Math.min(2, ranges.length - 1)];

  host.innerHTML = `
    <div class="pchart">
      <div class="pchart__plot" aria-live="polite"><p class="pchart__msg">Loading chart…</p></div>
      <div class="pchart__ranges" role="tablist" aria-label="Time range">
        ${ranges.map((r) => `<button type="button" role="tab" data-range="${r}" aria-selected="${r === range}">${r}</button>`).join("")}
      </div>
      <p class="pchart__credit"></p>
    </div>`;
  const plot = host.querySelector(".pchart__plot");
  let token = 0;

  const load = async () => {
    const mine = ++token;
    host.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.range === range)));
    if (!plot.querySelector("svg")) plot.innerHTML = `<p class="pchart__msg">Loading chart…</p>`;
    else plot.classList.add("is-loading");
    try {
      const r = await loader(range);
      if (mine !== token) return;
      plot.classList.remove("is-loading");
      host.querySelector(".pchart__credit").textContent = r.credit || "";
      if (!r.pts || r.pts.length < 2) { plot.innerHTML = `<p class="pchart__msg">No history for this range.</p>`; return; }
      draw(plot, r.pts, range, r.currency, r.opts);
    } catch (e) {
      if (mine !== token) return;
      console.warn("Chart failed", e);
      plot.classList.remove("is-loading");
      plot.innerHTML = `<p class="pchart__msg">Couldn't load the price history right now.</p>`;
    }
  };

  host.querySelector(".pchart__ranges").addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b || b.dataset.range === range) return;
    range = b.dataset.range;
    try { localStorage.setItem(RANGE_KEY, range); } catch {}
    load();
  });
  load();
}

// One security. opts: { id: ISIN / crypto code / US ticker, currency: "EUR" | "USD", venue }
// trades: your buys and sales of it, marked on the chart (see placeTrades)
// costSteps: your average buy price over time ([{ date, avg | null }]), drawn as a dashed line
// History from onvista lags behind (today's daily bar isn't in it yet, intraday bars come late):
// the latest price we already show joins as the last point when it's newer. 1D stays on its day.
function withLive(pts, live, range, key = "v") {
  if (!live || !isFinite(live.t) || !pts.length) return pts;
  const last = pts[pts.length - 1];
  if (live.t <= last.t + 60e3 || live.t > Date.now() + 5 * 60e3) return pts;
  if (range === "1D" && new Date(live.t).toDateString() !== new Date(last.t).toDateString()) return pts;
  return [...pts, { t: live.t, [key]: live.value ?? live.price, v: live.value ?? live.price }];
}

export function mountPriceChart(host, { id, currency = "EUR", venue, hint, credit = true, live = null, trades = [], costSteps = [] }) {
  const ranges = Object.keys(RANGES).filter((r) => !isCryptoCode(id) || RANGES[r].cg);
  mountRanged(host, ranges, async (range) => {
    const src = await resolve(id, currency, venue, hint);
    const pts = withLive(await history(src, range), live, range);
    return { pts, currency: src.currency || currency, credit: credit ? `Price data: ${src.credit}${venue ? ` · ${venue}` : ""}` : "", opts: { candles: true, trades, costSteps } };
  });
}

// Your whole portfolio: Σ units held at each moment × that position's price, in EUR,
// with the amount invested so far as a dashed line.
// positions: [{ id, currency, venue, toEur, lots: [{ qty, buyEur, date: "YYYY-MM-DD" | "" }] }]
// trades: every buy and sale ({ date, side, qty, price in EUR, name }), marked on the chart
export function mountPortfolioChart(host, { positions, vsInvested = true, trades = [], live = null }) {
  const fmt = (v) => fmtMoney(v, "EUR");
  mountRanged(host, Object.keys(RANGES), async (range) => {
    const loaded = await Promise.allSettled(positions.map(async (p) => {
      if (isCryptoCode(p.id) && !RANGES[range].cg) {
        // CoinGecko's free history covers one year: use the 1Y series and keep its first price before that
        const src = await resolve(p.id, p.currency, p.venue);
        return { p, pts: await history(src, "1Y") };
      }
      const src = await resolve(p.id, p.currency, p.venue);
      return { p, pts: await history(src, range) };
    }));
    const series = loaded.filter((r) => r.status === "fulfilled" && r.value.pts.length).map((r) => r.value);
    const missing = positions.length - series.length;
    if (!series.length) return { pts: [] };

    // time grid: all timestamps inside the range (the 1D window follows the securities, not crypto's 24h)
    // The portfolio only exists from its first buy: long ranges (All, 5Y) start there instead of
    // decades back. Buys without a date count from that first dated buy.
    const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : NaN);
    const dated = positions.flatMap((p) => p.lots.map((l) => dayStart(l.date))).filter((t) => isFinite(t));
    const firstBuy = dated.length ? Math.min(...dated) : -Infinity;
    const lots = series.map((s) => s.p.lots.map((l) => ({ ...l, from: isFinite(dayStart(l.date)) ? dayStart(l.date) : firstBuy })));

    const firstOf = (s) => s.pts[0].t;
    const start = range === "1D" ? Math.max(...series.filter((s) => !isCryptoCode(s.p.id)).map(firstOf).concat([-Infinity])) : firstBuy;
    const grid = [...new Set(series.flatMap((s) => s.pts.map((q) => q.t)))].filter((t) => t >= start).sort((a, b) => a - b);
    const idx = series.map(() => 0);
    const pts = [], ref = [];
    for (const t of grid) {
      let value = 0, invested = 0;
      series.forEach((s, k) => {
        const arr = s.pts;
        while (idx[k] + 1 < arr.length && arr[idx[k] + 1].t <= t) idx[k]++;
        const price = (arr[idx[k]].t <= t ? arr[idx[k]].v : arr[0].v) * s.p.toEur; // before its first point: its first price
        for (const l of lots[k]) if (l.from <= t) { value += l.qty * price; invested += l.qty * l.buyEur; }
      });
      if (value > 0) { pts.push({ t, v: value }); ref.push(invested); }
    }
    let thinned = thin(pts, 1500);
    const keep = new Set(thinned.map((q) => q.t));
    const refThin = pts.map((q, i) => (keep.has(q.t) ? ref[i] : null)).filter((v) => v != null);
    // your portfolio right now as the last point (the invested line carries on flat)
    const withNow = withLive(thinned, live, range);
    if (withNow.length > thinned.length) { thinned = withNow; refThin.push(refThin[refThin.length - 1]); }

    return {
      pts: thinned,
      currency: "EUR",
      credit: `Price data: onvista, CoinGecko${missing ? ` · ${missing} position${missing === 1 ? "" : "s"} without history left out` : ""}`,
      opts: {
        ref: refThin,
        trades, tradeCurrency: "EUR",
        rest: vsInvested
          ? ({ change, pct, sign }) => `<b class="${change >= 0 ? "up" : "down"}">${sign}${fmt(Math.abs(change)).replace(/^-/, "")}</b> <span class="${change >= 0 ? "up" : "down"}">${sign}${Math.abs(pct).toFixed(2)}%</span>`
          : () => "",
        hover: (q, i, when) => {
          const inv = refThin[i], g = q.v - inv;
          return `<b>${fmt(q.v)}</b> <span class="${g >= 0 ? "up" : "down"}">${g >= 0 ? "+" : "−"}${fmt(Math.abs(g))}</span> <span>${when}</span>`;
        },
      },
    };
  });
}

// Year by year: net money put in and the gain made in each calendar year.
// gain(Y) = value at the end of Y − value at the end of Y−1 − (buys − sale proceeds in Y)
// positions: as for the portfolio chart, with lots: [{ qty, buyEur, date, cash }] (cash: + paid / − received)
export async function portfolioYears(positions) {
  const loaded = await Promise.allSettled(positions.map(async (p) => {
    const src = await resolve(p.id, p.currency, p.venue);
    return { p, pts: await history(src, isCryptoCode(p.id) ? "1Y" : "All") };
  }));
  const series = loaded.filter((r) => r.status === "fulfilled" && r.value.pts.length).map((r) => r.value);
  const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : NaN);
  const dated = positions.flatMap((p) => p.lots.map((l) => dayStart(l.date))).filter((t) => isFinite(t));
  if (!dated.length || !series.length) return { years: [], missing: positions.length - series.length };
  const firstBuy = Math.min(...dated);
  const priceAt = (pts, t) => {
    let lo = 0, hi = pts.length - 1, best = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1; }
    return pts[best].v; // before the first point: the first price
  };
  const lots = series.map((s) => s.p.lots.map((l) => ({ ...l, from: isFinite(dayStart(l.date)) ? dayStart(l.date) : firstBuy })));
  const valueAt = (t) => series.reduce((sum, s, k) => {
    const units = lots[k].filter((l) => l.from <= t).reduce((n, l) => n + l.qty, 0);
    return sum + (units > 1e-9 ? units * priceAt(s.pts, t) * s.p.toEur : 0);
  }, 0);
  const y0 = new Date(firstBuy).getFullYear(), yNow = new Date().getFullYear();
  const years = [];
  let prev = 0;
  for (let y = y0; y <= yNow; y++) {
    const from = new Date(y, 0, 1).getTime(), to = y === yNow ? Date.now() : new Date(y + 1, 0, 1).getTime() - 1;
    const flow = lots.flat().filter((l) => l.from >= from && l.from <= to).reduce((n, l) => n + (l.cash || 0), 0);
    const value = valueAt(to);
    years.push({ year: y, value, gain: value - prev - flow });
    prev = value;
  }
  return { years, missing: positions.length - series.length };
}


// Price change over a range for the map: first → last price of that range's history, in %.
// items: [{ key, id, currency, venue, hint }] → Map key → % (null when there's no history for it).
// Crypto has no 5Y history on CoinGecko's free plan: null.
export async function changesOver(items, range) {
  const out = new Map();
  await Promise.all(items.map(async (it) => {
    try {
      if (isCryptoCode(it.id) && !RANGES[range]?.cg) { out.set(it.key, null); return; }
      const src = await resolve(it.id, it.currency, it.venue, it.hint);
      const pts = await history(src, range);
      out.set(it.key, pts.length >= 2 ? (pts[pts.length - 1].v / pts[0].v - 1) * 100 : null);
    } catch { out.set(it.key, null); }
  }));
  return out;
}

// Month by month (or quarter / year): each position's price change per calendar period.
// A period's change = its last price / the previous period's last price; the last period runs to now.
// opts: { count: periods, step: months per period (1, 3 or 12) }
// items: [{ key, id, currency, venue, hint }] → { periods: [{ from, to }] ("YYYY-MM"), byKey: Map key → [% | null] }
export async function periodChanges(items, { count = 12, step = 1 } = {}) {
  const now = new Date(), cm = now.getFullYear() * 12 + now.getMonth();
  const ym = (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
  const curStart = cm - (cm % step); // calendar-aligned: quarters start Jan/Apr/Jul/Oct, years in Jan
  const periods = [];
  for (let i = count - 1; i >= 0; i--) { const a = curStart - i * step; periods.push({ a, b: Math.min(a + step - 1, cm), from: ym(a), to: ym(Math.min(a + step - 1, cm)) }); }
  // end of month n (the current month: now)
  const endOf = (n) => (n >= cm ? Date.now() : new Date(Math.floor((n + 1) / 12), (n + 1) % 12, 1).getTime() - 1);
  const back = cm - periods[0].a + 1; // months of history needed
  const range = back <= 12 ? "1Y" : back <= 59 ? "5Y" : "All";
  const byKey = new Map();
  await Promise.all(items.map(async (it) => {
    try {
      const src = await resolve(it.id, it.currency, it.venue, it.hint);
      // CoinGecko's free plan stops at a year: older periods stay empty
      const pts = await history(src, isCryptoCode(it.id) ? "1Y" : range);
      const close = (t) => {
        let lo = 0, hi = pts.length - 1, best = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1; }
        return best < 0 ? null : pts[best].v;
      };
      byKey.set(it.key, periods.map(({ a, b }) => {
        const p0 = close(endOf(a - 1)), p1 = close(endOf(b));
        return p0 && p1 ? (p1 / p0 - 1) * 100 : null;
      }));
    } catch { byKey.set(it.key, periods.map(() => null)); }
  }));
  return { periods: periods.map(({ from, to }) => ({ from, to })), byKey };
}
