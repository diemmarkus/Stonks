import { isConfigured, signIn, signOutUser, onUser } from "./firebase.js";
import { legalDoc, CHARTS_KEY } from "./legal.js";

const $ = (id) => document.getElementById(id);
const fmt2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const sign = (n) => (n > 0 ? "+" : n < 0 ? "−" : "");
const fmtPct = (n) => `${sign(n)}${Math.abs(n).toFixed(2)}%`;
const fmtUsd = (n) => `$${fmt2.format(n)}`;
const fmtUsdSigned = (n) => `${sign(n)}$${fmt2.format(Math.abs(n))}`;
const dir = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stampOf = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

$("year").textContent = new Date().getFullYear();

const state = {
  user: null,
  authReady: false,
  market: null,        // movers.json
  prices: new Map(),   // symbol → quote
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
    fillSymbolList();
    renderCurrent();
  } catch (e) {
    console.error("Loading movers failed", e);
    $("boards").innerHTML = "";
    $("note").textContent = "Couldn't load today's movers. Try again in a bit.";
  }
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
  }).join("");
  if (!data) return;
  const stamp = stampOf(data.updatedAt);
  $("asof").textContent = `Movers · ${stamp}`;
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

/* ======================================================================
   Valuation
   ====================================================================== */
function valuate(h) {
  const q = state.prices.get(h.symbol);
  const live = Boolean(q);
  const price = live ? q.price : h.buyPrice;
  const value = h.quantity * price;
  const cost = h.quantity * h.buyPrice;
  return {
    ...h,
    name: h.name || q?.name || "",
    live,
    price,
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
    const p = map.get(r.symbol) || { symbol: r.symbol, name: r.name, type: r.type, live: r.live, dayPct: r.dayPct, value: 0, cost: 0, dayChange: 0, prevValue: 0 };
    p.value += r.value; p.cost += r.cost; p.dayChange += r.dayChange; p.prevValue += r.prevValue;
    map.set(r.symbol, p);
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
    </div>`;
}

function loadingState() {
  return `<p class="note">Loading your holdings…</p>`;
}

function renderOverview() {
  const body = $("ov-body");
  const m = state.market;
  $("ov-asof").textContent = m ? `Prices · ${stampOf(m.marketTime || m.updatedAt)}` : "";
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
  ].filter((x) => x.value > 0);
  const share = (v) => (t.value ? (v / t.value) * 100 : 0);

  const allocBar = byType.map((x) =>
    `<div class="alloc__seg alloc__seg--${x.key}" style="flex:${x.value}" title="${x.label}: ${fmtUsd(x.value)} (${share(x.value).toFixed(1)}%)"></div>`).join("");
  const allocLegend = byType.map((x) => `
    <li><span class="legend__sw" style="background:var(--${x.key === "stock" ? "stocks" : "etfs"})"></span>
      <span>${x.label}</span><span class="legend__val">${fmtUsd(x.value)}</span><span class="legend__pct">${share(x.value).toFixed(1)}%</span></li>`).join("");

  const top = pos.slice(0, 5);
  const topRows = top.map((p) => `
    <li class="row${p.live ? " row--link" : ""}"${p.live ? ` data-chart="${esc(p.symbol)}" tabindex="0" role="button"` : ""}>
      <div class="row__id">
        <div class="row__sym">${esc(p.symbol)}</div>
        <div class="row__name">${esc(p.name)}</div>
        <div class="row__bar" title="${share(p.value).toFixed(1)}% of portfolio"><span style="width:${share(p.value)}%"></span></div>
      </div>
      <div class="row__nums">
        <div class="row__price">${fmtUsd(p.value)}</div>
        <div class="holding__sub">${share(p.value).toFixed(1)}%</div>
      </div>
    </li>`).join("");

  const today = pos.filter((p) => p.live).sort((a, b) => b.dayPct - a.dayPct);
  const todayRows = today.slice(0, 5).map((p) => `
    <li class="row row--link" data-chart="${esc(p.symbol)}" tabindex="0" role="button">
      <div class="row__id"><div class="row__sym">${esc(p.symbol)}</div><div class="row__name">${esc(p.name)}</div></div>
      <div class="row__nums">
        <div class="row__price">${fmtUsdSigned(p.dayChange)}</div>
        <span class="pill ${dir(p.dayPct)}">${fmtPct(p.dayPct)}</span>
      </div>
    </li>`).join("");

  body.innerHTML = `
    <section class="hero-num">
      <div class="hero-num__label">Total value</div>
      <div class="hero-num__value"><small>$</small>${whole}<small>.${cents}</small></div>
      <div class="hero-num__sub">
        <span class="pill ${dir(t.day)}">${fmtUsdSigned(t.day)} · ${fmtPct(t.dayPct)}</span><span>last trading day</span>
      </div>
    </section>

    <div class="tiles">
      <div class="tile"><div class="tile__label">Invested</div><div class="tile__value">${fmtUsd(t.cost)}</div></div>
      <div class="tile"><div class="tile__label">Total return</div><div class="tile__value ${dir(t.gain)}">${fmtUsdSigned(t.gain)}</div><div class="tile__sub ${dir(t.gain)}">${fmtPct(t.gainPct)}</div></div>
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

      ${today.length ? `
      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Your movers</h3><span class="card__hint">1D change</span></div>
        <ol class="rows movers-mini">${todayRows}</ol>
      </article>` : ""}
    </div>

    ${stale ? `<p class="note"><span class="stale">●</span> ${stale} ${stale === 1 ? "holding has" : "holdings have"} no live price yet and ${stale === 1 ? "is" : "are"} valued at buy price. New tickers are picked up by the next price update.</p>` : ""}`;
}

/* ======================================================================
   Portfolio
   ====================================================================== */
function renderPortfolio() {
  const body = $("pf-body");
  if (state.holdings === null) { $("pf-count").textContent = ""; body.innerHTML = loadingState(); return; }
  if (!state.holdings.length) { $("pf-count").textContent = ""; body.innerHTML = emptyState(); return; }

  const rows = state.holdings.map(valuate).sort((a, b) => b.value - a.value);
  const t = totals(rows);
  $("pf-count").textContent = `${rows.length} ${rows.length === 1 ? "holding" : "holdings"}`;

  body.innerHTML = `
    <div class="card" style="padding:0">
      <ul class="holdings">
        ${rows.map((r) => `
        <li>
          <a class="holding" href="#/edit/${encodeURIComponent(r.id)}" aria-label="Edit ${esc(r.symbol)}">
            <div class="row__id">
              <div class="row__sym">${esc(r.symbol)}<span class="holding__tag holding__tag--${r.type}">${r.type === "etf" ? "ETF" : "Stock"}</span></div>
              <div class="row__name">${esc(r.name) || "&nbsp;"}</div>
              <div class="holding__sub">${fmtQty.format(r.quantity)} × ${fmtUsd(r.buyPrice)} → ${r.live ? fmtUsd(r.price) : `<span class="stale">no live price</span>`}</div>
            </div>
            <div class="row__nums">
              <div class="row__price">${fmtUsd(r.value)}</div>
              ${r.live ? `<span class="pill ${dir(r.gain)}">${fmtPct(r.gainPct)}</span>` : `<span class="holding__sub">—</span>`}
            </div>
          </a>
        </li>`).join("")}
      </ul>
      <div class="pf-total"><span>Total</span><span>${fmtUsd(t.value)}</span></div>
    </div>`;
}

/* ======================================================================
   Add / edit
   ====================================================================== */
const form = $("add-form");
const f = { symbol: $("f-symbol"), name: $("f-name"), qty: $("f-qty"), price: $("f-price"), date: $("f-date") };
let editingId = null;
let pendingEditId = null;
let nameWasAuto = false;
let deleteArmed = null;

function setType(type) {
  form.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === type)));
}
const getType = () => form.querySelector('[data-type][aria-checked="true"]').dataset.type;
form.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => setType(b.dataset.type)));

function fillSymbolList() {
  $("symbol-list").innerHTML = [...state.prices.values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((q) => `<option value="${esc(q.symbol)}">${esc(q.name)}</option>`).join("");
}

function updateSymbolHint() {
  const sym = f.symbol.value.trim().toUpperCase();
  const hint = $("f-symbol-hint");
  const q = state.prices.get(sym);
  hint.classList.toggle("is-ok", Boolean(q));
  if (!sym) hint.textContent = "US-listed tickers get live prices.";
  else if (q) {
    hint.textContent = `${q.name} · ${fmtUsd(q.price)} now`;
    if (!f.name.value || nameWasAuto) { f.name.value = q.name; nameWasAuto = true; }
    if (q.kind) setType(q.kind);
    if (!f.price.value && !editingId) f.price.placeholder = fmt2.format(q.price).replace(/,/g, "");
  } else hint.textContent = "No live price yet. It's fetched in the next update (US tickers only).";
}
f.symbol.addEventListener("input", () => {
  const pos = f.symbol.selectionStart;
  f.symbol.value = f.symbol.value.toUpperCase().replace(/\s/g, "");
  try { f.symbol.setSelectionRange(pos, pos); } catch {}
  f.symbol.removeAttribute("aria-invalid");
  updateSymbolHint();
});
f.name.addEventListener("input", () => (nameWasAuto = false));
[f.qty, f.price].forEach((el) => el.addEventListener("input", () => el.removeAttribute("aria-invalid")));

function resetDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  $("f-delete").textContent = "Delete holding";
}

function enterAdd(id) {
  form.reset();
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  $("f-error").hidden = true;
  resetDelete();
  nameWasAuto = false;
  editingId = null;
  pendingEditId = null;
  f.price.placeholder = "150.00";

  if (id) {
    if (state.holdings === null) { pendingEditId = id; return; }
    const h = state.holdings.find((x) => x.id === id);
    if (!h) { toast("That holding doesn't exist anymore"); location.hash = "#/portfolio"; return; }
    editingId = id;
    $("add-title").textContent = "Edit holding";
    $("f-submit").textContent = "Save changes";
    $("f-delete").hidden = false;
    f.symbol.value = h.symbol; f.name.value = h.name || ""; f.qty.value = h.quantity; f.price.value = h.buyPrice; f.date.value = h.buyDate || "";
    setType(h.type);
  } else {
    $("add-title").textContent = "Add holding";
    $("f-submit").textContent = "Add to portfolio";
    $("f-delete").hidden = true;
    setType("stock");
    f.date.value = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  }
  updateSymbolHint();
  if (!id && matchMedia("(pointer: fine)").matches) f.symbol.focus();
}

function showError(msg) {
  $("f-error").textContent = msg;
  $("f-error").hidden = false;
}

function firestoreMessage(e) {
  if (e?.code === "permission-denied") return "Firestore blocked this. Check the security rules (see README).";
  if (e?.code === "unavailable") return "You seem to be offline. Try again in a moment.";
  if (e?.code === "not-found" || /database.*does not exist/i.test(e?.message || "")) return "Firestore isn't set up yet. Create the database in the Firebase console.";
  return "Couldn't save. Please try again.";
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("f-error").hidden = true;
  const symbol = f.symbol.value.trim().toUpperCase();
  const quantity = parseFloat(f.qty.value);
  const buyPrice = parseFloat(f.price.value);
  let bad = null;
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) bad = [f.symbol, "Enter a ticker symbol, e.g. AAPL."];
  else if (!(quantity > 0)) bad = [f.qty, "Quantity must be more than 0."];
  else if (!(buyPrice > 0)) bad = [f.price, "Enter the price you paid per share."];
  if (bad) { bad[0].setAttribute("aria-invalid", "true"); bad[0].focus(); showError(bad[1]); return; }

  const btn = $("f-submit");
  btn.disabled = true;
  try {
    const { saveHolding } = await import("./store.js");
    await saveHolding(state.user.uid, editingId, {
      symbol, quantity, buyPrice, type: getType(), name: f.name.value.trim(), buyDate: f.date.value,
    });
    toast(editingId ? `Saved ${symbol}` : `Added ${symbol} to your portfolio`);
    location.hash = "#/portfolio";
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
  const sym = f.symbol.value;
  try {
    const { deleteHolding } = await import("./store.js");
    await deleteHolding(state.user.uid, editingId);
    toast(`Removed ${sym}`);
    location.hash = "#/portfolio";
  } catch (e) {
    console.error(e);
    showError(firestoreMessage(e));
  }
});

/* ======================================================================
   Chart sheet (TradingView embed — free, no API key)
   ====================================================================== */
const sheet = $("sheet");
let lastFocus = null;

function openChart(symbol) {
  const q = state.prices.get(symbol);
  const up = !q || q.changePct >= 0;
  const line = up ? "#37e08f" : "#ff5d5d";
  const fill = up ? "rgba(55, 224, 143, 0.22)" : "rgba(255, 93, 93, 0.22)";

  $("sheet-sym").textContent = symbol;
  $("sheet-name").textContent = q?.name || "";
  $("sheet-price").textContent = q ? fmtUsd(q.price) : "";
  const pill = $("sheet-pill");
  pill.hidden = !q;
  if (q) { pill.className = `pill ${dir(q.changePct)}`; pill.textContent = `${fmtUsdSigned(q.change)} · ${fmtPct(q.changePct)}`; }

  const host = $("sheet-chart");
  let always = false;
  try { always = localStorage.getItem(CHARTS_KEY) === "on"; } catch {}
  if (always) loadTradingView(host, symbol, line, fill);
  else {
    host.innerHTML = `<div class="consent">
      <p>The chart is provided by TradingView (USA). Loading it sends your IP address to TradingView, which may set cookies. <a href="#/privacy">Privacy</a></p>
      <button class="btn btn--primary" type="button" id="chart-load">Load chart</button>
      <label><input type="checkbox" id="chart-always" /> Always load charts</label>
    </div>`;
    $("chart-load").addEventListener("click", () => {
      if ($("chart-always").checked) { try { localStorage.setItem(CHARTS_KEY, "on"); } catch {} }
      loadTradingView(host, symbol, line, fill);
    });
  }
  $("sheet-link").href = `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;

  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}

function loadTradingView(host, symbol, line, fill) {
  host.innerHTML = `<div class="tradingview-widget-container" style="height:100%;width:100%"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div></div>`;
  const s = document.createElement("script");
  s.src = "https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js";
  s.async = true;
  s.textContent = JSON.stringify({
    symbols: [[symbol, `${symbol}|1D`]],
    chartOnly: false, width: "100%", height: "100%", autosize: true, locale: "en",
    colorTheme: "dark", isTransparent: true, showVolume: false, showMA: false,
    hideDateRanges: false, hideMarketStatus: true, hideSymbolLogo: true,
    scalePosition: "right", scaleMode: "Normal", chartType: "area",
    fontFamily: "Inter Tight, system-ui, sans-serif", fontSize: "11",
    noTimeScale: false, valuesTracking: "1", changeMode: "price-and-percent",
    lineWidth: 2, lineType: 0, lineColor: line, topColor: fill, bottomColor: "rgba(0,0,0,0)",
    gridLineColor: "rgba(255,255,255,0.04)",
    dateRanges: ["1d|1", "1m|30", "3m|60", "12m|1D", "60m|1W", "all|1M"],
  });
  host.firstElementChild.appendChild(s);
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
  if (row) openChart(row.dataset.chart);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeChart();
  const row = e.target.closest?.("[data-chart]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openChart(row.dataset.chart); }
});
$("sheet-close").addEventListener("click", closeChart);
$("sheet-backdrop").addEventListener("click", closeChart);
window.addEventListener("hashchange", closeChart);

/* ======================================================================
   Router
   ====================================================================== */
const PROTECTED = ["overview", "add", "edit", "portfolio"];
const LEGAL = ["imprint", "privacy"];

function renderLegal(kind) {
  const d = legalDoc(kind);
  const back = state.user ? "#/overview" : "#/";
  let html = `<a class="back" href="${back}">← Back</a><h2>${esc(d.title)}</h2>`;
  for (const sec of d.sections) html += `<h3>${esc(sec.h)}</h3>` + sec.p.map((t) => `<p>${esc(t)}</p>`).join("");
  if (kind === "privacy") {
    let on = false;
    try { on = localStorage.getItem(CHARTS_KEY) === "on"; } catch {}
    html += `<h3>TradingView charts</h3><p>${on ? "Charts currently load without asking." : "Charts are only loaded when you tap \"Load chart\"."}</p>`
      + (on ? `<button class="btn btn--ghost" type="button" id="charts-off">Ask me again before loading charts</button>` : "");
  }
  $("legal-body").innerHTML = html;
  $("charts-off")?.addEventListener("click", () => {
    try { localStorage.removeItem(CHARTS_KEY); } catch {}
    toast("Charts will ask before loading");
    renderLegal(kind);
  });
}

function renderCurrent() {
  if (state.view === "overview") renderOverview();
  else if (state.view === "portfolio") renderPortfolio();
}

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  let view = PROTECTED.includes(name) || LEGAL.includes(name) ? name : "home";

  if (PROTECTED.includes(view) && !state.user) {
    if (!state.authReady) { document.querySelectorAll(".view").forEach((v) => (v.hidden = true)); return; }
    view = "home";
    if (location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
  }

  const section = view === "edit" ? "add" : LEGAL.includes(view) ? "legal" : view;
  const changed = state.view !== view || view === "edit";
  state.view = view;

  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${section}`));
  document.querySelector(".foot__note").hidden = view !== "home";
  document.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.tab === section) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });

  if (changed) window.scrollTo(0, 0);
  if (section === "legal") renderLegal(view);
  if (section === "add") enterAdd(view === "edit" ? decodeURIComponent(arg || "") : null);
  renderCurrent();
}
window.addEventListener("hashchange", route);

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
$("signout").addEventListener("click", async () => {
  try { await signOutUser(); location.hash = "#/"; } catch (e) { console.error(e); }
});

async function startHoldings(uid) {
  state.holdings = null;
  try {
    const { watchHoldings } = await import("./store.js");
    state.unsubHoldings = await watchHoldings(uid, (list) => {
      state.holdings = list;
      if (pendingEditId) enterAdd(pendingEditId);
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
  if (user) {
    $("user-name").textContent = user.displayName || user.email || "";
    if (user.photoURL) $("user-avatar").src = user.photoURL;
    else $("user-avatar").removeAttribute("src");
    startHoldings(user.uid);
  } else {
    state.holdings = null;
  }
  route();
}).catch((e) => {
  console.error("Auth init failed", e);
  state.authReady = true;
  route();
});

renderHome();
route();
loadMarket();
