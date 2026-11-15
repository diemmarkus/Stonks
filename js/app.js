import { isConfigured, signIn, signOutUser, onUser } from "./firebase.js?v=39";
import { legalDoc } from "./legal.js?v=39";
import { isCryptoCode } from "./crypto.js?v=39";

const $ = (id) => document.getElementById(id);
const fmt2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const sign = (n) => (n > 0 ? "+" : n < 0 ? "−" : "");
const fmtPct = (n) => `${sign(n)}${Math.abs(n).toFixed(2)}%`;
const fmtUsd = (n) => `$${fmt2.format(n)}`;
const fmtUsdSigned = (n) => `${sign(n)}$${fmt2.format(Math.abs(n))}`;
const fmtEur = (n) => `€${fmt2.format(n)}`;
const fmtEurSigned = (n) => `${sign(n)}€${fmt2.format(Math.abs(n))}`;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const isValidId = (code) => isValidIsin(code) || isCryptoCode(code); // real ISIN or flatex crypto code
function isValidIsin(isin) {
  if (!ISIN_RE.test(isin)) return false;
  const digits = isin.split("").map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const dir = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stampOf = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

$("year").textContent = new Date().getFullYear();

const state = {
  user: null,
  authReady: false,
  market: null,        // movers.json
  prices: new Map(),   // US ticker → quote (USD), from movers.json
  isin: {},            // ISIN → { name, price (EUR), change, changePct, tv, venue, ... }, from prices.json
  fx: {},              // { USD: dollars per euro }
  pricesAt: null,
  names: {},           // your own names for positions: key (ISIN) → name
  venues: {},          // exchange to value a position with: key (ISIN) → venue name
  holdings: null,      // null = loading
  unsubHoldings: null,
  view: null,
};

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ======================================================================
   Market data (written by the GitHub Action)
   ====================================================================== */
async function loadMarket() {
  try {
    const res = await fetch(`data/movers.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.market = data;
    state.prices = new Map([...(data.quotes || []), ...(data.tracked || [])].map((q) => [q.symbol, q]));
    renderHome();
    renderCurrent();
  } catch (e) {
    console.error("Loading movers failed", e);
    $("boards").innerHTML = "";
    $("note").textContent = "Couldn't load today's movers. Try again in a bit.";
  }
}

async function loadPrices() {
  try {
    const res = await fetch(`data/prices.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json(); // crypto prices + EUR/USD
      const live = Object.fromEntries(Object.entries(state.isin).filter(([k, v]) => v.liveLookup && !data.byIsin?.[k]));
      state.isin = { ...live, ...(data.byIsin || {}) };
      state.fx = data.fx || {};
      state.pricesAt = data.updatedAt;
    }
  } catch (e) {
    console.warn("No price file", e);
  }
  // your stocks, ETFs and certificates are priced right here in the browser (onvista)
  state.pricesLoaded = true;
  fillIsinList();
  if (!$("add-sheet").hidden) updateIsinHint();
  renderCurrent();
  priceMissingHoldings();
}

/* Instant prices for ISINs the hourly job hasn't priced yet: ask onvista straight from the browser. */
const liveTried = new Map(); // isin → promise
function lookupLive(isin) {
  if (state.isin[isin] || !isValidId(isin)) return Promise.resolve(state.isin[isin] || null);
  if (!liveTried.has(isin)) {
    const lookup = isCryptoCode(isin)
      ? import("./crypto.js?v=39").then(({ lookupCrypto }) => lookupCrypto([isin])).then((r) => r[isin] || null)
      : import("./onvista.js?v=39").then(({ lookupIsin }) => lookupIsin(isin));
    liveTried.set(isin, lookup
      .then((q) => {
        if (q) {
          state.isin[isin] = { ...q, liveLookup: true };
          state.pricesAt = new Date().toISOString();
          fillIsinList();
          renderCurrent();
        }
        return q;
      })
      .catch((e) => { console.warn(`Live lookup for ${isin} failed`, e); liveTried.delete(isin); return null; }));
  }
  return liveTried.get(isin);
}
function priceMissingHoldings() {
  if (!state.pricesLoaded || !state.holdings) return;
  for (const h of state.holdings) if (h.isin && !state.isin[h.isin]) lookupLive(h.isin);
}

/* ======================================================================
   Home — today's movers
   ====================================================================== */
const GROUPS = [
  { kind: "stocks", title: "Stocks" },
  { kind: "etfs", title: "ETFs" },
];
let activeKind = "stocks";

function moverRows(items, d) {
  const max = Math.max(...items.map((i) => Math.abs(i.changePct)), 0.01);
  return items.map((i, idx) => `
    <li class="row row--link" data-chart="${esc(i.symbol)}" tabindex="0" role="button" aria-label="Show chart for ${esc(i.symbol)}">
      <span class="row__rank">${idx + 1}</span>
      <div class="row__id">
        <div class="row__sym">${esc(i.symbol)}</div>
        <div class="row__name">${esc(i.name)}</div>
        <div class="row__bar"><span style="width:${(Math.abs(i.changePct) / max) * 100}%"></span></div>
      </div>
      <div class="row__nums">
        <div class="row__price">${fmtUsd(i.price)}</div>
        <span class="pill ${d}">${fmtPct(i.changePct)}</span>
      </div>
    </li>`).join("");
}

function skeletonRows() {
  return Array.from({ length: 3 }, (_, idx) => `
    <li class="row skeleton">
      <span class="row__rank">${idx + 1}</span>
      <div class="row__id"><div class="row__sym">XXXX</div><div class="row__name">Loading company name</div></div>
      <div class="row__nums"><div class="row__price">000.00</div></div>
    </li>`).join("");
}

function moverCard(d, title, body) {
  return `
    <article class="card card--${d}">
      <div class="card__head"><h3 class="card__title">${title}</h3><span class="card__hint">1D change</span></div>
      <ol class="rows">${body}</ol>
    </article>`;
}

// Analyst consensus: score from -2 (all strong sell) to +2 (all strong buy)
const ratingLabel = (score) => (score >= 1.2 ? "Strong buy" : score >= 0.5 ? "Buy" : score > -0.5 ? "Hold" : score > -1.2 ? "Sell" : "Strong sell");
function analystRows(items) {
  return items.map((r, idx) => {
    const buy = r.strongBuy + r.buy, hold = r.hold, sell = r.sell + r.strongSell;
    const seg = (n, cls) => (n ? `<span class="rating__seg ${cls}" style="flex:${n}"></span>` : "");
    return `
    <li class="row row--link" data-chart="${esc(r.symbol)}" tabindex="0" role="button" aria-label="Show chart for ${esc(r.symbol)}">
      <span class="row__rank">${idx + 1}</span>
      <div class="row__id">
        <div class="row__sym">${esc(r.symbol)}</div>
        <div class="row__name">${esc(r.name)}</div>
        <div class="rating" role="img" aria-label="${buy} buy, ${hold} hold, ${sell} sell">${seg(buy, "is-buy")}${seg(hold, "is-hold")}${seg(sell, "is-sell")}</div>
        <div class="rating__counts">${buy} buy · ${hold} hold · ${sell} sell</div>
      </div>
      <div class="row__nums">
        <span class="pill ${r.score >= 0.5 ? "up" : r.score <= -0.5 ? "down" : ""}">${ratingLabel(r.score)}</span>
      </div>
    </li>`; }).join("");
}

/* Analyst ratings for all S&P 500 companies (data/analysts.json, daily) + "Look up a stock" */
const getAnalysts = () => state.analysts || state.market?.analysts || null;
const lookupState = {}; // scope → { open, q }

async function loadAnalysts() {
  try {
    const res = await fetch(`data/analysts.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    state.analysts = await res.json();
    renderHome();
    renderCurrent();
  } catch (e) { console.warn("No analyst file yet", e); }
}

function lookupMatches(q) {
  const a = getAnalysts();
  const list = a?.list || [];
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const score = (r) => {
    const sym = r.symbol.toLowerCase(), name = r.name.toLowerCase(), isin = (r.isin || "").toLowerCase();
    if (sym === t || isin === t) return 0;
    if (name.startsWith(t)) return 1;
    if (sym.startsWith(t)) return 2;
    if (name.includes(t)) return 3;
    if (isin.startsWith(t)) return 4;
    return 9;
  };
  return list.map((r) => [score(r), r]).filter(([sc]) => sc < 9).sort((x, y) => x[0] - y[0] || y[1].total - x[1].total).slice(0, 5).map(([, r]) => r);
}

function lookupResultsHtml(q) {
  const a = getAnalysts();
  if (!a?.list) return `<p class="lookup__hint">Search becomes available after the next daily rating update.</p>`;
  if (!q.trim()) return `<p class="lookup__hint">Type a name, ticker or ISIN of one of the ${a.list.length} S&P 500 companies.</p>`;
  const hits = lookupMatches(q);
  return hits.length
    ? `<ol class="rows">${analystRows(hits)}</ol>`
    : `<p class="lookup__hint">No analyst ratings for “${esc(q.trim())}”. Only S&P 500 companies are covered; ETFs have no analyst ratings.</p>`;
}

function lookupHtml(scope) {
  const st = lookupState[scope] || { open: false, q: "" };
  return `
    <details class="card lookup" data-lookup="${scope}"${st.open ? " open" : ""}>
      <summary><span>Look up a stock</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></summary>
      <input class="input" data-lookup-input="${scope}" value="${esc(st.q)}" placeholder="Name, ticker or ISIN" autocomplete="off" spellcheck="false" enterkeyhint="search" />
      <div data-lookup-results="${scope}">${lookupResultsHtml(st.q)}</div>
    </details>`;
}

// Re-renders replace the markup; keep focus and caret in the lookup field.
function withLookupFocus(fn) {
  const el = document.activeElement;
  const scope = el?.dataset?.lookupInput;
  const pos = scope ? el.selectionStart : null;
  fn();
  if (scope) {
    const again = document.querySelector(`[data-lookup-input="${scope}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
  }
}

document.addEventListener("input", (e) => {
  const scope = e.target.dataset?.lookupInput;
  if (!scope) return;
  lookupState[scope] = { open: true, q: e.target.value };
  const out = document.querySelector(`[data-lookup-results="${scope}"]`);
  if (out) out.innerHTML = lookupResultsHtml(e.target.value);
});
document.addEventListener("toggle", (e) => {
  const scope = e.target.dataset?.lookup;
  if (!scope) return;
  lookupState[scope] = { ...(lookupState[scope] || { q: "" }), open: e.target.open };
  if (e.target.open) e.target.querySelector("input")?.focus();
}, true);

function analystGroup(a) {
  const body = (items) => (a ? analystRows(items) : skeletonRows());
  return `
      <div class="group ${activeKind === "analysts" ? "is-active" : ""}" data-kind="analysts">
        <h2 class="group__title">Analyst ratings</h2>
        <div class="group__cards">
          <article class="card card--up"><div class="card__head"><h3 class="card__title">Top buys</h3><span class="card__hint">12-month view</span></div><ol class="rows">${body(a?.buys || [])}</ol></article>
          <article class="card card--down"><div class="card__head"><h3 class="card__title">Weakest ratings</h3><span class="card__hint">12-month view</span></div><ol class="rows">${body(a?.sells || [])}</ol></article>
        </div>
        ${lookupHtml("markets")}
        <p class="note">${a ? `Consensus of Wall Street analysts' 12-month ratings for ${a.count} S&P 500 companies (Finnhub, ${esc(a.period || "")}). Their opinion, not advice from stonks — always do your own research.` : "Analyst ratings appear after the next daily update."}</p>
      </div>`;
}

function renderHome() {
  const data = state.market;
  $("boards").innerHTML = GROUPS.map(({ kind, title }) => {
    const g = data?.[kind];
    return `
      <div class="group ${kind === activeKind ? "is-active" : ""}" data-kind="${kind}">
        <h2 class="group__title">${title}</h2>
        <div class="group__cards">
          ${moverCard("up", "Top gainers", g ? moverRows(g.gainers, "up") : skeletonRows())}
          ${moverCard("down", "Top losers", g ? moverRows(g.losers, "down") : skeletonRows())}
        </div>
      </div>`;
  }).join("") + analystGroup(getAnalysts());
  if (!data) return;
  const stamp = stampOf(data.updatedAt);
  $("asof").textContent = `Movers · ${stamp}`;
  $("mk-asof").textContent = `Updated · ${stamp}`;
  $("note").innerHTML = data.sample
    ? `<span class="badge">● Sample data.</span> Live numbers appear once the “Update movers” GitHub Action has run.`
    : `Based on ${data.quotes?.length ?? 0} US-listed stocks and ETFs · prices via ${esc(data.source || "market data")} · updated ${stamp}.`;
}

document.querySelectorAll("#kind-switch button").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeKind = btn.dataset.kind;
    document.querySelectorAll("#kind-switch button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    document.querySelectorAll(".group").forEach((g) => g.classList.toggle("is-active", g.dataset.kind === activeKind));
  });
});

// The quote for an ISIN, from the exchange you picked for it (else the default: gettex first).
function quoteFor(isin) {
  const q = state.isin[isin];
  if (!q) return null;
  const want = state.venues[isin];
  const v = want && q.quotes?.find((x) => x.venue === want);
  return v ? { ...q, price: v.price, change: v.change, changePct: v.changePct, venue: v.venue } : q;
}

/* ======================================================================
   Valuation
   ====================================================================== */
function valuate(h0) {
  let h = h0;
  let q = null, price, buy = h.buyPrice, live = false, key, tv = null, sub;
  if (h.isin) {
    q = quoteFor(h.isin);
    key = h.isin;
    live = Boolean(q);
    price = live ? q.price : h.buyPrice;
    tv = q?.tv || null;
    sub = q?.venue ? `${h.isin} · ${q.venue}` : h.isin;
    if (q?.type) h = { ...h, type: q.type };
  } else {
    // older holding entered by US ticker in USD → convert to EUR
    const usd = state.fx.USD || 1;
    const t = state.prices.get(h.symbol);
    q = t ? { ...t, price: t.price / usd, change: t.change / usd } : null;
    key = h.symbol;
    live = Boolean(q);
    buy = h.buyPrice / usd;
    price = live ? q.price : buy;
    tv = h.symbol;
    sub = `${h.symbol} · needs ISIN`;
  }
  const value = h.quantity * price;
  const cost = h.quantity * buy;
  return {
    ...h,
    key,
    tv,
    sub,
    label: state.names[key] || q?.name || h.name || key,
    realName: q?.name || h.name || key,
    nicknamed: Boolean(state.names[key]),
    live,
    price,
    buyEur: buy,
    value,
    cost,
    gain: value - cost,
    gainPct: cost ? ((value - cost) / cost) * 100 : 0,
    dayChange: live ? h.quantity * q.change : 0,
    prevValue: live ? h.quantity * (q.price - q.change) : 0,
    dayPct: live ? q.changePct : 0,
  };
}

function totals(rows) {
  const t = rows.reduce((a, r) => {
    a.value += r.value; a.cost += r.cost; a.day += r.dayChange; a.prev += r.prevValue;
    return a;
  }, { value: 0, cost: 0, day: 0, prev: 0 });
  t.gain = t.value - t.cost;
  t.gainPct = t.cost ? (t.gain / t.cost) * 100 : 0;
  t.dayPct = t.prev ? (t.day / t.prev) * 100 : 0;
  return t;
}

// Several lots of the same ticker → one position.
function positions(rows) {
  const map = new Map();
  for (const r of rows) {
    const p = map.get(r.key) || { key: r.key, isin: r.isin, tv: r.tv, label: r.label, sub: r.sub, type: r.type, live: r.live, dayPct: r.dayPct, value: 0, cost: 0, dayChange: 0, prevValue: 0 };
    p.value += r.value; p.cost += r.cost; p.dayChange += r.dayChange; p.prevValue += r.prevValue;
    map.set(r.key, p);
  }
  return [...map.values()];
}

/* ======================================================================
   Overview
   ====================================================================== */
function emptyState() {
  return `
    <div class="card empty">
      <h3>Nothing here yet</h3>
      <p>Add your first stock or ETF and your overview builds itself.</p>
      <a class="btn btn--primary" href="#/add">Add a holding</a>
    </div>
    <a class="card linkcard" href="#/movers"><span><b>Market movers</b><span>Today's top gainers and losers in stocks and ETFs</span></span><span aria-hidden="true">→</span></a>`;
}

function loadingState() {
  return `<p class="note">Loading your holdings…</p>`;
}

function renderOverview() {
  const body = $("ov-body");
  $("ov-asof").textContent = state.pricesAt ? `Prices · ${stampOf(state.pricesAt)}` : "";
  if (state.holdings === null) { body.innerHTML = loadingState(); return; }
  if (!state.holdings.length) { body.innerHTML = emptyState(); return; }

  const rows = state.holdings.map(valuate);
  const t = totals(rows);
  const pos = positions(rows).sort((a, b) => b.value - a.value);
  const stale = rows.filter((r) => !r.live).length;
  const [whole, cents] = fmt2.format(t.value).split(".");

  // allocation by type
  const byType = [
    { key: "stock", label: "Stocks", value: rows.filter((r) => r.type === "stock").reduce((s, r) => s + r.value, 0) },
    { key: "etf", label: "ETFs", value: rows.filter((r) => r.type === "etf").reduce((s, r) => s + r.value, 0) },
    { key: "certificate", label: "Certificates", value: rows.filter((r) => r.type === "certificate").reduce((s, r) => s + r.value, 0) },
    { key: "crypto", label: "Crypto", value: rows.filter((r) => r.type === "crypto").reduce((s, r) => s + r.value, 0) },
  ].filter((x) => x.value > 0);
  const share = (v) => (t.value ? (v / t.value) * 100 : 0);

  const allocBar = byType.map((x) =>
    `<div class="alloc__seg alloc__seg--${x.key}" style="flex:${x.value}" title="${x.label}: ${fmtEur(x.value)} (${share(x.value).toFixed(1)}%)"></div>`).join("");
  const allocLegend = byType.map((x) => `
    <li><span class="legend__sw" style="background:var(--${{ stock: "stocks", etf: "etfs", certificate: "certs", crypto: "crypto" }[x.key]})"></span>
      <span>${x.label}</span><span class="legend__val">${fmtEur(x.value)}</span><span class="legend__pct">${share(x.value).toFixed(1)}%</span></li>`).join("");

  const top = pos.slice(0, 5);
  const topRows = top.map((p) => `
    <li class="row row--link" data-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""} tabindex="0" role="button">
      <div class="row__id">
        <div class="row__title">${esc(p.label)}</div>
        <div class="row__bar" title="${share(p.value).toFixed(1)}% of portfolio"><span style="width:${share(p.value)}%"></span></div>
      </div>
      <div class="row__nums">
        <div class="row__price">${fmtEur(p.value)}</div>
        <div class="holding__sub">${share(p.value).toFixed(1)}%</div>
      </div>
    </li>`).join("");

  const analysts = getAnalysts();

  body.innerHTML = `
    <section class="hero-num" id="hero-num" role="button" tabindex="0" aria-label="Show a chart of your whole portfolio">
      <div class="hero-num__label">Total value</div>
      <div class="hero-num__value"><small>€</small>${whole}<small>.${cents}</small></div>
      <div class="hero-num__sub">
        <span class="pill ${dir(t.day)}">${fmtEurSigned(t.day)} · ${fmtPct(t.dayPct)}</span><span>last trading day</span>
      </div>
    </section>

    <div class="tiles">
      <div class="tile"><div class="tile__label">Invested</div><div class="tile__value">${fmtEur(t.cost)}</div></div>
      <div class="tile"><div class="tile__label">Total return</div><div class="tile__value ${dir(t.gain)}">${fmtEurSigned(t.gain)}</div><div class="tile__sub ${dir(t.gain)}">${fmtPct(t.gainPct)}</div></div>
    </div>

    <div class="panels">
      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Allocation</h3><span class="card__hint">by value</span></div>
        <div class="alloc" role="img" aria-label="${byType.map((x) => `${x.label} ${share(x.value).toFixed(1)}%`).join(", ")}">${allocBar}</div>
        <ul class="legend">${allocLegend}</ul>
      </article>

      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Largest positions</h3><span class="card__hint">share of total</span></div>
        <ol class="rows weights">${topRows}</ol>
      </article>

      ${analysts ? `
      <article class="card panel card--up">
        <div class="card__head"><h3 class="card__title">Analysts' top buys</h3><span class="card__hint">12-month view</span></div>
        <ol class="rows">${analystRows(analysts.buys)}</ol>
      </article>
      <article class="card panel card--down">
        <div class="card__head"><h3 class="card__title">Weakest ratings</h3><span class="card__hint">12-month view</span></div>
        <ol class="rows">${analystRows(analysts.sells)}</ol>
      </article>
      ${lookupHtml("overview")}` : ""}
    </div>

    ${analysts ? `<p class="note">Wall Street analysts' 12-month consensus for ${analysts.count || ""} S&P 500 companies (Finnhub, ${esc(analysts.period || "")}). Their opinion, not advice from stonks.</p>` : ""}
    <a class="card linkcard" href="#/movers"><span><b>Market movers</b><span>Today's top gainers and losers in stocks and ETFs</span></span><span aria-hidden="true">→</span></a>
    ${stale ? `<p class="note"><span class="stale">●</span> ${stale} ${stale === 1 ? "holding has" : "holdings have"} no live price yet and ${stale === 1 ? "is" : "are"} valued at buy price. Prices are fetched from onvista when the app opens; try again in a moment.</p>` : ""}`;
}

/* ======================================================================
   Portfolio
   ====================================================================== */
let openPos = null;          // key (ISIN) of the unfolded position, kept across re-renders
const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

// All buys of one ISIN → one foldable position.
function lotGroups(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.key) || { key: r.key, isin: r.isin, tv: r.tv, label: r.label, realName: r.realName, nicknamed: r.nicknamed, sub: r.sub, type: r.type, live: r.live, price: r.price, lots: [], qty: 0, value: 0, cost: 0 };
    g.lots.push(r); g.qty += r.quantity; g.value += r.value; g.cost += r.cost;
    map.set(r.key, g);
  }
  return [...map.values()].map((g) => {
    g.lots.sort((a, b) => (b.buyDate || "").localeCompare(a.buyDate || ""));
    g.avgBuy = g.qty ? g.cost / g.qty : 0;
    g.gain = g.value - g.cost;
    g.gainPct = g.cost ? (g.gain / g.cost) * 100 : 0;
    return g;
  });
}

function renderPortfolio() {
  const body = $("pf-body");
  if (state.holdings === null) { $("pf-count").textContent = ""; body.innerHTML = loadingState(); return; }
  if (!state.holdings.length) { $("pf-count").textContent = ""; body.innerHTML = emptyState(); return; }

  const rows = state.holdings.map(valuate);
  // biggest gain first, biggest loss last; positions without a live price at the end
  const groups = lotGroups(rows).sort((a, b) => (b.live - a.live) || (b.gain - a.gain));
  const t = totals(rows);
  if (openPos && !groups.some((g) => g.key === openPos)) openPos = null;
  $("pf-count").textContent = `${groups.length} ${groups.length === 1 ? "position" : "positions"} · ${rows.length} ${rows.length === 1 ? "buy" : "buys"}`;

  body.innerHTML = `
    <div class="card" style="padding:0">
      <ul class="holdings">
        ${groups.map((g, i) => {
          const open = g.key === openPos;
          const buys = g.lots.length;
          return `
        <li class="pos${open ? " is-open" : ""}">
          <button class="holding pos__head" type="button" data-pos="${esc(g.key)}" aria-expanded="${open}" aria-controls="pos-${i}">
            <div class="row__id">
              <div class="row__title">${esc(g.label)}<span class="holding__tag holding__tag--${g.type}">${{ etf: "ETF", certificate: "Certificate", crypto: "Crypto" }[g.type] || "Stock"}</span></div>
              <div class="row__name">${fmtEur(g.value)}${g.live ? "" : ` · <span class="stale">no live price</span>`}</div>
            </div>
            <div class="row__nums">
              ${g.live ? `<div class="row__price ${dir(g.gain)}">${fmtEurSigned(g.gain)}</div>
              <span class="pill ${dir(g.gain)}">${fmtPct(g.gainPct)}</span>` : `<span class="holding__sub">—</span>`}
            </div>
            <svg class="pos__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="pos__body" id="pos-${i}"${open ? "" : " hidden"}>
            <div class="pos__namebox">
              <label class="pos__name">
                <span class="pos__name-label">Your name</span>
                <input class="input" data-pos-name="${esc(g.key)}" value="${g.nicknamed ? esc(g.label) : ""}" placeholder="${esc(g.realName)}" maxlength="60" autocomplete="off" enterkeyhint="done" />
              </label>
              ${venueSelect(g)}
              <p class="pos__real"><span>${esc(g.realName)}</span> · ${esc(g.sub)}</p>
              <p class="pos__real">${buys} ${buys === 1 ? "buy" : "buys"} · ${fmtQty.format(g.qty)} × ${fmtEur(g.avgBuy)}${buys > 1 ? " avg" : ""} → ${g.live ? fmtEur(g.price) : "no live price"}</p>
            </div>
            <div class="pos__chart" data-pos-chart="${esc(g.key)}"></div>
            <ol class="lots" aria-label="Buys of ${esc(g.label)}">
              ${g.lots.map((r) => `
              <li><a class="lot" href="#/edit/${encodeURIComponent(r.id)}" aria-label="Edit buy of ${esc(r.label)}${r.buyDate ? ` on ${fmtDate(r.buyDate)}` : ""}">
                <span class="lot__date">${r.buyDate ? fmtDate(r.buyDate) : "No date"}</span>
                <span class="lot__qty">${fmtQty.format(r.quantity)} × ${fmtEur(r.buyEur)}</span>
                <span class="lot__val">${fmtEur(r.value)}${r.live ? ` <span class="${dir(r.gain)}">${fmtPct(r.gainPct)}</span>` : ""}</span>
              </a></li>`).join("")}
            </ol>
          </div>
        </li>`; }).join("")}
      </ul>
      <div class="pf-total"><span>Total</span><span>${fmtEur(t.value)}</span></div>
    </div>`;
  if (openPos) fillPosChart(openPos);
}

function venueSelect(g) {
  const q = g.isin && state.isin[g.isin];
  if (!q?.quotes?.length) return "";
  const chosen = state.venues[g.isin] || "";
  const fmt = (v) => `${v.venue} · ${fmtEur(v.price)}`;
  return `<label class="pos__name">
    <span class="pos__name-label">Price from</span>
    <select class="input pos__venue" data-pos-venue="${esc(g.isin)}">
      <option value=""${chosen ? "" : " selected"}>Automatic (${esc(q.venue)} · ${fmtEur(q.price)})</option>
      ${q.quotes.map((v) => `<option value="${esc(v.venue)}"${v.venue === chosen ? " selected" : ""}>${esc(fmt(v))}</option>`).join("")}
    </select>
  </label>`;
}

function fillPosChart(key) {
  const host = document.querySelector(`[data-pos-chart="${CSS.escape(key)}"]`);
  if (!host) return;
  const g = lotGroups(state.holdings.map(valuate)).find((x) => x.key === key);
  if (!g) return;
  mountChart(host, g.isin || g.key, g.isin ? "EUR" : "USD", g.isin ? state.venues[g.isin] : undefined);
}

document.addEventListener("click", (e) => {
  const head = e.target.closest("[data-pos]");
  if (!head) return;
  const key = head.dataset.pos;
  const li = head.closest(".pos");
  const wasOpen = openPos === key;
  // fold whichever one is open (one chart at a time)
  document.querySelectorAll(".pos.is-open").forEach((el) => {
    el.classList.remove("is-open");
    el.querySelector("[data-pos]").setAttribute("aria-expanded", "false");
    el.querySelector(".pos__body").hidden = true;
    el.querySelector(".pos__chart").innerHTML = "";
  });
  openPos = wasOpen ? null : key;
  if (!openPos) return;
  li.classList.add("is-open");
  head.setAttribute("aria-expanded", "true");
  li.querySelector(".pos__body").hidden = false;
  fillPosChart(key);
});

// Pick the exchange a position is valued with.
document.addEventListener("change", async (e) => {
  const el = e.target;
  if (!el.matches?.("[data-pos-venue]") || !state.user) return;
  const key = el.dataset.posVenue;
  state.venues = { ...state.venues, [key]: el.value || undefined };
  if (!el.value) delete state.venues[key];
  renderCurrent();
  try {
    const { setVenue } = await import("./store.js?v=39");
    await setVenue(state.user.uid, key, el.value);
    toast(el.value ? `Valued with ${el.value} prices` : "Back to automatic prices");
  } catch (err) {
    console.error(err);
    toast("Couldn't save. Please try again.");
  }
});

// Rename a position: saved when you leave the field or press Enter; empty = back to the real name.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches?.("[data-pos-name]")) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener("focusout", async (e) => {
  const el = e.target;
  if (!el.matches?.("[data-pos-name]") || !state.user) return;
  const key = el.dataset.posName;
  const name = el.value.trim();
  if ((state.names[key] || "") === name) return;
  try {
    const { setName } = await import("./store.js?v=39");
    await setName(state.user.uid, key, name);
    toast(name ? `Renamed to ${name}` : "Back to the original name");
  } catch (err) {
    console.error(err);
    toast("Couldn't save the name. Please try again.");
  }
});

/* ======================================================================
   Add / edit sheet — "Bought [10] for [€100.00] each [today]"
   ====================================================================== */
const form = $("add-form");
const addSheet = $("add-sheet");
const f = { isin: $("f-isin"), qty: $("f-qty"), price: $("f-price"), date: $("f-date"), datetext: $("f-datetext") };
let editingId = null;
let pendingEditId = null;
let deleteArmed = null;
let addLastFocus = null;

const parseNum = (v) => parseFloat(String(v).trim().replace(/\s/g, "").replace(",", "."));
const guessType = (isin) => (isCryptoCode(isin) ? "crypto" : /^(IE|LU)/.test(isin) ? "etf" : "stock");
const isoToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local

function fillIsinList() {
  $("isin-list").innerHTML = Object.values(state.isin)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((q) => `<option value="${esc(q.isin)}">${esc(q.name)}</option>`).join("");
}

const NATIVE_SIZING = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
function sizePill(input) {
  // fallback for browsers without `field-sizing: content`
  if (NATIVE_SIZING) return;
  const len = Math.max(input.value.length, input.placeholder.length, 1);
  input.style.width = `${len * 0.62 + 0.2}em`;
}

// The date pill shows "today" / "yesterday" / "on 3 Mar 2024"; tap it and it becomes dd.mm.yyyy to type over.
const toDmy = (iso) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
function parseDmy(text) {
  // dd.mm.yyyy, dd.mm.yy or just dd.mm (then this year — or last year if that would be in the future)
  const m = text.trim().match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2}|\d{4})?)?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (m[3] && y < 100) y += 2000;
  const make = (yy) => { const dt = new Date(yy, mo - 1, d, 12); return dt.getFullYear() === yy && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt.toLocaleDateString("en-CA") : null; };
  let iso = make(y);
  if (iso && !m[3] && iso > isoToday()) iso = make(y - 1);
  return iso;
}
function updateDateShow() {
  if (document.activeElement === f.datetext) return;
  const v = f.date.value || isoToday();
  let text = "today";
  if (v !== isoToday()) {
    const d = new Date(`${v}T12:00:00`);
    const y = new Date(); y.setDate(y.getDate() - 1);
    text = v === y.toLocaleDateString("en-CA") ? "yesterday"
      : `on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })}`;
  }
  f.datetext.value = text;
  sizePill(f.datetext);
}
f.datetext.addEventListener("focus", () => {
  f.datetext.value = toDmy(f.date.value || isoToday());
  sizePill(f.datetext);
  requestAnimationFrame(() => f.datetext.select());
});
f.datetext.addEventListener("input", (e) => {
  f.datetext.parentElement.removeAttribute("aria-invalid");
  // Typing digits only fills in the dots: 14112026 → 14.11.2026. Typed dots are kept as they are.
  // Auto-format while the text is only digits and dots after full 2-digit day/month.
  if (!e.inputType?.startsWith("delete") && /^(\d{2}\.){0,2}\d*$/.test(f.datetext.value)) {
    const digits = f.datetext.value.replace(/\D/g, "").slice(0, 8);
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += "." + digits.slice(2, 4);
    if (digits.length > 4) out += "." + digits.slice(4, 8);
    f.datetext.value = out;
  }
  sizePill(f.datetext);
});
f.datetext.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); f.datetext.blur(); } });
f.datetext.addEventListener("blur", () => {
  const iso = parseDmy(f.datetext.value);
  if (iso && iso <= isoToday()) {
    f.date.value = iso;
    $("f-error").hidden = true;
  } else if (f.datetext.value.trim()) {
    f.datetext.parentElement.setAttribute("aria-invalid", "true");
    showError(iso ? "The buy date can't be in the future." : "Enter the date as dd.mm.yyyy or dd.mm, e.g. 14.11.2026.");
  }
  updateDateShow();
});

function updateTotal() {
  const q = parseNum(f.qty.value), p = parseNum(f.price.value);
  $("f-total").textContent = q > 0 && p > 0 ? `= ${fmtEur(q * p)} invested` : "";
}

function updateIsinHint() {
  const isin = f.isin.value.trim().toUpperCase();
  const hint = $("f-isin-hint");
  const q = state.isin[isin];
  if (!isin || !looksLikeId(isin)) hint.textContent = "";
  else if (isin.length < 12) hint.textContent = `${12 - isin.length} more character${isin.length === 11 ? "" : "s"}`;
  else if (!isValidId(isin)) hint.textContent = "That doesn't look like a valid ISIN or crypto code. Check for typos.";
  else if (q) {
    hint.innerHTML = `<b>${esc(q.name)}</b> · <span class="ok">${fmtEur(q.price)}</span> on ${esc(q.venue)}`;
    if (!f.price.value && !editingId) { f.price.placeholder = q.price.toFixed(2); sizePill(f.price); }
  } else {
    hint.textContent = "Looking it up…";
    lookupLive(isin).then((found) => {
      if (f.isin.value.trim().toUpperCase() !== isin) return; // user typed on
      if (found) updateIsinHint();
      else hint.textContent = "Couldn't find a price for this ISIN right now. You can still add it.";
    });
  }
}

// The field takes an ISIN (or flatex crypto code) or a name to search for.
const looksLikeId = (v) => /^[A-Z]{2}\d/.test(v) || /^XFC/.test(v);
let searchTimer = null, searchToken = 0;

function hideResults() {
  $("f-results").hidden = true;
  $("f-results").innerHTML = "";
}

function pickResult(isin) {
  f.isin.value = isin;
  hideResults();
  updateIsinHint();
  f.qty.focus();
}

async function runSearch(text) {
  const mine = ++searchToken;
  const q = text.trim().toLowerCase();
  const { CRYPTO } = await import("./crypto.js?v=39");
  const coins = Object.entries(CRYPTO)
    .filter(([, c]) => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase() === q)
    .map(([code, c]) => ({ isin: code, name: `${c.name} (${c.ticker})`, type: "crypto" }));
  let found = [];
  try {
    const { searchInstruments } = await import("./onvista.js?v=39");
    found = await searchInstruments(text.trim());
  } catch (e) { console.warn("Search failed", e); }
  if (mine !== searchToken) return;
  const list = [...coins, ...found].slice(0, 8);
  const label = { etf: "ETF", certificate: "Certificate", crypto: "Crypto", stock: "Stock" };
  $("f-results").innerHTML = list.length
    ? list.map((r) => `<li><button type="button" class="result" role="option" data-pick="${esc(r.isin)}">
        <span class="result__name">${esc(r.name)}</span>
        <span class="result__meta">${esc(r.isin)} · <span class="holding__tag holding__tag--${r.type}">${label[r.type]}</span></span>
      </button></li>`).join("")
    : `<li class="result result--none">Nothing found for “${esc(text.trim())}”.</li>`;
  $("f-results").hidden = false;
  $("f-isin-hint").textContent = "";
}

f.isin.addEventListener("input", () => {
  f.isin.removeAttribute("aria-invalid");
  const compact = f.isin.value.toUpperCase().replace(/\s/g, "");
  clearTimeout(searchTimer);
  if (!f.isin.value.trim()) { searchToken++; hideResults(); updateIsinHint(); return; }
  if (looksLikeId(compact)) {
    searchToken++;
    hideResults();
    if (f.isin.value !== compact) {
      const pos = f.isin.selectionStart;
      f.isin.value = compact;
      try { f.isin.setSelectionRange(pos, pos); } catch {}
    }
    updateIsinHint();
    if (isValidId(compact) && !f.qty.value) f.qty.focus();
    return;
  }
  if (f.isin.value.trim().length < 2) { hideResults(); $("f-isin-hint").textContent = ""; return; }
  $("f-isin-hint").textContent = "Searching…";
  searchTimer = setTimeout(() => runSearch(f.isin.value), 250);
});
f.isin.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("f-results").hidden) {
    const first = $("f-results").querySelector("[data-pick]");
    if (first) { e.preventDefault(); pickResult(first.dataset.pick); }
  }
});
$("f-results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (b) pickResult(b.dataset.pick);
});
[f.qty, f.price].forEach((el) => {
  el.addEventListener("input", () => { el.parentElement.removeAttribute("aria-invalid"); sizePill(el); updateTotal(); });
  el.parentElement.addEventListener("click", () => el.focus());
});

function resetDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  $("f-delete").textContent = "Delete holding";
}

function showError(msg) {
  $("f-error").textContent = msg;
  $("f-error").hidden = false;
}

function openAdd(id) {
  form.reset();
  hideResults();
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  $("f-error").hidden = true;
  resetDelete();
  editingId = null;
  pendingEditId = null;
  f.price.placeholder = "100.00";
  f.date.value = isoToday();

  if (id) {
    if (state.holdings === null) { pendingEditId = id; return; }
    const h = state.holdings.find((x) => x.id === id);
    if (!h) { toast("That holding doesn't exist anymore"); return; }
    editingId = id;
    $("add-title").textContent = "Edit holding";
    $("f-submit").textContent = "Save";
    $("f-delete").hidden = false;
    f.isin.value = h.isin || "";
    f.qty.value = String(h.quantity);
    f.price.value = h.isin ? String(h.buyPrice) : "";
    f.date.value = h.buyDate || isoToday();
    if (!h.isin) showError(`This holding was added by ticker (${h.symbol}, USD). Enter its ISIN and the buy price in EUR to switch it over.`);
  } else {
    $("add-title").textContent = "Add holding";
    $("f-submit").textContent = "Add";
    $("f-delete").hidden = true;
  }
  updateIsinHint(); updateDateShow(); updateTotal();
  [f.qty, f.price].forEach(sizePill);

  addLastFocus = document.activeElement;
  addSheet.hidden = false;
  document.body.classList.add("sheet-open");
  document.querySelector('.tab[data-tab="add"]')?.setAttribute("aria-current", "page");
  requestAnimationFrame(() => {
    addSheet.classList.add("is-open");
    if (!id) f.isin.focus({ preventScroll: true });
  });
}

function closeAdd() {
  if (addSheet.hidden) return;
  addSheet.classList.remove("is-open");
  document.body.classList.remove("sheet-open");
  document.querySelector('.tab[data-tab="add"]')?.removeAttribute("aria-current");
  pendingEditId = null;
  setTimeout(() => { addSheet.hidden = true; }, 220);
  addLastFocus?.focus?.({ preventScroll: true });
}
// Keep the sheet above the on-screen keyboard: size it to the visible part of the screen.
const vv = window.visualViewport;
function syncViewport() {
  if (!vv) return;
  const r = document.documentElement.style;
  r.setProperty("--vvh", `${vv.height}px`);
  r.setProperty("--vvtop", `${vv.offsetTop}px`);
}
vv?.addEventListener("resize", syncViewport);
vv?.addEventListener("scroll", syncViewport);
syncViewport();
// When a field in the sheet gets focus, bring it into view once the keyboard has settled.
form.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!el.matches("input")) return;
  setTimeout(() => { if (document.activeElement === el) (el.closest(".pill") || el).scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 320);
});

addSheet.querySelectorAll("[data-close-add]").forEach((el) => el.addEventListener("click", closeAdd));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAdd(); });

function firestoreMessage(e) {
  if (e?.code === "permission-denied") return "Firestore blocked this. Check the security rules (see README).";
  if (e?.code === "unavailable") return "You seem to be offline. Try again in a moment.";
  if (e?.code === "not-found" || /database.*does not exist/i.test(e?.message || "")) return "Firestore isn't set up yet. Create the database in the Firebase console.";
  return "Couldn't save. Please try again.";
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("f-error").hidden = true;
  const isin = f.isin.value.trim().toUpperCase();
  const quantity = parseNum(f.qty.value);
  const buyPrice = parseNum(f.price.value);
  let bad = null;
  if (!isValidId(isin)) bad = [f.isin, f.isin, looksLikeId(isin) ? "That ISIN isn't valid. Check for typos." : "Pick one of the results, or enter an ISIN."];
  else if (!f.date.value) bad = [f.datetext, f.datetext.parentElement, "Enter the buy date as dd.mm.yyyy."];
  else if (!(quantity > 0)) bad = [f.qty, f.qty.parentElement, "How many did you buy?"];
  else if (!(buyPrice > 0)) bad = [f.price, f.price.parentElement, "What did you pay per share (EUR)?"];
  if (bad) { bad[1].setAttribute("aria-invalid", "true"); bad[0].focus(); showError(bad[2]); return; }

  const q = state.isin[isin];
  const btn = $("f-submit");
  btn.disabled = true;
  try {
    const { saveHolding } = await import("./store.js?v=39");
    await saveHolding(state.user.uid, editingId, {
      isin, quantity, buyPrice, buyDate: f.date.value,
      type: q?.type || guessType(isin), name: q?.name || "",
    });
    const label = q?.name || isin;
    toast(editingId ? `Saved ${label}` : `Added ${label}`);
    closeAdd();
  } catch (e) {
    console.error(e);
    showError(firestoreMessage(e));
  } finally {
    btn.disabled = false;
  }
});

$("f-delete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!deleteArmed) {
    $("f-delete").textContent = "Tap again to delete";
    deleteArmed = setTimeout(resetDelete, 3000);
    return;
  }
  resetDelete();
  const label = state.isin[f.isin.value]?.name || f.isin.value || "holding";
  try {
    const { deleteHolding } = await import("./store.js?v=39");
    await deleteHolding(state.user.uid, editingId);
    toast(`Removed ${label}`);
    closeAdd();
  } catch (e) {
    console.error(e);
    showError(firestoreMessage(e));
  }
});

/* ======================================================================
   Chart sheet
   ====================================================================== */
const sheet = $("sheet");
let lastFocus = null;

function openChart(symbol, isin) {
  const q = isin ? quoteFor(isin) : state.prices.get(symbol);
  const money = isin ? fmtEur : fmtUsd;
  const moneySigned = isin ? fmtEurSigned : fmtUsdSigned;

  const nick = isin && state.names[isin];
  $("sheet-sym").textContent = isin ? (nick || q?.name || isin) : symbol;
  $("sheet-name").textContent = isin ? `${nick && q?.name ? `${q.name} · ` : ""}${isin}${q?.venue ? ` · ${q.venue}` : ""}` : (q?.name || "");
  $("sheet-sym").classList.toggle("sheet__sym--name", Boolean(isin));
  $("sheet-price").textContent = q ? money(q.price) : "";
  const pill = $("sheet-pill");
  pill.hidden = !q;
  if (q) { pill.className = `pill ${dir(q.changePct)}`; pill.textContent = `${moneySigned(q.change)} · ${fmtPct(q.changePct)}`; }

  mountChart($("sheet-chart"), isin || symbol, isin ? "EUR" : "USD", isin ? state.venues[isin] : undefined);

  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}

// Tap the total value → your whole portfolio over time.
function openPortfolioChart() {
  if (!state.holdings?.length) return;
  const rows = state.holdings.map(valuate);
  const t = totals(rows);
  const usd = state.fx.USD || 1;
  const byKey = new Map();
  for (const r of rows) {
    const id = r.isin || r.symbol;
    if (!id) continue;
    const p = byKey.get(id) || { id, currency: r.isin ? "EUR" : "USD", venue: r.isin ? state.venues[r.isin] : undefined, toEur: r.isin ? 1 : 1 / usd, lots: [] };
    p.lots.push({ qty: r.quantity, buyEur: r.buyEur, date: r.buyDate || "" });
    byKey.set(id, p);
  }
  $("sheet-sym").textContent = "Your portfolio";
  $("sheet-sym").classList.add("sheet__sym--name");
  $("sheet-name").textContent = `${byKey.size} ${byKey.size === 1 ? "position" : "positions"} · dashed line: invested`;
  $("sheet-price").textContent = fmtEur(t.value);
  const pill = $("sheet-pill");
  pill.hidden = false;
  pill.className = `pill ${dir(t.day)}`;
  pill.textContent = `${fmtEurSigned(t.day)} · ${fmtPct(t.dayPct)}`;
  import("./chart.js?v=39").then(({ mountPortfolioChart }) => mountPortfolioChart($("sheet-chart"), { positions: [...byKey.values()] }));
  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}
document.addEventListener("click", (e) => { if (e.target.closest?.("#hero-num")) openPortfolioChart(); });
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("#hero-num")) { e.preventDefault(); openPortfolioChart(); }
});

// Our own chart (js/chart.js): onvista history for securities, CoinGecko for crypto.
async function mountChart(host, id, currency, venue) {
  const { mountPriceChart } = await import("./chart.js?v=39");
  mountPriceChart(host, { id, currency, venue });
}

function closeChart() {
  if (sheet.hidden) return;
  sheet.classList.remove("is-open");
  document.body.classList.remove("sheet-open");
  setTimeout(() => { sheet.hidden = true; $("sheet-chart").innerHTML = ""; }, 220);
  lastFocus?.focus?.();
}

document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-chart]");
  if (row) openChart(row.dataset.chart, row.dataset.isin);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeChart();
  const row = e.target.closest?.("[data-chart]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openChart(row.dataset.chart, row.dataset.isin); }
});
$("sheet-close").addEventListener("click", closeChart);
$("sheet-backdrop").addEventListener("click", closeChart);
window.addEventListener("hashchange", closeChart);

/* ======================================================================
   Router
   ====================================================================== */
const PROTECTED = ["overview", "portfolio", "you"];
const LEGAL = ["imprint", "privacy"];

function renderLegal(kind) {
  const d = legalDoc(kind);
  const back = state.user ? "#/overview" : "#/";
  let html = `<a class="back" href="${back}">← Back</a><h2>${esc(d.title)}</h2>`;
  for (const sec of d.sections) html += `<h3>${esc(sec.h)}</h3>` + sec.p.map((t) => `<p>${esc(t)}</p>`).join("");
  $("legal-body").innerHTML = html;
}

function renderCurrent() {
  withLookupFocus(() => {
    if (state.view === "overview") renderOverview();
    else if (state.view === "portfolio") renderPortfolio();
  });
}

function route() {
  let [name, arg] = location.hash.replace(/^#\/?/, "").split("/");

  // Add / edit open as a sheet on top of the current screen.
  if (name === "add" || name === "edit") {
    const under = state.view && state.view !== "home" ? state.view : "overview";
    history.replaceState(null, "", `#/${under}`);
    if (state.user) openAdd(name === "edit" ? decodeURIComponent(arg || "") : null);
    else if (!state.authReady) pendingRoute = [name, arg];
    name = under;
  }

  // Signed in, the overview is the start page; the market movers live at #/movers.
  let view = PROTECTED.includes(name) || LEGAL.includes(name) ? name : name === "movers" || name === "markets" ? "home" : state.user ? "overview" : "home";

  if (PROTECTED.includes(view) && !state.user) {
    if (!state.authReady) { document.querySelectorAll(".view").forEach((v) => (v.hidden = true)); return; }
    view = "home";
    if (location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
  }

  const section = LEGAL.includes(view) ? "legal" : view;
  const changed = state.view !== view;
  state.view = view;

  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${section}`));
  document.querySelector(".foot__note").hidden = view !== "home";
  document.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.tab === section || (t.dataset.tab === "add" && !addSheet.hidden)) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });

  if (changed) window.scrollTo(0, 0);
  if (section === "legal") renderLegal(view);
  if (section === "you") renderYou();
  renderCurrent();
}
let pendingRoute = null;
window.addEventListener("hashchange", route);

/* Swipe left/right to switch between Overview and Portfolio (like the tabs in Snapchat). */
const SWIPE_TABS = ["overview", "portfolio"];
const TAB_HASH = { home: "#/markets", overview: "#/overview", portfolio: "#/portfolio", you: "#/you" };
let swipe = null;
document.addEventListener("touchstart", (e) => {
  swipe = null;
  if (!state.user || e.touches.length !== 1 || !SWIPE_TABS.includes(state.view)) return;
  if (e.target.closest?.(".switch")) return;
  if (!$("add-sheet").hidden || !$("sheet").hidden) return;
  // charts use horizontal drags to read prices; inputs and buttons keep their own gestures
  if (e.target.closest?.(".pchart, input, textarea, select, .tabbar")) return;
  const t = e.touches[0];
  swipe = { x: t.clientX, y: t.clientY, t: Date.now() };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, dt = Date.now() - swipe.t;
  swipe = null;
  if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6 || dt > 700) return;
  const i = SWIPE_TABS.indexOf(state.view);
  const next = SWIPE_TABS[i + (dx < 0 ? 1 : -1)];
  if (!next) return;
  const el = $(`view-${next}`);
  el.classList.remove("slide-from-right", "slide-from-left");
  void el.offsetWidth; // restart the animation
  el.classList.add(dx < 0 ? "slide-from-right" : "slide-from-left");
  location.hash = TAB_HASH[next];
}, { passive: true });

function renderYou() {
  const u = state.user;
  if (!u) return;
  $("you-name").textContent = u.displayName || "Signed in";
  $("you-mail").textContent = u.email || "";
  if (u.photoURL) $("you-avatar").src = u.photoURL;
  else $("you-avatar").removeAttribute("src");
}

/* ======================================================================
   Auth
   ====================================================================== */
async function handleSignIn() {
  if (!isConfigured) { toast("Firebase isn't configured yet. Add your config to js/firebase-config.js"); return; }
  try {
    await signIn();
    location.hash = "#/overview";
  } catch (e) {
    if (e?.code === "auth/popup-closed-by-user" || e?.code === "auth/cancelled-popup-request") return;
    if (e?.code === "auth/unauthorized-domain") toast("Add this domain under Firebase → Authentication → Settings → Authorized domains");
    else toast("Sign-in failed. Please try again.");
    console.error(e);
  }
}

$("signin").addEventListener("click", handleSignIn);
$("cta-signin").addEventListener("click", handleSignIn);
$("you-signout").addEventListener("click", () => $("signout").click());
// Tap your picture → small menu with Sign out
function setUserMenu(open) {
  $("user-menu").hidden = !open;
  $("user-btn").setAttribute("aria-expanded", String(open));
  if (open) $("signout").focus();
}
$("user-btn").addEventListener("click", (e) => { e.stopPropagation(); setUserMenu($("user-menu").hidden); });
document.addEventListener("click", (e) => { if (!e.target.closest?.("#user")) setUserMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setUserMenu(false); });
$("signout").addEventListener("click", async () => {
  setUserMenu(false);
  try { await signOutUser(); location.hash = "#/"; } catch (e) { console.error(e); }
});

async function startHoldings(uid) {
  state.holdings = null;
  state.names = {};
  let store;
  try {
    store = await import("./store.js?v=39");
  } catch (e) {
    console.error("Couldn't load store.js", e);
    state.holdings = [];
    renderCurrent();
    return;
  }
  // holdings first and on their own: a problem with names must never hide your holdings
  try {
    state.unsubHoldings = await store.watchHoldings(uid, (list) => {
      state.holdings = list;
      priceMissingHoldings();
      if (pendingEditId) openAdd(pendingEditId);
      renderCurrent();
    }, (e) => {
      console.error("Holdings listener failed", e);
      state.holdings = [];
      renderCurrent();
      toast(firestoreMessage(e));
    });
  } catch (e) {
    console.error(e);
    state.holdings = [];
    renderCurrent();
  }
  try {
    state.unsubNames = await store.watchNames?.(uid, (names, venues) => {
      state.names = names;
      state.venues = venues || {};
      // don't re-render under the user's fingers while they're typing a name
      if (!document.activeElement?.matches?.("[data-pos-name]")) renderCurrent();
    });
  } catch (e) {
    console.warn("Custom names unavailable", e);
  }
}

onUser((user) => {
  const signedIn = Boolean(user);
  state.user = user;
  state.authReady = true;
  $("signin").hidden = signedIn;
  $("user").hidden = !signedIn;
  $("cta-signin").hidden = signedIn;
  $("cta-portfolio").hidden = !signedIn;
  $("tabbar").hidden = !signedIn;
  document.body.classList.toggle("has-tabbar", signedIn);

  state.unsubHoldings?.();
  state.unsubHoldings = null;
  state.unsubNames?.();
  state.unsubNames = null;
  if (user) {
    $("user-name").textContent = user.displayName || user.email || "";
    if (user.photoURL) $("user-avatar").src = user.photoURL;
    else $("user-avatar").removeAttribute("src");
    startHoldings(user.uid);
  } else {
    state.holdings = null;
  }
  route();
  if (user && pendingRoute) { const [n, a] = pendingRoute; pendingRoute = null; openAdd(n === "edit" ? decodeURIComponent(a || "") : null); }
}).catch((e) => {
  console.error("Auth init failed", e);
  state.authReady = true;
  route();
});

/* ======================================================================
   Stay fresh: GitHub Pages lets browsers cache the page for ~10 minutes.
   If a newer version is deployed, reload once to pick it up.
   ====================================================================== */
async function checkForUpdate() {
  try {
    const mine = new URL(import.meta.url).searchParams.get("v");
    if (!mine) return;
    const html = await (await fetch(`./?fresh=${Date.now()}`, { cache: "no-store" })).text();
    const live = html.match(/js\/app\.js\?v=(\d+)/)?.[1];
    if (!live || live === mine) return;
    const key = `stonks-reloaded-${live}`;
    if (sessionStorage.getItem(key)) return; // never loop
    sessionStorage.setItem(key, "1");
    location.reload();
  } catch {}
}
checkForUpdate();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

renderHome();
route();
loadMarket();
loadAnalysts();
loadPrices();
