// Our own price chart: history from onvista (stocks, ETFs, certificates) or CoinGecko (crypto),
// drawn as an SVG area chart with range buttons and a touch/mouse crosshair.
// Both APIs allow browser requests, so no third-party widget, logo or consent prompt is needed.
import { CRYPTO, isCryptoCode } from "./crypto.js?v=44";

const OV = "https://api.onvista.de/api/v1";
const RANGES = {
  // res: onvista resolution (tested: 1m, 5m, 15m, 30m, 60m, 2h, 4h are valid)
  "1D": { ov: "D1", back: { days: 6 }, cg: 1, res: "1m" },
  "1W": { ov: "W1", back: { days: 7 }, cg: 7, res: "15m" },
  "1M": { ov: "M1", back: { months: 1 }, cg: 30, res: "60m" },
  "1Y": { ov: "Y1", back: { years: 1 }, cg: 365, res: "1D" },
  "5Y": { ov: "Y5", back: { years: 5 }, cg: null, res: "1D" },   // default would be weekly
  "Max": { ov: "MAX", back: { years: 40 }, cg: null, res: "1D" }, // default would be monthly
};
const RANGE_KEY = "stonks-chart-range";

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
function resolve(id, currency, venue) {
  const key = `${id}|${currency}|${venue || ""}`;
  if (!sourceCache.has(key)) sourceCache.set(key, resolveUncached(id, currency, venue).catch((e) => { sourceCache.delete(key); throw e; }));
  return sourceCache.get(key);
}

async function resolveUncached(id, currency, venue) {
  if (isCryptoCode(id)) return { kind: "crypto", cg: CRYPTO[id].cg, currency: "EUR", credit: "CoinGecko" };
  const s = await fetch(`${OV}/instruments/search/facet?searchValue=${encodeURIComponent(id)}`);
  const hits = s.ok ? ((await s.json()).facets || []).flatMap((f) => f.results || []) : [];
  const hit = hits.find((h) => h.isin === id || h.symbol === id) || hits[0] || {};
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
    const want = (q) => (currency === "USD" ? q.isoCurrency === "USD" : /gettex/i.test(q.market.name || ""));
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
    const [ts, vs] = Array.isArray(d.tick) && Array.isArray(d.datetimeTick) ? [d.datetimeTick, d.tick] : [d.datetimeLast || [], d.last || []];
    pts = clean(ts.map((t, i) => ({ t: toMs(t), v: vs[i] })));
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
const UP = "#5BD48A", DOWN = "#FF9F4A";

function fmtMoney(v, currency) {
  const digits = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v).replace(/^(-?)€/, "$1€");
}
function fmtWhen(t, range) {
  const d = new Date(t);
  if (range === "1D") return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (range === "1W") return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function draw(plot, pts, range, currency, opts = {}) {
  const ref = opts.ref || null; // e.g. invested amount, drawn dashed
  const W = plot.clientWidth || 320, H = plot.clientHeight || 220;
  const padT = 26, padB = 22, padR = 4;
  const vals = pts.map((p) => p.v);
  const all = ref ? vals.concat(ref) : vals;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += hi * 0.01 || 1; lo -= lo * 0.01 || 1; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  // x follows the order of the points, not clock time: nights and weekends don't become flat stretches
  const n = pts.length - 1 || 1;
  const xi = (i) => (i / n) * (W - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const change = ref ? vals[vals.length - 1] - ref[ref.length - 1] : vals[vals.length - 1] - vals[0];
  const pct = ref ? (ref[ref.length - 1] ? (change / ref[ref.length - 1]) * 100 : 0) : vals[0] ? (change / vals[0]) * 100 : 0;
  const color = change >= 0 ? UP : DOWN;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xi(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${xi(n).toFixed(1)},${H - padB}L0,${H - padB}Z`;
  const refLine = ref ? ref.map((v, i) => `${i ? "L" : "M"}${xi(i).toFixed(1)},${y(v).toFixed(1)}`).join("") : "";
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";

  plot.innerHTML = `
    <svg class="pchart__svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="Price over ${range}: from ${fmtMoney(vals[0], currency)} to ${fmtMoney(vals[vals.length - 1], currency)}, ${sign}${Math.abs(pct).toFixed(2)}%">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <line x1="0" x2="${W}" y1="${y(hi)}" y2="${y(hi)}" class="pchart__grid"/>
      <line x1="0" x2="${W}" y1="${y(lo)}" y2="${y(lo)}" class="pchart__grid"/>
      <path d="${area}" fill="url(#${gid})"/>
      ${ref ? `<path d="${refLine}" fill="none" class="pchart__ref" vector-effect="non-scaling-stroke"/>` : ""}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <text x="${W - padR}" y="${y(hi) - 6}" text-anchor="end" class="pchart__axis">${fmtMoney(hi, currency)}</text>
      <text x="${W - padR}" y="${y(lo) - 6}" text-anchor="end" class="pchart__axis">${fmtMoney(lo, currency)}</text>
      <text x="0" y="${H - 4}" class="pchart__axis">${fmtWhen(t0, range)}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end" class="pchart__axis">${fmtWhen(t1, range)}</text>
      <g class="pchart__hover" style="display:none">
        <line class="pchart__cross" y1="${padT - 6}" y2="${H - padB}"/>
        <circle r="4.5" class="pchart__dot" fill="${color}"/>
      </g>
    </svg>
    <div class="pchart__read">${opts.rest ? opts.rest({ change, pct, sign }) : `<b class="${change >= 0 ? "up" : "down"}">${sign}${Math.abs(pct).toFixed(2)}%</b> <span>${range === "Max" ? "all time" : `over ${range}`}</span>`}</div>`;

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
    if (opts.hover) { read.innerHTML = opts.hover(p, i, fmtWhen(p.t, range === "1D" ? "1W" : range)); return; }
    const d = p.v - vals[0], dp = vals[0] ? (d / vals[0]) * 100 : 0;
    read.innerHTML = `<b>${fmtMoney(p.v, currency)}</b> <span class="${d >= 0 ? "up" : "down"}">${dp > 0 ? "+" : dp < 0 ? "−" : ""}${Math.abs(dp).toFixed(2)}%</span> <span>${fmtWhen(p.t, range === "1D" ? "1W" : range)}</span>`;
  };
  const hide = () => { hover.style.display = "none"; read.innerHTML = resting; };
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
  try { const saved = localStorage.getItem(RANGE_KEY); if (ranges.includes(saved)) range = saved; } catch {}
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
export function mountPriceChart(host, { id, currency = "EUR", venue }) {
  const ranges = Object.keys(RANGES).filter((r) => !isCryptoCode(id) || RANGES[r].cg);
  mountRanged(host, ranges, async (range) => {
    const src = await resolve(id, currency, venue);
    const pts = await history(src, range);
    return { pts, currency: src.currency || currency, credit: `Price data: ${src.credit}${venue ? ` · ${venue}` : ""}` };
  });
}

// Your whole portfolio: Σ units held at each moment × that position's price, in EUR,
// with the amount invested so far as a dashed line.
// positions: [{ id, currency, venue, toEur, lots: [{ qty, buyEur, date: "YYYY-MM-DD" | "" }] }]
export function mountPortfolioChart(host, { positions }) {
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
    // The portfolio only exists from its first buy: long ranges (Max, 5Y) start there instead of
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
    const thinned = thin(pts, 1500);
    const keep = new Set(thinned.map((q) => q.t));
    const refThin = pts.map((q, i) => (keep.has(q.t) ? ref[i] : null)).filter((v) => v != null);

    return {
      pts: thinned,
      currency: "EUR",
      credit: `Price data: onvista, CoinGecko${missing ? ` · ${missing} position${missing === 1 ? "" : "s"} without history left out` : ""}`,
      opts: {
        ref: refThin,
        rest: ({ change, pct, sign }) => `<b class="${change >= 0 ? "up" : "down"}">${sign}${fmt(Math.abs(change)).replace(/^-/, "")}</b> <span class="${change >= 0 ? "up" : "down"}">${sign}${Math.abs(pct).toFixed(2)}%</span> <span>vs invested</span>`,
        hover: (q, i, when) => {
          const inv = refThin[i], g = q.v - inv;
          return `<b>${fmt(q.v)}</b> <span class="${g >= 0 ? "up" : "down"}">${g >= 0 ? "+" : "−"}${fmt(Math.abs(g))}</span> <span>${when}</span>`;
        },
      },
    };
  });
}
