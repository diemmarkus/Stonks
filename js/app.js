import { isConfigured, signIn, signOutUser, onUser, clearLocalData } from "./firebase.js?v=109";
import { legalDoc } from "./legal.js?v=109";
import { isCryptoCode } from "./crypto.js?v=109";

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
// "Today" / "Yesterday" / "Tomorrow" for dates close to now, else null
function relDay(when) {
  const d = new Date(when), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 864e5);
  return { "-1": "Yesterday", 0: "Today", 1: "Tomorrow" }[diff] || null;
}
const stampOf = (iso) => {
  const rel = relDay(iso);
  return rel
    ? `${rel}, ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

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

// Real Firestore store, or the in-memory demo portfolio (nothing saved, safe to show friends).
const loadStore = () => (state.demo ? import("./demo-store.js?v=109") : import("./store.js?v=109"));
const DEMO_USER = { uid: "demo", displayName: "Demo portfolio", email: "Sample data · nothing is saved", photoURL: "img/logo.svg", isDemo: true };

/* ---------- toast ---------- */
let toastTimer;
// toast(msg) or toast(msg, { label: "Undo", run }) — with an action it stays a little longer
function toast(msg, action) {
  const t = $("toast");
  t.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast__act";
    b.textContent = action.label;
    b.addEventListener("click", () => { t.hidden = true; action.run(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 3200);
}

/* ======================================================================
   Loading bar: a thin line at the top that fills while numbers are fetched
   ====================================================================== */
const loading = { total: 0, done: 0, timer: 0 };
function paintLoading() {
  const bar = $("loadbar");
  if (!bar) return;
  clearTimeout(loading.timer);
  if (loading.done >= loading.total) {
    bar.style.setProperty("--p", "100%");
    loading.timer = setTimeout(() => {
      bar.classList.remove("is-on");
      loading.total = loading.done = 0;
      setTimeout(() => { if (!loading.total) bar.style.setProperty("--p", "0%"); }, 300);
    }, 250);
  } else {
    bar.classList.add("is-on");
    bar.style.setProperty("--p", `${8 + (92 * loading.done) / loading.total}%`);
  }
}
// count a fetch until it settles (or 20 s, so the bar never hangs)
function track(promise) {
  loading.total++;
  paintLoading();
  let finish;
  const stop = new Promise((r) => { finish = r; setTimeout(r, 20000); });
  Promise.race([Promise.resolve(promise).catch(() => {}), stop]).then(() => { if (!finish.done) { finish.done = true; loading.done++; paintLoading(); } });
  return promise;
}

/* ======================================================================
   Device cache: last known prices and your portfolio, shown right away
   and refreshed in the background
   ====================================================================== */
const PRICE_CACHE = "stonks-prices-v1";
const SESSION_CACHE = "stonks-session-v1";
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function restorePrices() {
  const c = readJson(PRICE_CACHE);
  if (!c?.isin) return;
  for (const [k, q] of Object.entries(c.isin)) state.isin[k] = { ...q, liveLookup: true, stale: true };
  state.pricesAt = c.at || null;
}
let savePricesTimer;
function savePrices() {
  clearTimeout(savePricesTimer);
  savePricesTimer = setTimeout(() => {
    const isin = {};
    for (const [k, q] of Object.entries(state.isin)) if (q.liveLookup) { const { stale, liveLookup, ...rest } = q; isin[k] = rest; }
    writeJson(PRICE_CACHE, { at: state.pricesAt, isin });
  }, 500);
}
function saveSession() {
  if (state.demo || !state.user || state.user.isDemo || !state.holdings) return;
  const u = state.user;
  writeJson(SESSION_CACHE, {
    uid: u.uid,
    user: { uid: u.uid, displayName: u.displayName || "", email: u.email || "", photoURL: u.photoURL || "" },
    holdings: state.holdings.map(({ createdAt, updatedAt, ...h }) => h),
    names: state.names,
    venues: state.venues,
  });
}
function clearDeviceCache() {
  try { localStorage.removeItem(SESSION_CACHE); localStorage.removeItem(PRICE_CACHE); } catch {}
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
  if (liveTried.has(isin)) return liveTried.get(isin);
  const known = state.isin[isin];
  if ((known && !known.stale) || !isValidId(isin)) return Promise.resolve(known || null);
  {
    const lookup = isCryptoCode(isin)
      ? import("./crypto.js?v=109").then(({ lookupCrypto }) => lookupCrypto([isin])).then((r) => r[isin] || null)
      : import("./onvista.js?v=109").then(({ lookupIsin }) => lookupIsin(isin));
    liveTried.set(isin, lookup
      .then((q) => {
        if (q) {
          state.isin[isin] = { ...q, liveLookup: true };
          state.pricesAt = new Date().toISOString();
          savePrices();
          fillIsinList();
          renderCurrent();
        }
        return q;
      })
      .catch((e) => { console.warn(`Live lookup for ${isin} failed`, e); liveTried.delete(isin); return state.isin[isin] || null; }));
    track(liveTried.get(isin));
  }
  return liveTried.get(isin);
}
// prices for everything you hold: missing ones, and cached ones from your last visit (refreshed once per visit)
function priceMissingHoldings() {
  if (!state.pricesLoaded || !state.holdings) return;
  for (const h of state.holdings) if (h.isin && (!state.isin[h.isin] || state.isin[h.isin].stale)) lookupLive(h.isin);
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

function moverCard(d, title, body, info) {
  const i = info ? infoButton("About these movers") : null;
  return `
    <article class="card card--${d}">
      <div class="card__head"><h3 class="card__title">${title}</h3><span class="card__side">${rangePicker()}${i ? i.btn : ""}</span></div>
      ${i ? `<p class="info__text" id="${i.id}" hidden>${info}</p>` : ""}
      <ol class="rows">${body}</ol>
    </article>`;
}
// What the movers are based on — folded behind the (i) in the Top gainers card
const moversInfo = (data) => data && !data.sample
  ? `${moverRange === "1D" ? "Daily change" : `Change over ${moverRange} (from onvista's price history)`} among a fixed watchlist of ${data.quotes?.length ?? ""} large US-listed stocks and ETFs · prices via ${esc(data.source || "market data")} · updated ${stampOf(data.updatedAt)}. Not investment advice — just numbers.`
  : null;

// Analyst consensus: score from -2 (all strong sell) to +2 (all strong buy)
const ratingLabel = (score) => (score >= 1.2 ? "Strong buy" : score >= 0.5 ? "Buy" : score > -0.5 ? "Hold" : score > -1.2 ? "Sell" : "Strong sell");
function analystRows(items) {
  return items.map((r, idx) => {
    const buy = r.strongBuy + r.buy, hold = r.hold, sell = r.sell + r.strongSell;
    const seg = (n, cls) => (n ? `<span class="rating__seg ${cls}" style="flex:${n}"></span>` : "");
    return `
    <li class="row row--link" data-chart="${esc(r.symbol)}" data-name="${esc(r.name || "")}"${r.isin ? ` data-other-isin="${esc(r.isin)}"` : ""} tabindex="0" role="button" aria-label="Show chart for ${esc(r.name || r.symbol)}">
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

// Everything (NYSE + Nasdaq) lives in a bigger file, loaded only when you search.
let allLoading = null;
function loadAllAnalysts() {
  if (state.analystsAll || allLoading) return allLoading;
  allLoading = fetch(`data/analysts-all.json?t=${Date.now()}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      const rows = d.rows.map((r) => Object.fromEntries(d.fields.map((f, i) => [f, r[i]])));
      for (const r of rows) {
        r.total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
        r.score = r.total ? Math.round(((2 * r.strongBuy + r.buy - r.sell - 2 * r.strongSell) / r.total) * 100) / 100 : null;
      }
      state.analystsAll = rows.filter((r) => r.total > 0);
      document.querySelectorAll("[data-lookup-input]").forEach((el) => {
        const out = document.querySelector(`[data-lookup-results="${el.dataset.lookupInput}"]`);
        if (out) out.innerHTML = lookupResultsHtml(el.value);
      });
    })
    .catch((e) => console.warn("No full analyst list", e))
    .finally(() => { allLoading = null; });
  return allLoading;
}

function lookupMatches(q) {
  const a = getAnalysts();
  const list = state.analystsAll || a?.list || [];
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
  const list = state.analystsAll || getAnalysts()?.list;
  if (!q.trim()) return `<p class="lookup__hint">Type a name, ticker or ISIN of a US-listed company${list ? ` (${list.length.toLocaleString("en-US")} with ratings)` : ""}.</p>`;
  if (!list) { loadAllAnalysts(); return `<p class="lookup__hint">Loading analyst ratings…</p>`; }
  const hits = lookupMatches(q);
  return hits.length
    ? `<ol class="rows">${analystRows(hits)}</ol>`
    : `<p class="lookup__hint">No analyst ratings for “${esc(q.trim())}”. Only US-listed companies are covered (new ones are added over the week); ETFs have no analyst ratings.</p>`;
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
  if (e.target.open) { loadAllAnalysts(); e.target.querySelector("input")?.focus(); }
}, true);

// Small (i) button that unfolds an explanation inside its card.
let infoSeq = 0;
function infoButton(label) {
  const id = `info-${++infoSeq}`;
  return { id, btn: `<button class="info" type="button" data-info="${id}" aria-expanded="false" aria-controls="${id}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg></button>` };
}
const analystInfo = (a) => `Wall Street analysts' 12-month consensus for ${a.count || ""} S&P 500 companies (Finnhub, ${esc(a.period || "")}). Their opinion, not advice from stonks — always do your own research.`;

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-info]");
  if (!b) return;
  const box = document.getElementById(b.dataset.info);
  if (!box) return;
  const open = box.hidden;
  box.hidden = !open;
  b.setAttribute("aria-expanded", String(open));
});

function analystGroup(a) {
  const body = (items) => (a ? analystRows(items) : skeletonRows());
  const info = infoButton("About analyst ratings");
  return `
      <div class="group ${activeKind === "analysts" ? "is-active" : ""}" data-kind="analysts">
        <h2 class="group__title">Analyst ratings</h2>
        <div class="group__cards">
          <article class="card card--up"><div class="card__head"><h3 class="card__title">Top buys</h3><span class="card__side"><span class="card__hint">12-month view</span>${a ? info.btn : ""}</span></div>${a ? `<p class="info__text" id="${info.id}" hidden>${analystInfo(a)}</p>` : ""}<ol class="rows">${body((a?.buys || []).slice(0, 3))}</ol></article>
          <article class="card card--down"><div class="card__head"><h3 class="card__title">Weakest ratings</h3><span class="card__hint">12-month view</span></div><ol class="rows">${body((a?.sells || []).slice(0, 3))}</ol></article>
        </div>
        ${lookupHtml("markets")}
        ${a ? "" : `<p class="note">Analyst ratings appear after the next daily update.</p>`}
      </div>`;
}

// Movers over 1D (Finnhub) or 1W … 5Y (from onvista's history, added by the hourly job)
const MOVER_RANGE_KEY = "stonks-movers-range";
let moverRange = (() => { try { return localStorage.getItem(MOVER_RANGE_KEY) || "1D"; } catch { return "1D"; } })();
function moversFor(data, kind) {
  if (!data) return null;
  if (moverRange === "1D") return data[kind];
  const k = kind === "stocks" ? "stock" : "etf";
  const items = (data.quotes || []).filter((q) => q.kind === k && q.perf?.[moverRange] != null)
    .map((q) => ({ ...q, changePct: q.perf[moverRange] }))
    .sort((a, b) => b.changePct - a.changePct);
  if (!items.length) return { gainers: [], losers: [], none: true };
  return {
    gainers: items.filter((i) => i.changePct > 0).slice(0, 3),
    losers: items.filter((i) => i.changePct < 0).reverse().slice(0, 3),
  };
}
// a small drop-down in each movers card, where the "1D change" hint used to be
const rangePicker = () => `
  <label class="card__range">
    <select data-mover-range aria-label="Time range">${["1D", "1W", "1M", "1Y", "5Y"].map((r) => `<option value="${r}"${r === moverRange ? " selected" : ""}>${r} change</option>`).join("")}</select>
  </label>`;
document.addEventListener("change", (e) => {
  if (!e.target.matches?.("[data-mover-range]")) return;
  moverRange = e.target.value;
  try { localStorage.setItem(MOVER_RANGE_KEY, moverRange); } catch {}
  renderHome();
});

function renderHome() {
  keepExpand(renderHomeNow);
}
function renderHomeNow() {
  const data = state.market;
  $("boards").innerHTML = GROUPS.map(({ kind, title }) => {
    const g = moversFor(data, kind);
    const rows = (list, d) => (g.none ? `<li class="row"><p class="lookup__hint">${moverRange} changes appear after the next price update.</p></li>`
      : list.length ? moverRows(list, d) : `<li class="row"><p class="lookup__hint">None over ${moverRange}.</p></li>`);
    return `
      <div class="group ${kind === activeKind ? "is-active" : ""}" data-kind="${kind}">
        <h2 class="group__title">${title}</h2>
        <div class="group__cards">
          ${moverCard("up", "Top gainers", g ? rows(g.gainers, "up") : skeletonRows(), moversInfo(data))}
          ${moverCard("down", "Top losers", g ? rows(g.losers, "down") : skeletonRows())}
        </div>
      </div>`;
  }).join("") + analystGroup(getAnalysts());
  if (!data) return;
  const stamp = stampOf(data.updatedAt);
  $("asof").textContent = `Movers · ${stamp}`;
  $("mk-asof").textContent = `Updated · ${stamp}`;
  $("note").innerHTML = data.sample
    ? `<span class="badge">● Sample data.</span> Live numbers appear once the “Update movers” GitHub Action has run.`
    : ""; // source, watchlist and 'not advice' live behind the (i) in Top gainers
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
// Sells use the average buy price of the units held at that moment (Austrian-style
// moving average). Precomputed per position in date order: id → { avg, realized }.
let sellInfo = new Map();
function computeSells(holdings) {
  sellInfo = new Map();
  const byKey = new Map();
  for (const h of holdings) {
    const key = h.isin || h.symbol;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(h);
  }
  const usd = state.fx.USD || 1;
  for (const list of byKey.values()) {
    // buys before sells on the same day; undated buys first
    list.sort((a, b) => (a.buyDate || "").localeCompare(b.buyDate || "") || (a.side === "sell") - (b.side === "sell"));
    // FIFO: a sale uses up the oldest buys first; those units are frozen at their own buy price
    const open = []; // { id, left, px } in buy order
    for (const h of list) {
      const px = h.isin ? h.buyPrice : h.buyPrice / usd;
      if (h.side === "sell") {
        let need = h.quantity, basis = 0, q = 0;
        for (const lot of open) {
          if (need <= 1e-9) break;
          const take = Math.min(lot.left, need);
          if (take <= 0) continue;
          lot.left -= take; need -= take; q += take; basis += take * lot.px;
        }
        const avg = q > 0 ? basis / q : px;
        sellInfo.set(h.id, { avg, realized: q * px - basis, soldCost: basis });
      } else {
        const lot = { id: h.id, left: h.quantity, px };
        open.push(lot);
        sellInfo.set(h.id, lot); // buys: how many units of this lot are still held
      }
    }
  }
}
const heldUnits = (key, exceptId) => (state.holdings || [])
  .filter((h) => (h.isin || h.symbol) === key && h.id !== exceptId)
  .reduce((n, h) => n + (h.side === "sell" ? -h.quantity : h.quantity), 0);

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
  // FIFO: a buy counts only its units still held; a sale only carries its realised gain
  const sell = h.side === "sell";
  const info = sellInfo.get(h.id);
  const si = sell ? info : null;
  const left = sell ? 0 : Math.round((info?.left ?? h.quantity) * 1e8) / 1e8;
  const units = left;
  const histUnits = sell ? -h.quantity : h.quantity; // for the portfolio chart over time
  if (sell) buy = si?.avg ?? buy;
  const value = units * price;
  const cost = units * buy;
  const realized = si?.realized || 0;
  const soldCost = si?.soldCost || 0;
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
    sell,
    units,
    histUnits,
    left,
    sellPrice: sell ? (h.isin ? h.buyPrice : h.buyPrice / (state.fx.USD || 1)) : null,
    realized,
    soldCost,
    value,
    cost,
    gain: value - cost,
    gainPct: cost ? ((value - cost) / cost) * 100 : 0,
    dayChange: live ? units * q.change : 0,
    prevValue: live ? units * (q.price - q.change) : 0,
    dayPct: live ? q.changePct : 0,
  };
}

function totals(rows) {
  const t = rows.reduce((a, r) => {
    a.value += r.value; a.cost += r.cost; a.day += r.dayChange; a.prev += r.prevValue; a.realized += r.realized || 0; a.soldCost += r.soldCost || 0;
    return a;
  }, { value: 0, cost: 0, day: 0, prev: 0, realized: 0, soldCost: 0 });
  t.unrealized = t.value - t.cost;
  t.gain = t.unrealized + t.realized; // like flatex "Gesamt": open gain + gains already taken
  // % of everything ever put in: what you still hold plus the cost of what you sold
  const base = t.cost + t.soldCost;
  t.gainPct = base ? (t.gain / base) * 100 : 0;
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
  return [...map.values()].filter((p) => p.value > 0.005 || p.cost > 0.005);
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
    `;
}

function loadingState() {
  return `<p class="note">Loading your holdings…</p>`;
}

function renderOverview() {
  const body = $("ov-body");
  if (state.holdings === null) { body.innerHTML = loadingState(); return; }
  if (!state.holdings.length) { body.innerHTML = emptyState(); return; }

  const rows = state.holdings.map(valuate);
  const t = totals(rows);
  const sold = t.soldCost > 0; // anything sold → show the in/out and open/realised split
  const pos = positions(rows).sort((a, b) => b.value - a.value);
  const stale = rows.filter((r) => !r.live).length;
  const [whole, cents] = fmt2.format(t.value).split(".");

  // allocation by type
  // lowest to highest risk: broad funds, commodities, single companies, crypto
  const byType = [
    { key: "etf", label: "ETFs", value: rows.filter((r) => r.type === "etf").reduce((s, r) => s + r.value, 0) },
    { key: "certificate", label: "Certificates", value: rows.filter((r) => r.type === "certificate").reduce((s, r) => s + r.value, 0) },
    { key: "stock", label: "Stocks", value: rows.filter((r) => r.type === "stock").reduce((s, r) => s + r.value, 0) },
    { key: "crypto", label: "Crypto", value: rows.filter((r) => r.type === "crypto").reduce((s, r) => s + r.value, 0) },
  ].filter((x) => x.value > 0);
  const share = (v) => (t.value ? (v / t.value) * 100 : 0);

  const allocBar = byType.map((x) =>
    `<div class="alloc__seg alloc__seg--${x.key}" data-alloc="${x.key}" style="flex:${x.value}" title="${x.label}: ${fmtEur(x.value)} (${share(x.value).toFixed(1)}%)"></div>`).join("");
  const allocLegend = byType.map((x) => `
    <li class="legend__link" data-alloc="${x.key}" tabindex="0" role="button" aria-label="${x.label}: show the split"><span class="legend__sw" style="background:var(--${{ stock: "stocks", etf: "etfs", certificate: "certs", crypto: "crypto" }[x.key]})"></span>
      <span>${x.label}</span><span class="legend__val">${fmtEur(x.value)}</span><span class="legend__pct">${share(x.value).toFixed(1)}%</span></li>`).join("");

  const top = pos.slice(0, 3);
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
  const aInfo = infoButton("About analyst ratings");

  body.innerHTML = `
    <section class="hero-num" id="hero-num" role="button" tabindex="0" aria-label="Show a chart of your whole portfolio">
      <div class="hero-num__label">Total value</div>
      <div class="hero-num__value"><small>€</small>${whole}<small>.${cents}</small></div>
      <div class="hero-num__sub">
        <span class="pill ${dir(t.day)}">${fmtEurSigned(t.day)} · ${fmtPct(t.dayPct)}</span><span>last trading day</span>
      </div>
    </section>

    <div class="tiles">
      <div class="tile"><div class="tile__label">Invested</div><div class="tile__value">${fmtEur(t.cost)}</div>${sold ? `
        <dl class="tile__notes"><div><dt>Put in</dt><dd>${fmtEur(t.cost + t.soldCost)}</dd></div><div><dt>Sold for</dt><dd>${fmtEur(t.soldCost + t.realized)}</dd></div></dl>` : ""}</div>
      <div class="tile"><div class="tile__label">Total return</div><div class="tile__value ${dir(t.gain)}">${fmtEurSigned(t.gain)}</div><div class="tile__sub ${dir(t.gain)}">${fmtPct(t.gainPct)}</div>${sold ? `
        <dl class="tile__notes"><div><dt>Open</dt><dd class="${dir(t.unrealized)}">${fmtEurSigned(t.unrealized)}</dd></div><div><dt>Realised</dt><dd class="${dir(t.realized)}">${fmtEurSigned(t.realized)}</dd></div></dl>` : ""}</div>
    </div>

    <div class="panels">
      ${winnersCard(rows)}

      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Allocation</h3><span class="card__hint">by value</span></div>
        <div class="alloc" role="img" aria-label="${byType.map((x) => `${x.label} ${share(x.value).toFixed(1)}%`).join(", ")}">${allocBar}</div>
        <ul class="legend">${allocLegend}</ul>
      </article>

      ${yearsCard(rows)}

      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Largest positions</h3><span class="card__hint">share of total</span></div>
        <ol class="rows weights">${topRows}</ol>
      </article>

      ${analysts ? `
      <article class="card panel card--up">
        <div class="card__head"><h3 class="card__title">Analysts' top buys</h3><span class="card__side"><span class="card__hint">12-month view</span>${aInfo.btn}</span></div>
        <p class="info__text" id="${aInfo.id}" hidden>${analystInfo(analysts)}</p>
        <ol class="rows">${analystRows(analysts.buys.slice(0, 3))}</ol>
      </article>
      <article class="card panel card--down">
        <div class="card__head"><h3 class="card__title">Weakest ratings</h3><span class="card__hint">12-month view</span></div>
        <ol class="rows">${analystRows(analysts.sells.slice(0, 3))}</ol>
      </article>
      ${lookupHtml("overview")}` : ""}
    </div>

    ${stale ? `<p class="note"><span class="stale">●</span> ${stale} ${stale === 1 ? "holding has" : "holdings have"} no live price yet and ${stale === 1 ? "is" : "are"} valued at buy price. Prices are fetched from onvista when the app opens; try again in a moment.</p>` : ""}
    ${state.pricesAt ? `<p class="note ov-asof">Prices · ${stampOf(state.pricesAt)}</p>` : ""}`;
}

/* ======================================================================
   Portfolio
   ====================================================================== */
let openPos = null;          // key (ISIN) of the unfolded position, kept across re-renders
let closedOpen = false;      // the folded "Sold" group stays as you left it
document.addEventListener("toggle", (e) => { if (e.target.matches?.("details.closed")) closedOpen = e.target.open; }, true);
const fmtDate = (iso, lower) => {
  if (!iso) return "";
  const rel = relDay(`${iso}T12:00:00`);
  if (rel) return lower ? rel.toLowerCase() : rel;
  return `${lower ? "on " : ""}${new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
};

// All buys of one ISIN → one foldable position.
function lotGroups(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.key) || { key: r.key, isin: r.isin, tv: r.tv, label: r.label, realName: r.realName, nicknamed: r.nicknamed, sub: r.sub, type: r.type, live: r.live, price: r.price, lots: [], qty: 0, value: 0, cost: 0 };
    g.lots.push(r); g.qty += r.units; g.value += r.value; g.cost += r.cost; g.realized = (g.realized || 0) + r.realized; g.soldCost = (g.soldCost || 0) + r.soldCost;
    map.set(r.key, g);
  }
  return [...map.values()].map((g) => {
    g.lots.sort((a, b) => (b.buyDate || "").localeCompare(a.buyDate || ""));
    g.qty = Math.round(g.qty * 1e8) / 1e8;
    g.closed = g.qty <= 0;
    g.avgBuy = g.qty > 0 ? g.cost / g.qty : 0;
    g.realized ||= 0;
    g.gain = g.value - g.cost + g.realized;
    // % of everything put in (what you still hold plus the cost of what you sold), same as the Overview total
    const base = g.cost + (g.soldCost || 0);
    g.gainPct = base ? (g.gain / base) * 100 : 0;
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
  // fully sold positions fold away at the bottom
  const openGroups = groups.filter((g) => !g.closed);
  const closedGroups = groups.filter((g) => g.closed).sort((a, b) => b.gain - a.gain);
  const closedRealized = closedGroups.reduce((n, g) => n + g.realized, 0);
  const posItem = (g, i) => {
          const open = g.key === openPos;
          const buys = g.lots.filter((r) => !r.sell).length, sells = g.lots.length - buys;
          return `
        <li class="pos${open ? " is-open" : ""}">
          <div class="pos__swipe" data-pos-key="${esc(g.key)}"><div class="lot-bg lot-bg--del" aria-hidden="true">Delete position</div>
          <button class="holding pos__head" type="button" data-pos="${esc(g.key)}" aria-expanded="${open}" aria-controls="pos-${i}">
            <div class="row__id">
              <div class="row__title">${esc(g.label)}<span class="holding__tag holding__tag--${g.type}">${{ etf: "ETF", certificate: "Certificate", crypto: "Crypto" }[g.type] || "Stock"}</span></div>
              <div class="row__name">${g.closed ? "Sold" : fmtEur(g.value)}${g.live || g.closed ? "" : ` · <span class="stale">no live price</span>`}</div>
            </div>
            <div class="row__nums">
              ${g.live || g.closed ? `<div class="row__price ${dir(g.gain)}">${fmtEurSigned(g.gain)}</div>
              <span class="pill ${dir(g.gain)}">${fmtPct(g.gainPct)}</span>` : `<span class="holding__sub">—</span>`}
            </div>
          </button></div>
          <div class="pos__body" id="pos-${i}"${open ? "" : " hidden"}>
            <div class="pos__namebox">
              <div class="pos__realrow">
                <div class="pos__facts">
                  <p class="pos__real"><span>${esc(g.realName)}</span> · ${esc(g.sub)}</p>
                  <p class="pos__real">${g.closed ? "all sold" : `${fmtQty.format(g.qty)} × ${fmtEur(g.avgBuy)}${buys > 1 || sells ? " avg" : ""} → ${g.live ? fmtEur(g.price) : "no live price"}`}</p>
                  ${g.realized ? `<p class="pos__real">Realised: <span class="${dir(g.realized)}">${fmtEurSigned(g.realized)}</span> · open: <span class="${dir(g.value - g.cost)}">${fmtEurSigned(g.value - g.cost)}</span></p>` : ""}
                </div>
                <span class="pos__verdict-slot" data-pos-verdict-slot="${esc(g.key)}">${open ? posRatingHtml(g.key, "button") : ""}</span>
                <button type="button" class="pos__editbtn" data-pos-edit="${esc(g.key)}" aria-expanded="${editPos.has(g.key)}" aria-label="${editPos.has(g.key) ? "Done editing" : "Edit name and price source"}" title="${editPos.has(g.key) ? "Done" : "Edit"}">${editIcon(editPos.has(g.key))}</button>
              </div>
              <div data-pos-rating="${esc(g.key)}">${open ? posRatingHtml(g.key) : ""}</div>
              <div class="pos__edit" data-pos-editbox="${esc(g.key)}"${editPos.has(g.key) ? "" : " hidden"}>
                <label class="pos__name">
                  <span class="pos__name-label">Your name</span>
                  <input class="input" data-pos-name="${esc(g.key)}" value="${g.nicknamed ? esc(g.label) : ""}" placeholder="${esc(g.realName)}" maxlength="60" autocomplete="off" enterkeyhint="done" />
                </label>
                ${venueSelect(g)}
              </div>
            </div>
            <div class="pos__chart" data-pos-chart="${esc(g.key)}"></div>

            <ol class="lots" aria-label="Buys of ${esc(g.label)}">
              ${g.lots.map((r) => `
              <li class="lot-row" data-lot-id="${esc(r.id)}"><div class="lot-bg lot-bg--del" aria-hidden="true">Delete</div><div class="lot-bg lot-bg--edit" aria-hidden="true">Edit</div><a class="lot${r.sell ? " lot--sell" : ""}" href="#/edit/${encodeURIComponent(r.id)}" aria-label="Edit ${r.sell ? "sale" : "buy"} of ${esc(r.label)}${r.buyDate ? ` ${fmtDate(r.buyDate, true)}` : ""}">
                <span class="lot__date">${r.sell ? "Sold · " : ""}${r.buyDate ? fmtDate(r.buyDate) : "No date"}</span>
                <span class="lot__qty">${r.sell ? `${fmtQty.format(r.quantity)} × ${fmtEur(r.sellPrice)} (cost ${fmtEur(r.buyEur)})` : `${r.left < r.quantity ? `${fmtQty.format(r.left)} of ` : ""}${fmtQty.format(r.quantity)} × ${fmtEur(r.buyEur)}`}</span>
                <span class="lot__val">${r.sell
                  ? `<span class="${dir(r.realized)}">${fmtEurSigned(r.realized)}</span>`
                  : r.left <= 0 ? `<span class="stale">sold</span>`
                  : `${fmtEur(r.value)}${r.live ? ` <span class="${dir(r.gain)}">${fmtPct(r.gainPct)}</span>` : ""}`}</span>
              </a></li>`).join("")}
            </ol>
          </div>
        </li>`; };
  const t = totals(rows);
  if (openPos && !groups.some((g) => g.key === openPos)) openPos = null;
  $("pf-count").textContent = `${groups.length} ${groups.length === 1 ? "position" : "positions"}`;

  body.innerHTML = `
    <div class="card" style="padding:0">
      <ul class="holdings">
        ${openGroups.map(posItem).join("")}
      </ul>
      ${closedGroups.length ? `
      <details class="closed"${closedOpen ? " open" : ""}>
        <summary>
          <span>Sold · ${closedGroups.length} ${closedGroups.length === 1 ? "position" : "positions"}</span>
          <span class="closed__sum ${dir(closedRealized)}">${fmtEurSigned(closedRealized)} realised</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <ul class="holdings">${closedGroups.map((g, i) => posItem(g, openGroups.length + i)).join("")}</ul>
      </details>` : ""}
      <div class="pf-total"><span>Total</span><span>${fmtEur(t.value)}</span></div>
    </div>`;
  if (openPos) fillPosChart(openPos);
}

// pencil to edit, check mark when done
const editIcon = (open) => open
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
  : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;
// "Your name" and "Price from" sit behind an Edit button per position (kept open across re-renders)
const editPos = new Set();
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-pos-edit]");
  if (!b) return;
  const key = b.dataset.posEdit;
  const open = !editPos.has(key);
  if (open) editPos.add(key); else editPos.delete(key);
  const box = document.querySelector(`[data-pos-editbox="${CSS.escape(key)}"]`);
  if (box) box.hidden = !open;
  b.innerHTML = editIcon(open);
  b.setAttribute("aria-label", open ? "Done editing" : "Edit name and price source");
  b.title = open ? "Done" : "Edit";
  b.setAttribute("aria-expanded", String(open));
  if (open) box?.querySelector("input")?.focus();
});

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

// Analyst consensus for a position you hold (US-listed companies only), shown under its chart.
function ratingFor(key) {
  const a = getAnalysts();
  const pools = [state.analystsAll, a?.buys, a?.sells, a?.list].filter(Array.isArray);
  for (const list of pools) {
    const r = list.find((x) => x.isin === key || (!/^[A-Z]{2}\d/.test(key) && x.symbol === key));
    if (r && (r.total ?? r.strongBuy + r.buy + r.hold + r.sell + r.strongSell) > 0) return r;
  }
  return null;
}
// part "button": the small Buy / Hold / Sell button; otherwise the details it unfolds
function posRatingHtml(key, part) {
  const r = ratingFor(key);
  if (!r) return "";
  const buy = r.strongBuy + r.buy, hold = r.hold, sell = r.sell + r.strongSell, total = buy + hold + sell;
  const score = r.score ?? (2 * r.strongBuy + r.buy - r.sell - 2 * r.strongSell) / total;
  const seg = (n, cls) => (n ? `<span class="rating__seg ${cls}" style="flex:${n}"></span>` : "");
  const month = r.period ? new Date(`${r.period.slice(0, 7)}-15T12:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "";
  const verdict = score >= 0.5 ? "Buy" : score <= -0.5 ? "Sell" : "Hold";
  const open = ratingOpen.has(key);
  if (part === "button") return `<button class="pos__verdict pill ${verdict === "Buy" ? "up" : verdict === "Sell" ? "down" : ""}${open ? " is-open" : ""}" type="button" data-pos-verdict="${esc(key)}" aria-expanded="${open}" aria-label="Analysts say ${verdict}: ${open ? "hide" : "show"} details">${verdict}</button>`;
  return `
    <div class="pos__analysts"${open ? "" : " hidden"}>
      <div class="pos__analysts-detail">
        <div class="pos__analysts-head">Analysts · ${ratingLabel(score)} · ${total} ${total === 1 ? "rating" : "ratings"}${month ? ` · ${month}` : ""}</div>
        <div class="rating" role="img" aria-label="${buy} buy, ${hold} hold, ${sell} sell">${seg(buy, "is-buy")}${seg(hold, "is-hold")}${seg(sell, "is-sell")}</div>
        <div class="rating__counts">${buy} buy · ${hold} hold · ${sell} sell</div>
      </div>
    </div>`;
}
const ratingOpen = new Set(); // positions whose analyst details are unfolded
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pos-verdict]");
  if (!b) return;
  const key = b.dataset.posVerdict;
  if (ratingOpen.has(key)) ratingOpen.delete(key); else ratingOpen.add(key);
  fillPosRating(key);
});
function fillPosRating(key) {
  const host = document.querySelector(`[data-pos-rating="${CSS.escape(key)}"]`);
  if (host) host.innerHTML = posRatingHtml(key);
  const slot = document.querySelector(`[data-pos-verdict-slot="${CSS.escape(key)}"]`);
  if (slot) slot.innerHTML = posRatingHtml(key, "button");
}

function fillPosChart(key) {
  const host = document.querySelector(`[data-pos-chart="${CSS.escape(key)}"]`);
  if (!host) return;
  const g = lotGroups(state.holdings.map(valuate)).find((x) => x.key === key);
  if (!g) return;
  // no "Price data" line in the portfolio: the source is in the imprint and privacy page
  mountChart(host, g.isin || g.key, g.isin ? "EUR" : "USD", g.isin ? state.venues[g.isin] : undefined, undefined, false);
}

document.addEventListener("click", (e) => {
  const head = e.target.closest("[data-pos]");
  if (!head) return;
  if (Date.now() - Number(head.closest(".pos__swipe")?.dataset.swiped || 0) < 400) return; // that was a swipe
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
  fillPosRating(key);
  // the full list (all NYSE + Nasdaq) is loaded on demand
  if (!state.analystsAll) Promise.resolve(loadAllAnalysts()).then(() => { if (openPos === key) fillPosRating(key); });
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
    const { setVenue } = await loadStore();
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
    const { setName } = await loadStore();
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
    const rel = relDay(`${v}T12:00:00`);
    text = rel ? rel.toLowerCase()
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
// Enter in the date: take the date and stay in a field, so the phone keyboard stays up
f.datetext.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); (f.qty.value ? f.price.value ? f.qty : f.price : f.qty).focus({ preventScroll: true }); } });
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
  $("f-total").textContent = q > 0 && p > 0 ? `= ${fmtEur(q * p)} ${side === "sell" ? "received" : "invested"}` : "";
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
  const { CRYPTO } = await import("./crypto.js?v=109");
  const coins = Object.entries(CRYPTO)
    .filter(([, c]) => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase() === q)
    .map(([code, c]) => ({ isin: code, name: `${c.name} (${c.ticker})`, type: "crypto" }));
  let found = [];
  try {
    const { searchInstruments } = await import("./onvista.js?v=109");
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

// "Bought" / "Sold": the first word of the sentence is a toggle
let side = "buy";
function setSide(next) {
  side = next;
  const b = $("f-side");
  b.textContent = side === "sell" ? "Sold" : "Bought";
  b.setAttribute("aria-pressed", String(side === "sell"));
  b.classList.toggle("is-sell", side === "sell");
  if (!editingId) $("add-title").textContent = side === "sell" ? "Record a sale" : "Add holding";
  updateTotal();
}
$("f-side").addEventListener("click", () => setSide(side === "sell" ? "buy" : "sell"));

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
  endImport();
  editingId = null;
  pendingEditId = null;
  f.price.placeholder = "100.00";
  f.date.value = isoToday();
  setSide("buy");

  if (id) {
    if (state.holdings === null) { pendingEditId = id; return; }
    const h = state.holdings.find((x) => x.id === id);
    if (!h) { toast("That holding doesn't exist anymore"); return; }
    editingId = id;
    $("add-title").textContent = "Edit holding";
    $("f-submit").textContent = "Save";
    $("f-delete").hidden = false;
    $("f-import-btn").hidden = true;
    f.isin.value = h.isin || "";
    f.qty.value = String(h.quantity);
    f.price.value = h.isin ? String(h.buyPrice) : "";
    f.date.value = h.buyDate || isoToday();
    setSide(h.side === "sell" ? "sell" : "buy");
    $("add-title").textContent = h.side === "sell" ? "Edit sale" : "Edit holding";
    $("f-delete").textContent = h.side === "sell" ? "Delete sale" : "Delete holding";
    if (!h.isin) showError(`This holding was added by ticker (${h.symbol}, USD). Enter its ISIN and the buy price in EUR to switch it over.`);
  } else {
    $("add-title").textContent = "Add holding";
    $("f-submit").textContent = "Add";
    $("f-delete").hidden = true;
    $("f-import-btn").hidden = false;
  }
  updateIsinHint(); updateDateShow(); updateTotal();
  [f.qty, f.price].forEach(sizePill);

  addLastFocus = document.activeElement;
  addSheet.hidden = false;
  document.body.classList.add("sheet-open");
  document.querySelector('.tab[data-tab="add"]')?.setAttribute("aria-current", "page");
  requestAnimationFrame(() => {
    addSheet.classList.add("is-open");
    (id ? f.qty : f.isin).focus({ preventScroll: true }); // keyboard up right away, also when editing
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
swipeToClose($("add-form"), closeAdd);
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

// On phones keep the keyboard up while the dialog is open: tapping anything that isn't a
// text field (Bought/Sold, a search result, labels, empty space) must not take focus away.
// Preventing mousedown's default keeps the current field focused; the click still happens.
form.addEventListener("mousedown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (e.target.closest("[data-close-add], #f-submit")) return; // closing/saving may drop the keyboard
  const a = document.activeElement;
  if (a && form.contains(a) && a.matches("input")) e.preventDefault();
});
addSheet.querySelectorAll("[data-close-add]").forEach((el) => el.addEventListener("click", closeAdd));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAdd(); });

/* ---------- Import a CSV from flatex (Depotumsätze): read here, nothing is uploaded ---------- */
let importTrades = null;
function endImport() {
  importTrades = null;
  form.classList.remove("is-importing");
  $("f-import").hidden = true;
  $("f-import").innerHTML = "";
  $("f-file").value = "";
}
$("f-import-btn").addEventListener("click", () => $("f-file").click());
$("f-file").addEventListener("change", async () => {
  const file = $("f-file").files?.[0];
  if (!file) return;
  $("f-error").hidden = true;
  try {
    const { decode, parseTrades } = await import("./import-csv.js?v=109");
    const { trades, skipped } = parseTrades(decode(await file.arrayBuffer()));
    // already in stonks? same ISIN, side, date, units and price
    const same = (t) => (state.holdings || []).some((h) => h.isin === t.isin && (h.side === "sell") === (t.side === "sell")
      && (h.buyDate || "") === t.date && Math.abs(h.quantity - t.quantity) < 1e-6 && Math.abs(h.buyPrice - t.price) < 0.01);
    trades.forEach((t) => { t.dupe = same(t); });
    // a sale of more than you hold (counting earlier lines of the file) is flagged, not blocked
    const held = {};
    for (const t of trades) {
      held[t.isin] ??= heldUnits(t.isin);
      if (t.dupe) continue;
      if (t.side === "sell") { t.short = t.quantity > held[t.isin] + 1e-9; held[t.isin] -= t.quantity; }
      else held[t.isin] += t.quantity;
    }
    importTrades = trades;
    showImport(file.name, trades, skipped);
  } catch (e) {
    console.warn(e);
    showError(e.message || "Couldn't read this file.");
    $("f-file").value = "";
  }
});
function showImport(fileName, trades, skipped) {
  const fresh = trades.filter((t) => !t.dupe);
  const buys = fresh.filter((t) => t.side === "buy").length, sells = fresh.length - buys;
  form.classList.add("is-importing");
  const box = $("f-import");
  box.hidden = false;
  box.innerHTML = `
    <p class="import__sum"><b>${esc(fileName)}</b><br>${fresh.length ? `${buys} ${buys === 1 ? "buy" : "buys"}${sells ? ` · ${sells} ${sells === 1 ? "sale" : "sales"}` : ""} to import` : "Nothing new to import"}${trades.length - fresh.length ? ` · ${trades.length - fresh.length} already in stonks` : ""}${skipped.length ? ` · ${skipped.length} other ${skipped.length === 1 ? "line" : "lines"} skipped` : ""}</p>
    <ol class="lots import__list">${trades.map((t) => `
      <li><div class="lot${t.side === "sell" ? " lot--sell" : ""}${t.dupe ? " is-dupe" : ""}">
        <span class="lot__date">${t.side === "sell" ? "Sold · " : ""}${esc(state.names[t.isin] || state.isin[t.isin]?.name || t.name || t.isin)}</span>
        <span class="lot__qty">${t.date ? fmtDate(t.date) : "No date"} · ${fmtQty.format(t.quantity)} × ${fmtEur(t.price)}${t.short ? ` · <span class="import__warn">more than you hold in stonks</span>` : ""}</span>
        <span class="lot__val">${t.dupe ? `<span class="stale">already in</span>` : fmtEur(t.quantity * t.price)}</span>
      </div></li>`).join("")}
    </ol>
    <div class="import__actions">
      <button class="btn btn--ghost" type="button" data-import-cancel>Cancel</button>
      <button class="btn btn--primary" type="button" data-import-go${fresh.length ? "" : " disabled"}>Import ${fresh.length || ""}</button>
    </div>`;
  box.querySelector("[data-import-cancel]").addEventListener("click", endImport);
  box.querySelector("[data-import-go]").addEventListener("click", runImport);
}
async function runImport() {
  const todo = (importTrades || []).filter((t) => !t.dupe);
  if (!todo.length || !state.user) return;
  const go = $("f-import").querySelector("[data-import-go]");
  go.disabled = true;
  try {
    // names and types from onvista / CoinGecko, one lookup per security
    const isins = [...new Set(todo.map((t) => t.isin))];
    await Promise.all(isins.map((i) => lookupLive(i).catch(() => null)));
    const { saveHolding } = await loadStore();
    let n = 0;
    for (const t of todo) {
      const q = state.isin[t.isin];
      go.textContent = `Importing ${++n} of ${todo.length}…`;
      await saveHolding(state.user.uid, null, {
        isin: t.isin, quantity: t.quantity, buyPrice: t.price, buyDate: t.date, side: t.side,
        type: q?.type || guessType(t.isin), name: q?.name || t.name || "",
      });
    }
    toast(`Imported ${todo.length} ${todo.length === 1 ? "trade" : "trades"}`);
    endImport();
    closeAdd();
  } catch (e) {
    console.error(e);
    showError(firestoreMessage(e));
    go.disabled = false;
    go.textContent = `Import ${todo.length}`;
  }
}

/* ---------- Portfolio: swipe a buy or sale (like MoneTrip) ----------
   ← past the threshold deletes it right away (with Undo in the toast), → opens it for editing. */
let lotSwipe = null;
const lotThreshold = (li) => Math.min(110, li.offsetWidth * 0.33);
document.addEventListener("touchstart", (e) => {
  lotSwipe = null;
  const li = e.target.closest?.(".lot-row, .pos__swipe");
  if (!li || e.touches.length !== 1) return;
  const t = e.touches[0];
  const pos = li.classList.contains("pos__swipe"); // a whole position: ← delete only (→ still switches tabs)
  lotSwipe = { li, pos, a: li.querySelector(pos ? ".pos__head" : ".lot"), x: t.clientX, y: t.clientY, dx: 0, lock: null };
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!lotSwipe) return;
  const t = e.touches[0], mx = t.clientX - lotSwipe.x, my = t.clientY - lotSwipe.y;
  if (!lotSwipe.lock) {
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    lotSwipe.lock = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (lotSwipe.lock === "x") lotSwipe.a.classList.add("dragging");
  }
  if (lotSwipe.lock !== "x") return;
  const { li, a } = lotSwipe;
  if (lotSwipe.pos && mx > 0) { lotSwipe.dx = 0; a.style.transform = ""; li.dataset.dir = ""; return; }
  lotSwipe.dx = mx;
  li.dataset.dir = mx < 0 ? "left" : "right";
  li.classList.toggle("armed", Math.abs(mx) >= lotThreshold(li));
  a.style.transform = `translateX(${mx}px)`;
}, { passive: true });
function endLotSwipe() {
  if (!lotSwipe) return;
  const { li, a, dx, lock, pos } = lotSwipe;
  lotSwipe = null;
  a.classList.remove("dragging");
  if (lock !== "x") return;
  if (pos && dx === 0) return;
  li.dataset.swiped = String(Date.now()); // the click that ends a swipe doesn't open the edit sheet
  const th = lotThreshold(li);
  li.classList.remove("armed");
  const reset = () => { a.style.transform = ""; li.dataset.dir = ""; };
  if (dx <= -th) {
    a.style.transform = `translateX(${-li.offsetWidth}px)`;
    li.classList.add("leaving");
    setTimeout(() => (pos ? deletePosition(li.dataset.posKey, li) : deleteLot(li.dataset.lotId, li)), 160);
  } else if (dx >= th) {
    reset();
    location.hash = `#/edit/${encodeURIComponent(li.dataset.lotId)}`;
  } else reset();
}
document.addEventListener("touchend", endLotSwipe);
document.addEventListener("touchcancel", endLotSwipe);
document.addEventListener("click", (e) => {
  const li = e.target.closest?.(".lot-row");
  if (li && Date.now() - Number(li.dataset.swiped || 0) < 400) e.preventDefault();
});
// every buy and sale of a position; Undo puts them all back
async function deletePosition(key, li) {
  const list = (state.holdings || []).filter((h) => (h.isin || h.symbol) === key);
  if (!list.length || !state.user) return;
  const label = state.names[key] || state.isin[key]?.name || list[0].name || key;
  const copies = list.map(({ id, createdAt, updatedAt, ...data }) => data);
  try {
    const store = await loadStore();
    for (const h of list) await store.deleteHolding(state.user.uid, h.id);
    if (openPos === key) openPos = null;
    toast(`${label} deleted`, {
      label: "Undo",
      run: async () => {
        try { for (const d of copies) await store.saveHolding(state.user.uid, null, d); toast("Restored"); }
        catch { toast("Couldn't restore it."); }
      },
    });
  } catch (err) {
    console.error(err);
    toast(firestoreMessage(err));
    li?.classList.remove("leaving");
    if (li) li.querySelector(".pos__head").style.transform = "";
  }
}
async function deleteLot(id, li) {
  const h = state.holdings?.find((x) => x.id === id);
  if (!h || !state.user) return;
  const label = state.names[h.isin] || state.isin[h.isin]?.name || h.name || h.isin;
  const { id: _id, createdAt, updatedAt, ...data } = h;
  try {
    const store = await loadStore();
    await store.deleteHolding(state.user.uid, id);
    toast(`${h.side === "sell" ? "Sale" : "Buy"} of ${label} deleted`, {
      label: "Undo",
      run: () => store.saveHolding(state.user.uid, null, data).then(() => toast("Restored")).catch(() => toast("Couldn't restore it.")),
    });
  } catch (err) {
    console.error(err);
    toast(firestoreMessage(err));
    li?.classList.remove("leaving");
    if (li) li.querySelector(".lot").style.transform = "";
  }
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
  const isin = f.isin.value.trim().toUpperCase();
  const quantity = parseNum(f.qty.value);
  const buyPrice = parseNum(f.price.value);
  let bad = null;
  if (!isValidId(isin)) bad = [f.isin, f.isin, looksLikeId(isin) ? "That ISIN isn't valid. Check for typos." : "Pick one of the results, or enter an ISIN."];
  else if (!f.date.value) bad = [f.datetext, f.datetext.parentElement, "Enter the buy date as dd.mm.yyyy."];
  else if (!(quantity > 0)) bad = [f.qty, f.qty.parentElement, "How many did you buy?"];
  else if (!(buyPrice > 0)) bad = [f.price, f.price.parentElement, side === "sell" ? "What did you get per share (EUR)?" : "What did you pay per share (EUR)?"];
  else if (side === "sell") {
    const held = heldUnits(isin, editingId);
    if (quantity > held + 1e-9) bad = [f.qty, f.qty.parentElement, held > 0 ? `You only hold ${fmtQty.format(held)}.` : "You don't hold any of this."];
  }
  if (bad) { bad[1].setAttribute("aria-invalid", "true"); bad[0].focus(); showError(bad[2]); return; }

  const q = state.isin[isin];
  const btn = $("f-submit");
  btn.disabled = true;
  try {
    const { saveHolding } = await loadStore();
    await saveHolding(state.user.uid, editingId, {
      isin, quantity, buyPrice, buyDate: f.date.value, side,
      type: q?.type || guessType(isin), name: q?.name || "",
    });
    const label = q?.name || isin;
    toast(editingId ? `Saved ${label}` : side === "sell" ? `Recorded sale of ${label}` : `Added ${label}`);
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
    const { deleteHolding } = await loadStore();
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

// symbol: US ticker; isin: a position of yours; extra: { name, isin } for other companies (Buy/Sell lists)
function openChart(symbol, isin, extra = {}) {
  if (!isin && !state.prices.get(symbol) && (extra.name || extra.isin)) return openOtherChart(symbol, extra);
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

  mountChart($("sheet-chart"), isin || symbol, isin ? "EUR" : "USD", isin ? state.venues[isin] : undefined, isin ? undefined : { name: q?.name, price: q?.price });

  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}

// Tap the total value → your whole portfolio over time.
function portfolioChartPositions() {
  computeSells(state.holdings);
  const rows = state.holdings.map(valuate);
  const t = totals(rows);
  const usd = state.fx.USD || 1;
  const byKey = new Map();
  for (const r of rows) {
    const id = r.isin || r.symbol;
    if (!id) continue;
    const p = byKey.get(id) || { id, currency: r.isin ? "EUR" : "USD", venue: r.isin ? state.venues[r.isin] : undefined, toEur: r.isin ? 1 : 1 / usd, lots: [] };
    // sells: negative units at their FIFO cost; cash: money paid (+) or received (−)
    p.lots.push({ qty: r.histUnits, buyEur: r.buyEur, date: r.buyDate || "", cash: r.sell ? -r.quantity * r.sellPrice : r.quantity * r.buyEur });
    byKey.set(id, p);
  }
  return [...byKey.values()];
}
function togglePortfolioChart() {
  if (!state.holdings?.length) return;
  toggleExpand("total", () => $("hero-num"), () => {
    const node = document.createElement("div");
    node.className = "inline inline--total";
    node.innerHTML = `<div class="pos__chart"></div>`;
    const positions = portfolioChartPositions();
    import("./chart.js?v=109").then(({ mountPortfolioChart }) => mountPortfolioChart(node.querySelector(".pos__chart"), { positions }));
    return node;
  });
}
function openPortfolioChartSheetUnused() {
  const byKey = new Map(portfolioChartPositions().map((p) => [p.id, p]));
  const t = totals(state.holdings.map(valuate));
  $("sheet-sym").textContent = "Your portfolio";
  $("sheet-sym").classList.add("sheet__sym--name");
  $("sheet-name").textContent = `${byKey.size} ${byKey.size === 1 ? "position" : "positions"} · dashed line: invested`;
  $("sheet-price").textContent = fmtEur(t.value);
  const pill = $("sheet-pill");
  pill.hidden = false;
  pill.className = `pill ${dir(t.day)}`;
  pill.textContent = `${fmtEurSigned(t.day)} · ${fmtPct(t.dayPct)}`;
  import("./chart.js?v=109").then(({ mountPortfolioChart }) => mountPortfolioChart($("sheet-chart"), { positions: [...byKey.values()] }));
  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}
document.addEventListener("click", (e) => { if (e.target.closest?.("#hero-num")) togglePortfolioChart(); });
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("#hero-num")) { e.preventDefault(); togglePortfolioChart(); }
});

// Our own chart (js/chart.js): onvista history for securities, CoinGecko for crypto.
async function mountChart(host, id, currency, venue, hint, credit = true) {
  const { mountPriceChart } = await import("./chart.js?v=109");
  mountPriceChart(host, { id, currency, venue, hint, credit });
}

/* ======================================================================
   Biggest winner and loser of the day, in € (what moved your money most)
   ====================================================================== */
function winnersCard(rows) {
  const list = positions(rows).filter((p) => p.live && p.value > 0.005 && p.prevValue > 0);
  if (list.length < 2) return "";
  const sorted = [...list].sort((a, b) => b.dayChange - a.dayChange);
  const best = sorted[0], worst = sorted.at(-1);
  const bestLabel = best.dayChange >= 0 ? "Biggest winner" : "Smallest loss";
  const worstLabel = worst.dayChange < 0 ? "Biggest loser" : "Smallest gain";
  const row = (p, label) => `
    <li class="row row--link" data-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""} tabindex="0" role="button" aria-label="${label}: ${esc(p.label)}, ${fmtEurSigned(p.dayChange)} today, show chart">
      <div class="row__id">
        <div class="row__kicker ${dir(p.dayChange)}">${label}</div>
        <div class="row__title">${esc(p.label)}</div>
      </div>
      <div class="row__nums">
        <div class="row__price ${dir(p.dayChange)}">${fmtEurSigned(p.dayChange)}</div>
        <span class="pill ${dir(p.dayChange)}">${fmtPct((p.dayChange / p.prevValue) * 100)}</span>
      </div>
    </li>`;
  return `
      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Winner &amp; loser</h3><span class="card__hint">today · in €</span></div>
        <ol class="rows winners">
          ${row(best, bestLabel)}
          ${row(worst, worstLabel)}
        </ol>
      </article>`;
}

/* ======================================================================
   Year by year: money put in (buys − sales) and the gain made, per calendar year
   ====================================================================== */
const yearsState = { sig: null, data: null, loading: false };
function yearsCard(rows) {
  // money in, straight from your buys and sales (no prices needed)
  const flows = {};
  const years = rows.map((r) => r.buyDate?.slice(0, 4)).filter(Boolean);
  const first = years.length ? Math.min(...years.map(Number)) : new Date().getFullYear();
  for (const r of rows) {
    const y = Number(r.buyDate?.slice(0, 4)) || first; // undated buys count in your first year
    const f = (flows[y] ||= { buys: 0, sales: 0 });
    if (r.sell) f.sales += r.quantity * r.sellPrice; else f.buys += r.quantity * r.buyEur;
  }
  // gains need price history: computed once in the background, then the card fills in
  const sig = JSON.stringify([state.holdings.map((h) => [h.id, h.quantity, h.buyPrice, h.buyDate, h.side]), state.venues]);
  if (yearsState.sig !== sig && !yearsState.loading) {
    yearsState.loading = true;
    const positions = portfolioChartPositions();
    track(import("./chart.js?v=109").then(({ portfolioYears }) => portfolioYears(positions))
      .then((d) => { yearsState.data = d; yearsState.sig = sig; })
      .catch((e) => { console.warn("Year by year failed", e); yearsState.sig = sig; yearsState.data = null; })
      .finally(() => { yearsState.loading = false; renderCurrent(); }));
  }
  const gains = yearsState.sig === sig && yearsState.data ? Object.fromEntries(yearsState.data.years.map((y) => [y.year, y.gain])) : null;
  const list = Object.keys(flows).map(Number);
  const nowY = new Date().getFullYear();
  for (let y = Math.min(...list); y <= nowY; y++) flows[y] ||= { buys: 0, sales: 0 };
  // years where nothing happened (no money in or out, no gain) are left out
  const ys = Object.keys(flows).map(Number).sort((a, b) => b - a)
    .filter((y) => Math.abs(flows[y].buys - flows[y].sales) >= 0.5 || Math.abs(gains?.[y] || 0) >= 0.5);
  const max = Math.max(1, ...ys.map((y) => Math.abs(flows[y].buys - flows[y].sales)), ...(gains ? ys.map((y) => Math.abs(gains[y] || 0)) : []));
  const whole = (v) => `${v < 0 ? "−" : ""}€${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
  const bar = (v, cls) => `<span class="yr__bar ${cls}" style="width:${Math.max(0.5, (Math.abs(v) / max) * 100)}%"></span>`;
  const missing = yearsState.data?.missing || 0;
  return `
      <article class="card panel">
        <div class="card__head"><h3 class="card__title">Year by year</h3><span class="card__hint">invested · gain</span></div>
        <ol class="years">${ys.map((y) => {
          const net = flows[y].buys - flows[y].sales, g = gains?.[y];
          return `
          <li class="yr" data-year="${y}" tabindex="0" role="button" aria-expanded="false" aria-label="${y}: show buys and sales">
            <span class="yr__year">${y === nowY ? `${y}<small> so far</small>` : y}</span>
            <div class="yr__bars">
              <div class="yr__line"><span class="yr__lbl">Invested</span>${bar(net, net >= 0 ? "is-in" : "is-out")}<span class="yr__val">${whole(net)}</span></div>
              <div class="yr__line"><span class="yr__lbl">Gain</span>${g == null ? (gains || yearsState.data ? `<span></span><span class="yr__val stale">—</span>` : `<span class="yr__bar is-wait"></span><span class="yr__val stale">…</span>`) : `${bar(g, g >= 0 ? "up" : "down")}<span class="yr__val ${dir(g)}">${g > 0 ? "+" : ""}${whole(g)}</span>`}</div>
            </div>
          </li>`; }).join("")}
        </ol>
        <p class="years__note">Invested: buys minus sales. Gain: how much your holdings grew or shrank that year, sales included.${missing ? ` ${missing} position${missing === 1 ? "" : "s"} without price history left out of the gain.` : ""}</p>
      </article>`;
}

// Tap a year: its buys and sales unfold below, like the lots in the Portfolio.
function toggleYear(y) {
  toggleExpand(`year|${y}`, () => document.querySelector(`#view-overview .yr[data-year="${y}"]`), () => {
    computeSells(state.holdings);
    const rows = state.holdings.map(valuate);
    const dated = rows.map((r) => Number(r.buyDate?.slice(0, 4))).filter(Boolean);
    const first = dated.length ? Math.min(...dated) : new Date().getFullYear();
    const list = rows.filter((r) => (Number(r.buyDate?.slice(0, 4)) || first) === Number(y))
      .sort((a, b) => (b.buyDate || "").localeCompare(a.buyDate || ""));
    const node = document.createElement("li");
    node.className = "inline inline--row inline--year";
    node.innerHTML = list.length ? `<ol class="lots">${list.map((r) => `
      <li><a class="lot${r.sell ? " lot--sell" : ""}" href="#/edit/${encodeURIComponent(r.id)}" aria-label="Edit ${r.sell ? "sale" : "buy"} of ${esc(r.label)}${r.buyDate ? ` ${fmtDate(r.buyDate, true)}` : ""}">
        <span class="lot__date">${r.sell ? "Sold · " : ""}${esc(r.label)}</span>
        <span class="lot__qty">${r.buyDate ? (relDay(`${r.buyDate}T12:00:00`) || new Date(`${r.buyDate}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })) : "No date"} · ${r.sell ? `${fmtQty.format(r.quantity)} × ${fmtEur(r.sellPrice)}` : `${fmtQty.format(r.quantity)} × ${fmtEur(r.buyEur)}`}</span>
        <span class="lot__val">${r.sell
          ? `<span>${fmtEur(r.quantity * r.sellPrice)}</span><span class="${dir(r.realized)}">${fmtEurSigned(r.realized)}</span>`
          : `<span>${fmtEur(r.quantity * r.buyEur)}</span>${r.live && r.left > 0 ? `<span class="${dir(r.gain)}">${fmtPct(r.gainPct)}</span>` : r.left <= 0 ? `<span class="stale">sold</span>` : ""}`}</span>
      </a></li>`).join("")}</ol>` : `<p class="inline__caption">No buys or sales this year.</p>`;
    return node;
  });
}
document.addEventListener("click", (e) => {
  const y = e.target.closest(".yr[data-year]");
  if (y) toggleYear(y.dataset.year);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".yr[data-year]")) { e.preventDefault(); toggleYear(e.target.dataset.year); }
});

/* ======================================================================
   Allocation → tap a class (Stocks, ETFs, …) for a donut of the positions in it
   ====================================================================== */
// Slices in the stonks palette (brand.md): pink, cyan, violet, gold, blush, deep blue.
// Gain mint and loss rose are left out on purpose, so a slice never reads as up or down.
const SLICE_COLORS = ["#FF2E88", "#3CCBF4", "#9B7BFF", "#F5B700", "#FFA3CF", "#2F6FE0"];
const CLASS_NAMES = { stock: "stocks", etf: "ETFs", certificate: "certificates", crypto: "crypto" };
function fillAllocation(host, type) {
  if (!state.holdings?.length) return;
  computeSells(state.holdings);
  const rows = state.holdings.map(valuate);
  const all = totals(rows);
  const items = positions(rows).filter((p) => p.type === type && p.value > 0.005).sort((a, b) => b.value - a.value);
  if (!items.length) { host.innerHTML = ""; return; }
  const sum = items.reduce((n, p) => n + p.value, 0);
  const day = items.reduce((n, p) => n + p.dayChange, 0), prev = items.reduce((n, p) => n + p.prevValue, 0);
  // at most 6 slices; the rest folds into "Other"
  const slices = items.length > 6
    ? [...items.slice(0, 5), { label: `Other (${items.length - 5})`, value: items.slice(5).reduce((n, p) => n + p.value, 0), other: true }]
    : items;
  // the biggest position wears the class colour (as in the allocation bar); the rest take the
  // other slots in order, skipping the class colour and its near twin
  const CLASS_COLOR = { stock: "#3CCBF4", etf: "#FF2E88", certificate: "#8F72F0", crypto: "#BA8400" }[type];
  const TWIN = { stock: "#3CCBF4", etf: "#FF2E88", certificate: "#9B7BFF", crypto: "#F5B700" }[type];
  const colors = CLASS_COLOR ? [CLASS_COLOR, ...SLICE_COLORS.filter((c) => c !== TWIN && c !== CLASS_COLOR)] : SLICE_COLORS;
  slices.forEach((s, i) => { s.color = s.other ? "var(--ink-3)" : colors[i]; s.pct = (s.value / sum) * 100; });

  // donut: one arc per slice, a 2px gap of surface between them
  const R = 80, W = 26, C = 2 * Math.PI * R, gap = slices.length > 1 ? 2 : 0;
  let off = 0;
  const arcs = slices.map((s, i) => {
    const len = Math.max((s.value / sum) * C - gap, 0.5);
    const a = `<circle class="donut__arc" data-slice="${i}" r="${R}" cx="100" cy="100" fill="none" stroke="${s.color}" stroke-width="${W}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(s.label)}: ${fmtEur(s.value)} (${s.pct.toFixed(1)}%)</title></circle>`;
    off += (s.value / sum) * C;
    return a;
  }).join("");
  const name = CLASS_NAMES[type] || type;
  host.innerHTML = `
    <p class="inline__caption">Your ${name} · ${all.value ? ((sum / all.value) * 100).toFixed(1) : 0}% of your portfolio · today <span class="${dir(day)}">${fmtEurSigned(day)} · ${fmtPct(prev ? (day / prev) * 100 : 0)}</span></p>
    <div class="donut">
      <div class="donut__plot">
        <svg viewBox="0 0 200 200" role="img" aria-label="Your ${name}: ${slices.map((s) => `${s.label} ${s.pct.toFixed(0)}%`).join(", ")}">
          <circle r="${R}" cx="100" cy="100" fill="none" stroke="var(--line)" stroke-width="${W}" opacity=".35"/>${arcs}
        </svg>
        <div class="donut__center" aria-hidden="true"><b data-donut-val>${fmtEur(sum)}</b><span data-donut-lbl>${items.length} ${items.length === 1 ? "position" : "positions"}</span></div>
      </div>
      <ul class="legend donut__legend">${slices.map((s, i) => `
        <li data-slice="${i}">
          <span class="legend__sw" style="background:${s.color}"></span><span>${esc(s.label)}</span><span class="legend__val">${fmtEur(s.value)}</span><span class="legend__pct">${s.pct.toFixed(1)}%</span></li>`).join("")}
      </ul>
    </div>`;
  // point at a slice or its legend row: the centre shows that slice
  const show = (i) => {
    const s = slices[i];
    host.querySelectorAll("[data-slice]").forEach((el) => el.classList.toggle("is-dim", i != null && el.dataset.slice !== String(i)));
    host.querySelector("[data-donut-val]").textContent = s ? fmtEur(s.value) : fmtEur(sum);
    host.querySelector("[data-donut-lbl]").textContent = s ? `${s.label} · ${s.pct.toFixed(1)}%` : `${items.length} ${items.length === 1 ? "position" : "positions"}`;
  };
  // tap a slice or its row to keep it selected (tap again to let go); a mouse hover previews
  let pinned = null;
  host.querySelectorAll("[data-slice]").forEach((el) => {
    const i = Number(el.dataset.slice);
    el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") show(i); });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") show(pinned); });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = pinned === i ? null : i;
      show(pinned);
    });
  });
}
function toggleAllocation(type) {
  toggleExpand(`alloc|${type}`, () => document.querySelector(`#view-overview li[data-alloc="${type}"]`), () => {
    const node = document.createElement("li");
    node.className = "inline inline--alloc";
    fillAllocation(node, type);
    return node;
  });
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-alloc]");
  if (el) toggleAllocation(el.dataset.alloc);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-alloc]")) { e.preventDefault(); toggleAllocation(e.target.dataset.alloc); }
});

// A company you don't hold (from the analyst lists): its name as the title, EUR price from onvista.
function openOtherChart(symbol, { name, isin }) {
  $("sheet-sym").textContent = name || symbol;
  $("sheet-sym").classList.add("sheet__sym--name");
  $("sheet-name").textContent = [symbol, isin].filter(Boolean).join(" · ");
  $("sheet-price").textContent = "";
  $("sheet-pill").hidden = true;
  const id = isin || symbol;
  sheet.dataset.for = id;
  if (isin) {
    lookupLive(isin).then((q) => {
      if (!q || sheet.hidden || sheet.dataset.for !== id) return;
      $("sheet-price").textContent = fmtEur(q.price);
      const pill = $("sheet-pill");
      pill.hidden = false;
      pill.className = `pill ${dir(q.changePct)}`;
      pill.textContent = `${fmtEurSigned(q.change)} · ${fmtPct(q.changePct)}`;
    });
    mountChart($("sheet-chart"), isin, "EUR");
  } else {
    mountChart($("sheet-chart"), symbol, "USD", undefined, { name });
  }
  lastFocus = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("sheet-close").focus();
}

/* ======================================================================
   Unfold in place (like the Portfolio): a row, the total or an allocation class
   opens its chart right below it. One at a time; it survives re-renders.
   ====================================================================== */
let expand = null; // { key, node, anchor: () => Element | null }
function markAnchor(a, on) { if (!a) return; a.classList.toggle("is-expanded", on); a.setAttribute("aria-expanded", String(on)); }
function closeExpand() {
  if (!expand) return;
  markAnchor(expand.anchor(), false);
  expand.node.remove();
  expand = null;
}
function toggleExpand(key, anchor, build) {
  const same = expand?.key === key;
  closeExpand();
  if (same) return;
  const a = anchor();
  if (!a) return;
  const node = build();
  a.after(node);
  markAnchor(a, true);
  expand = { key, node, anchor };
}
// re-render without losing the open chart: lift it out, render, put it back under its anchor
function keepExpand(render) {
  const e = expand;
  e?.node.remove();
  render();
  if (!e) return;
  const a = e.anchor();
  if (a) { a.after(e.node); markAnchor(a, true); } else expand = null;
}
window.addEventListener("hashchange", closeExpand);

function toggleRowChart(row) {
  const view = row.closest(".view")?.id || "";
  const sym = row.dataset.chart;
  const same = [...document.querySelectorAll(`#${view} [data-chart="${CSS.escape(sym)}"]`)];
  const nth = same.indexOf(row);
  const box = row.closest("[data-kind], .card")?.querySelector(".card__title")?.textContent || "";
  toggleExpand(`row|${view}|${box}|${sym}|${nth}`, () => document.querySelectorAll(`#${view} [data-chart="${CSS.escape(sym)}"]`)[nth] || null, () => {
    const node = document.createElement(row.tagName === "LI" ? "li" : "div");
    node.className = "inline inline--row";
    node.innerHTML = `<div class="pos__chart"></div>`;
    const host = node.querySelector(".pos__chart");
    const isin = row.dataset.isin, other = row.dataset.otherIsin, q = state.prices.get(sym);
    if (isin) mountChart(host, isin, "EUR", state.venues[isin]);
    else if (q) mountChart(host, sym, "USD", undefined, { name: q.name, price: q.price });
    else if (other) mountChart(host, other, "EUR");
    else mountChart(host, sym, "USD", undefined, { name: row.dataset.name || sym });
    return node;
  });
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
  if (row && !e.target.closest(".inline")) toggleRowChart(row);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeChart();
  const row = e.target.closest?.("[data-chart]");
  if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleRowChart(row); }
});
// Swipe a sheet (chart pop-up, add/edit) down to close it. The price chart keeps its own drag
// (reading prices), fields and buttons keep theirs, and a scrolled sheet scrolls back up first.
function swipeToClose(panel, close) {
  let drag = null;
  panel.addEventListener("touchstart", (e) => {
    drag = null;
    if (e.touches.length !== 1 || e.target.closest(".pchart svg, button, select, input, textarea, [role=listbox]")) return;
    const scroller = e.target.closest(".donut");
    if ((scroller && scroller.scrollTop > 0) || panel.scrollTop > 0) return;
    drag = { y: e.touches[0].clientY, t: Date.now(), dy: 0 };
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (!drag) return;
    drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
    panel.style.transition = "none";
    panel.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  const end = () => {
    if (!drag) return;
    const { dy, t } = drag;
    drag = null;
    panel.style.transition = "";
    panel.style.transform = "";
    if (dy > 110 || (dy > 40 && dy / Math.max(1, Date.now() - t) > 0.5)) close();
  };
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}
swipeToClose(sheet.querySelector(".sheet__panel"), closeChart);
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
  keepExpand(renderCurrentNow);
}
function renderCurrentNow() {
  if (state.holdings) computeSells(state.holdings);
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
  if (e.target.closest?.(".pchart, input, textarea, select, .tabbar, .lot-row")) return;
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
  if (state.demo) { exitDemo(); return; }
  try {
    await signOutUser();
    clearDeviceCache();
    await clearLocalData();
    location.hash = "#/";
  } catch (e) { console.error(e); }
});

async function startHoldings(uid) {
  // already showing this account's portfolio from the device cache? keep it until fresh data arrives
  if (state.cachedUid !== uid) {
    state.holdings = null;
    state.names = {};
    state.venues = {};
  }
  state.cachedUid = null;
  let gotHoldings;
  track(new Promise((r) => { gotHoldings = r; }));
  let store;
  try {
    store = await loadStore();
  } catch (e) {
    console.error("Couldn't load store.js", e);
    if (!state.holdings) state.holdings = [];
    gotHoldings();
    renderCurrent();
    return;
  }
  // holdings first and on their own: a problem with names must never hide your holdings
  try {
    state.unsubHoldings = await store.watchHoldings(uid, (list) => {
      state.holdings = list;
      gotHoldings();
      saveSession();
      priceMissingHoldings();
      if (pendingEditId) openAdd(pendingEditId);
      renderCurrent();
    }, (e) => {
      console.error("Holdings listener failed", e);
      state.holdings = [];
      gotHoldings();
      renderCurrent();
      toast(firestoreMessage(e));
    });
  } catch (e) {
    console.error(e);
    state.holdings = [];
    gotHoldings();
    renderCurrent();
  }
  try {
    state.unsubNames = await store.watchNames?.(uid, (names, venues) => {
      state.names = names;
      state.venues = venues || {};
      saveSession();
      // don't re-render under the user's fingers while they're typing a name
      if (!document.activeElement?.matches?.("[data-pos-name]")) renderCurrent();
    });
  } catch (e) {
    console.warn("Custom names unavailable", e);
  }
}

function applyUser(user) {
  const signedIn = Boolean(user);
  state.user = user;
  state.authReady = true;
  $("signin").hidden = signedIn;
  $("user").hidden = !signedIn;
  $("cta-signin").hidden = signedIn;
  $("cta-demo").hidden = signedIn;
  $("cta-portfolio").hidden = !signedIn;
  $("tabbar").hidden = !signedIn;
  $("demo-badge").hidden = !state.demo;
  $("you-demo").hidden = state.demo || !signedIn;
  $("you-signout").textContent = state.demo ? (state.realUser ? "Back to my portfolio" : "Close demo") : "Sign out";
  $("signout").textContent = state.demo ? "Close demo" : "Sign out";
  document.body.classList.toggle("has-tabbar", signedIn);
  document.body.classList.toggle("is-demo", Boolean(state.demo));

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
}

function showCachedUser(user) {
  state.user = user;
  state.authReady = true;
  $("signin").hidden = true;
  $("user").hidden = false;
  $("cta-signin").hidden = true;
  $("cta-demo").hidden = true;
  $("cta-portfolio").hidden = false;
  $("tabbar").hidden = false;
  document.body.classList.add("has-tabbar");
  $("user-name").textContent = user.displayName || user.email || "";
  if (user.photoURL) $("user-avatar").src = user.photoURL;
}

/* Demo portfolio: a sample portfolio in memory, to show the app without your own holdings. */
async function enterDemo() {
  const { resetDemo } = await import("./demo-store.js?v=109");
  resetDemo();
  state.demo = true;
  state.names = {};
  state.venues = {};
  applyUser(DEMO_USER);
  location.hash = "#/overview";
  toast("Demo portfolio · sample data, nothing is saved");
}
function exitDemo() {
  state.demo = false;
  state.names = {};
  state.venues = {};
  applyUser(state.realUser || null);
  location.hash = state.realUser ? "#/overview" : "#/";
}
$("cta-demo").addEventListener("click", enterDemo);
$("you-demo").addEventListener("click", enterDemo);

let authSettled;
track(new Promise((r) => { authSettled = r; }));
onUser((user) => {
  authSettled();
  state.realUser = user;
  if (!user || (state.cachedUid && state.cachedUid !== user.uid)) { clearDeviceCache(); state.cachedUid = null; }
  if (state.demo) return; // the demo stays on until it's closed
  applyUser(user);
}).catch((e) => {
  console.error("Auth init failed", e);
  authSettled();
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

// open with what this device remembers: last prices and, if you were signed in, your portfolio
restorePrices();
const session = isConfigured ? readJson(SESSION_CACHE) : null;
if (session?.uid && Array.isArray(session.holdings)) {
  state.cachedUid = session.uid;
  state.holdings = session.holdings;
  state.names = session.names || {};
  state.venues = session.venues || {};
  showCachedUser(session.user);
}
renderHome();
route();
track(loadMarket());
track(loadAnalysts());
track(loadPrices());
