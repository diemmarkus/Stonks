// Overview 2 (#/overview2): a visual overview of the portfolio's setup, today's changes and
// recent events. Pure rendering: app.js hands in the valued rows and helpers.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// "N more in between" unfolded per list (movers, returns); kept across re-renders
const open = { movers: false, returns: false };
let mapZoom = false; // map shows only the "Others" (kept across re-renders)
// the map's two filters, kept across re-renders (not stored: a fresh visit starts at 1D · All)
let mapRange = "1D", mapType = "all";
let filtersOpen = false; // the filter panel under the map's head
const MAP_RANGES = ["1D", "1W", "1M", "6M", "1Y", "5Y", "All"];
// colour saturates at this move (%), wider for longer ranges
const MAP_SAT = { "1D": 3, "1W": 6, "1M": 10, "6M": 20, "1Y": 30, "5Y": 60, "All": 100 };
const SHORT_TYPE = { etf: "ETFs", certificate: "Certs", stock: "Stocks", crypto: "Crypto" };
const monthCache = new Map(); // range + positions → Promise<{ periods, byKey }>
// month by month: range → periods (5Y in quarters so cells stay tappable on a phone). The shorter
// ranges of the rest of the app (1D … 1M) have no months to show. All starts at your first buy:
// months up to 2 years, quarters up to ~6 years, years beyond.
const HM_RANGES = {
  "6M": { count: 6, step: 1, sat: 10 }, "1Y": { count: 12, step: 1, sat: 10 },
  "5Y": { count: 20, step: 3, sat: 20 }, "All": null,
};
function hmAll(first) {
  const now = new Date(), cm = now.getFullYear() * 12 + now.getMonth();
  const f = first ? Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7)) - 1 : cm - 11;
  const span = Math.max(6, cm - f + 1);
  if (span <= 24) return { count: span, step: 1, sat: 10 };
  if (span <= 76) return { count: Math.floor(cm / 3) - Math.floor(f / 3) + 1, step: 3, sat: 20 };
  return { count: Math.floor(cm / 12) - Math.floor(f / 12) + 1, step: 12, sat: 40 };
}
let hmRange = "1Y", hmFiltersOpen = false;
let monthsOpen = false; // month-by-month: all rows shown (kept across re-renders)
const MONTH_ROWS = 8;
const changeCache = new Map(); // range + positions → Promise<Map key → %>
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-ov2-more]");
  if (!b) return;
  const k = b.dataset.ov2More;
  open[k] = !open[k];
  const list = b.closest(".ov2-bars");
  list.querySelectorAll(".ov2-bar--mid").forEach((li) => { li.hidden = !open[k]; });
  b.setAttribute("aria-expanded", String(open[k]));
  b.textContent = open[k] ? "Show less" : `${list.querySelectorAll(".ov2-bar--mid").length} more in between`;
});
// top 3 and bottom 3, the rest folded behind a button in between
function foldable(list, key, rowHtml) {
  const extra = list.length - 6, hidden = extra >= 2 ? extra : 0; // folding a single row is not worth a button
  return list.map((p, i) => {
    const mid = hidden && i >= 3 && i < list.length - 3;
    const gap = hidden && i === 3 ? `<li class="ov2-gap"><button type="button" data-ov2-more="${key}" aria-expanded="${open[key]}">${open[key] ? "Show less" : `${hidden} more in between`}</button></li>` : "";
    return gap + rowHtml(p, mid ? `class="ov2-bar ov2-bar--mid"${open[key] ? "" : " hidden"}` : `class="ov2-bar"`);
  }).join("");
}

/* ---------- squarified treemap (Bruls et al.) ---------- */
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((n, it) => n + it.size, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map((it) => ({ ...it, area: it.size * scale }));
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [], worstPrev = Infinity;
    for (const it of rest) {
      const test = [...row, it];
      const s = test.reduce((n, r) => n + r.area, 0);
      const worst = Math.max(...test.map((r) => Math.max((side * side * r.area) / (s * s), (s * s) / (side * side * r.area))));
      if (row.length && worst > worstPrev) break;
      row = test; worstPrev = worst;
    }
    const s = row.reduce((n, r) => n + r.area, 0);
    const thick = s / side;
    let off = 0;
    for (const r of row) {
      const len = r.area / thick;
      if (w >= h) out.push({ ...r, x, y: y + off, w: thick, h: len });
      else out.push({ ...r, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    rest = rest.slice(row.length);
  }
  return out;
}

// the range's % → tile colour: rose ← surface → mint, saturating at ±3 % for a day (MAP_SAT)
function moveColor(pct, live, sat = 3) {
  if (!live) return "var(--bg)";
  const k = clamp(Math.abs(pct) / sat, 0, 1);
  const mix = Math.round(14 + k * 62);
  return `color-mix(in srgb, var(--${pct >= 0 ? "up" : "down"}) ${mix}%, var(--bg-2))`;
}

// Two-column grid: cards side by side share a height only when they're within ~15 % of each
// other; very different cards keep their own height (no big empty gaps).
function alignRows(grid) {
  const cards = [...grid.children].filter((c) => c.classList.contains("card"));
  cards.forEach((c) => { c.style.minHeight = ""; });
  if (getComputedStyle(grid).gridTemplateColumns.split(" ").length < 2) return;
  const rows = new Map();
  for (const c of cards) {
    const top = Math.round(c.offsetTop);
    if (!rows.has(top)) rows.set(top, []);
    rows.get(top).push(c);
  }
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const hs = row.map((c) => c.offsetHeight), max = Math.max(...hs), min = Math.min(...hs);
    if (min / max >= 0.85) row.forEach((c) => { c.style.minHeight = `${max}px`; });
  }
}
const watched = new WeakSet();
function watchRows(grid) {
  let queued = false;
  const run = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; alignRows(grid); }); };
  run();
  if (watched.has(grid) || typeof ResizeObserver === "undefined") return;
  watched.add(grid);
  // re-check when a card's content changes height (folding, unfolding, charts loading)
  const ro = new ResizeObserver(run);
  const observe = () => [...grid.children].forEach((c) => ro.observe(c));
  observe();
  new MutationObserver(() => { observe(); run(); }).observe(grid, { childList: true, subtree: true });
}

export function renderOverview2(body, ctx) {
  const { rows, t, pos, returns, alloc, esc, fmtEur, fmtEurSigned, fmtPct, dir, stamp, events, typeLabel, mapChanges, monthChanges, heldIn, firstBuy } = ctx;
  const live = pos.filter((p) => p.live);
  const share = (v) => (t.value ? (v / t.value) * 100 : 0);
  const [whole, cents] = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(t.value).split(".");

  /* 1 · today's map (or over 1W … All), all positions or one class */
  const mapAll = pos.filter((p) => p.value > 0.005).sort((a, b) => b.value - a.value);
  const mapTypes = alloc.byType.map((x) => x.key).filter((k) => mapAll.some((p) => p.type === k));
  if (mapType !== "all" && !mapTypes.includes(mapType)) mapType = "all";

  /* 2 · what moved your money today (€) */
  const contrib = [...live].filter((p) => Math.abs(p.dayChange) >= 0.005).sort((a, b) => b.dayChange - a.dayChange);
  // top 3 and bottom 3; the net line below still counts every position
  const maxAbs = Math.max(1e-9, ...contrib.map((p) => Math.abs(p.dayChange)));
  const contribRows = foldable(contrib, "movers", (p, attrs) => {
    const w = (Math.abs(p.dayChange) / maxAbs) * 50;
    const up = p.dayChange >= 0;
    return `
      <li ${attrs} data-ov2-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""} tabindex="0" role="button" aria-label="${esc(p.label)} ${fmtEurSigned(p.dayChange)} today">
        <span class="ov2-bar__name">${esc(p.label)}</span>
        <span class="ov2-bar__track"><span class="ov2-bar__fill ${up ? "up" : "down"}" style="${up ? "left:50%" : `left:${(50 - w).toFixed(2)}%`};width:${w.toFixed(2)}%"></span></span>
        <span class="ov2-bar__val ${dir(p.dayChange)}">${fmtEurSigned(p.dayChange)}</span>
      </li>`;
  });

  /* 3 · setup: classes + concentration */
  const top3 = mapAll.slice(0, 3).reduce((n, p) => n + p.value, 0);
  const conc = mapAll.map((p, i) => `<span class="ov2-conc__seg${i < 3 ? ` is-top is-top${i}` : ""}" style="flex:${p.value}" title="${esc(p.label)} · ${share(p.value).toFixed(1)}%"></span>`).join("");
  const topList = mapAll.slice(0, 3).map((p, i) => `<li><span class="ov2-sw is-top${i}"></span><span>${esc(p.label)}</span><b>${share(p.value).toFixed(1)}%</b></li>`).join("");

  /* 4 · since you bought: total return per position = open gain + realised, against all money put in */
  const ret = [...returns].sort((a, b) => b.gp - a.gp);
  const maxRet = Math.max(1e-9, ...ret.map((p) => Math.abs(p.gp)));
  const retRows = foldable(ret, "returns", (p, attrs) => {
    const w = (Math.abs(p.gp) / maxRet) * 50, up = p.gp >= 0;
    return `
      <li ${attrs} data-ov2-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""} tabindex="0" role="button" aria-label="${esc(p.label)} ${fmtPct(p.gp)} since bought, including realised gains">
        <span class="ov2-bar__name">${esc(p.label)}${p.closed ? ` <em class="ov2-sold">sold</em>` : ""}</span>
        <span class="ov2-bar__track"><span class="ov2-bar__fill ${up ? "up" : "down"}" style="${up ? "left:50%" : `left:${(50 - w).toFixed(2)}%`};width:${w.toFixed(2)}%"></span></span>
        <span class="ov2-bar__val ${dir(p.gp)}">${fmtPct(p.gp)}<small>${fmtEurSigned(p.g)}</small></span>
      </li>`;
  });

  /* 5 · latest: events */
  const evRows = events.slice(0, 8).map((e) => `
      <li class="ov2-ev">
        <span class="ov2-ev__icon ov2-ev__icon--${e.kind}" aria-hidden="true">${e.icon}</span>
        <span class="ov2-ev__text">${e.html}</span>
        <span class="ov2-ev__when">${esc(e.when)}</span>
      </li>`).join("");

  body.innerHTML = `

    <article class="card panel ov2-card">
      <div class="card__head"><h3 class="card__title" id="ov2-map-title">Today's map</h3><span class="card__side"><button type="button" class="ov2-back" data-ov2-map-back hidden>← All positions</button>
        <span class="ov2-filter-sum" data-ov2-filter-sum></span>
        <button type="button" class="ov2-filter" data-ov2-filter aria-expanded="${filtersOpen}" aria-controls="ov2-map-filters" aria-label="Filter the map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button></span></div>
      <div class="ov2-filters" id="ov2-map-filters"${filtersOpen ? "" : " hidden"}>
        <div class="seg ov2-seg" role="radiogroup" aria-label="Time range">${MAP_RANGES.map((r) => `<button type="button" role="radio" data-ov2-map-range="${r}" aria-checked="${r === mapRange}">${r}</button>`).join("")}</div>
        ${mapTypes.length > 1 ? `<div class="seg ov2-seg" role="radiogroup" aria-label="Asset class">${["all", ...mapTypes].map((k) => `<button type="button" role="radio" data-ov2-map-type="${k}" aria-checked="${k === mapType}">${k === "all" ? "All" : SHORT_TYPE[k] || typeLabel(k)}</button>`).join("")}</div>` : ""}
      </div>
      <div class="ov2-map" id="ov2-map" role="img" aria-label="Your positions by value, coloured by today's change"></div>
    </article>

    ${contrib.length ? `
    <article class="card panel ov2-card">
      <div class="card__head"><h3 class="card__title">What moved your money</h3><span class="card__hint">today</span></div>
      <ol class="ov2-bars">${contribRows}</ol>
      <div class="ov2-sum"><span>Net today</span><b class="${dir(t.day)}">${fmtEurSigned(t.day)}</b></div>
    </article>` : ""}

    <article class="card panel ov2-card">
      <div class="card__head"><h3 class="card__title">Your setup</h3><span class="card__hint">by value</span></div>
      <div class="alloc" role="img" aria-label="${alloc.byType.map((x) => `${x.label} ${alloc.share(x.value).toFixed(1)}%`).join(", ")}">${alloc.allocBar}</div>
      <ul class="legend">${alloc.allocLegend}</ul>
      <div class="ov2-conc">
        <div class="ov2-conc__head"><span>Concentration</span><b>Top 3 = ${share(top3).toFixed(0)}%</b></div>
        <div class="ov2-conc__bar" role="img" aria-label="Top 3 positions are ${share(top3).toFixed(0)}% of your portfolio">${conc}</div>
        <ul class="ov2-top">${topList}</ul>
      </div>
    </article>

    ${mapAll.length && monthChanges ? `
    <article class="card panel ov2-card" id="ov2-months">
      <div class="card__head"><h3 class="card__title" id="ov2-hm-title">Month by month</h3><span class="card__side">
        <span class="ov2-filter-sum" data-hm-sum></span>
        <button type="button" class="ov2-filter" data-hm-filter aria-expanded="${hmFiltersOpen}" aria-controls="ov2-hm-filters" aria-label="Choose the time range"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button></span></div>
      <div class="ov2-filters" id="ov2-hm-filters"${hmFiltersOpen ? "" : " hidden"}>
        <div class="seg ov2-seg" role="radiogroup" aria-label="Time range">${Object.keys(HM_RANGES).map((r) => `<button type="button" role="radio" data-hm-range="${r}" aria-checked="${r === hmRange}">${r}</button>`).join("")}</div>
      </div>
      <div class="ov2-hm" aria-busy="true"></div>
      <p class="ov2-hm__read" aria-live="polite"></p>
    </article>` : ""}

    ${ret.length ? `
    <article class="card panel ov2-card">
      <div class="card__head"><h3 class="card__title">Since you bought</h3></div>
      <ol class="ov2-bars">${retRows}</ol>
    </article>` : ""}

    ${evRows ? `
    <article class="card panel ov2-card">
      <div class="card__head"><h3 class="card__title">Latest</h3></div>
      <ol class="ov2-events">${evRows}</ol>
    </article>` : ""}

    ${stamp ? `<p class="note ov2-asof"><span class="ov2-live" aria-hidden="true"></span>Prices · ${esc(stamp)}</p>` : ""}`;

  // treemap needs the real width
  const host = body.querySelector("#ov2-map");
  let changes = null; // 1W … All: key → % once loaded (null while loading)
  // per position: { live, pct } for the chosen range
  const moveOf = (p) => {
    if (mapRange === "1D") return { live: p.live, pct: p.dayPct };
    const v = changes?.get(p.key);
    return v == null ? { live: false, pct: 0, loading: !changes } : { live: true, pct: v };
  };
  const when = () => (mapRange === "1D" ? "today" : mapRange === "All" ? "all time" : `over ${mapRange}`);
  const layout = () => {
    const W = host.clientWidth, H = host.clientHeight;
    if (!W) return;
    const mapItems = mapType === "all" ? mapAll : mapAll.filter((p) => p.type === mapType);
    // tiny positions (< 2 % of the map) fold into one "Others" tile; tap it to zoom into just those
    const total = mapItems.reduce((n, p) => n + p.value, 0);
    const small = mapItems.filter((p) => p.value / total < 0.02);
    if (small.length < 2) mapZoom = false;
    let items;
    if (mapZoom) items = [...small];
    else {
      items = small.length > 1 ? mapItems.filter((p) => !small.includes(p)) : [...mapItems];
      if (small.length > 1) {
        // value-weighted move of the ones with a price for this range
        let v = 0, prev = 0, any = false;
        for (const p of small) { const m = moveOf(p); if (m.live) { any = true; v += p.value; prev += p.value / (1 + m.pct / 100); } }
        items.push({ key: "", label: `Others (${small.length})`, value: small.reduce((n, p) => n + p.value, 0), move: { live: any, pct: prev ? (v / prev - 1) * 100 : 0, loading: !any && moveOf(small[0]).loading }, others: true });
      }
    }
    const title = body.querySelector("#ov2-map-title"), back = body.querySelector("[data-ov2-map-back]");
    title.textContent = mapZoom ? `Others (${small.length})` : mapRange === "1D" ? "Today's map" : "Your map";
    back.hidden = !mapZoom;
    // what's filtered, when it isn't the default 1D · All (the button gets a pink dot)
    const sum = [mapRange !== "1D" ? mapRange : "", mapType !== "all" ? SHORT_TYPE[mapType] || typeLabel(mapType) : ""].filter(Boolean).join(" · ");
    body.querySelector("[data-ov2-filter-sum]").textContent = mapZoom ? "" : sum;
    body.querySelector("[data-ov2-filter]").classList.toggle("is-on", Boolean(sum));
    host.setAttribute("aria-label", `Your ${mapType === "all" ? "positions" : typeLabel(mapType)} by value, coloured by the change ${when()}`);
    if (!items.length) { host.innerHTML = ""; return; }
    // the Others tile gets at least 7 % of the area, so it stays big enough to tap
    const rects = squarify(items.map((p) => ({ p, size: p.others ? Math.max(p.value, total * 0.07) : p.value })).sort((x, y) => y.size - x.size), 0, 0, W, H);
    host.innerHTML = rects.map(({ p, x, y, w, h }) => {
      const tw = Math.max(1, w - 3), th = Math.max(1, h - 3);
      const small = tw < 64 || th < 44;
      const m = p.move || moveOf(p);
      const state = m.live ? `${fmtPct(m.pct)} ${when()}` : m.loading ? "loading" : mapRange === "1D" ? "no live price" : `no history ${when()}`;
      return `<button type="button" class="ov2-tile${small ? " ov2-tile--small" : ""}"${p.others ? " data-ov2-others" : ` data-ov2-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""}`}
        style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${tw.toFixed(1)}px;height:${th.toFixed(1)}px;background:${moveColor(m.pct, m.live, MAP_SAT[mapRange])}"
        aria-label="${esc(p.label)}, ${share(p.value).toFixed(1)}% of portfolio, ${state}${p.others ? ", show them" : ""}">
        <span class="ov2-tile__name${p.others ? " is-others" : ""}">${esc(p.label)}</span>
        <span class="ov2-tile__pct">${m.live ? fmtPct(m.pct) : m.loading ? "…" : "—"}</span>
        <span class="ov2-tile__val">${fmtEur(p.value)}</span>
      </button>`;
    }).join("");
    host.querySelectorAll(".ov2-tile").forEach(fitTile);
  };
  // 1W … All: price history per position (loaded once per range and visit)
  const loadChanges = () => {
    changes = null;
    if (mapRange === "1D" || !mapChanges) return;
    const range = mapRange, key = `${range}|${mapAll.map((p) => p.key).join(",")}`;
    if (!changeCache.has(key)) changeCache.set(key, mapChanges(mapAll, range).catch(() => new Map()));
    changeCache.get(key).then((m) => { if (range === mapRange && host.isConnected) { changes = m; layout(); } });
  };
  // Month by month: positions down, periods across (months; quarters for 5Y, years for 10Y), each
  // cell coloured by that period's price change; black where you didn't own it. Tap a cell to read it.
  function months() {
    const cardEl = body.querySelector("#ov2-months");
    const grid = cardEl.querySelector(".ov2-hm"), read = cardEl.querySelector(".ov2-hm__read");
    const at = (m) => new Date(`${m}-15T12:00:00`);
    const longLabel = (p, step) => step === 12 ? p.from.slice(0, 4)
      : step === 3 ? `Q${Math.floor((Number(p.from.slice(5)) - 1) / 3) + 1} ${p.from.slice(0, 4)}`
      : at(p.from).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    // column heads: month initials with the year over January; Q1 … Q4 with the year over Q1; years as ’17
    const head = (p, step) => {
      const jan = p.from.endsWith("-01"), yy = `’${p.from.slice(2, 4)}`;
      if (step === 12) return `<b>&nbsp;</b>${yy}`;
      if (step === 3) return `<b>${jan ? yy : "&nbsp;"}</b>Q${Math.floor((Number(p.from.slice(5)) - 1) / 3) + 1}`;
      return `<b>${jan ? yy : "&nbsp;"}</b>${at(p.from).toLocaleDateString("en-GB", { month: "narrow" })}`;
    };
    const fallback = (R) => { // period list while loading (same as the loader's)
      const now = new Date(), cm = now.getFullYear() * 12 + now.getMonth(), cur = cm - (cm % R.step);
      const ym = (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
      return Array.from({ length: R.count }, (_, i) => { const a = cur - (R.count - 1 - i) * R.step; return { from: ym(a), to: ym(Math.min(a + R.step - 1, cm)) }; });
    };
    let data = null, token = 0;
    const hmSpec = () => HM_RANGES[hmRange] || hmAll(firstBuy?.(mapAll.map((p) => p.key)));
    const draw = () => {
      const R = hmSpec();
      const ps = data?.periods || fallback(R);
      const extra = mapAll.length - MONTH_ROWS, fold = extra >= 2;
      const shown = fold && !monthsOpen ? mapAll.slice(0, MONTH_ROWS) : mapAll;
      cardEl.querySelector("#ov2-hm-title").textContent = { 1: "Month by month", 3: "Quarter by quarter", 12: "Year by year" }[R.step];
      cardEl.querySelector("[data-hm-sum]").textContent = hmRange === "1Y" ? "" : hmRange;
      cardEl.querySelector("[data-hm-filter]").classList.toggle("is-on", hmRange !== "1Y");
      grid.style.setProperty("--cols", ps.length);
      grid.classList.toggle("is-dense", ps.length > 14);
      grid.innerHTML = `<span></span>${ps.map((p) => `<span class="ov2-hm__m" title="${longLabel(p, R.step)}">${head(p, R.step)}</span>`).join("")}`
        + shown.map((pos) => {
          const vals = data?.byKey.get(pos.key) || ps.map(() => null);
          return `<button type="button" class="ov2-hm__name" data-ov2-chart="${esc(pos.isin || pos.key)}"${pos.isin ? ` data-isin="${esc(pos.isin)}"` : ""}>${esc(pos.label)}</button>`
            + vals.map((v, i) => {
              const p = ps[i], off = heldIn && !heldIn(pos.key, p.from, p.to), last = i === ps.length - 1;
              const lbl = `${longLabel(p, R.step)}${last ? " so far" : ""}`;
              const txt = v == null ? (data ? "no price" : "loading") : fmtPct(v);
              // not yours then: black; no price: an empty outline; else the move's colour
              return `<span class="ov2-hm__c${off ? " is-off" : v == null && data ? " is-none" : ""}" data-hm="${esc(pos.label)}|${lbl}|${v == null ? "" : v}|${off ? 1 : ""}" role="img"
                aria-label="${esc(pos.label)}, ${lbl}: ${off ? "not owned" : txt}" style="background:${v == null ? "var(--bg)" : moveColor(v, true, R.sat)}"></span>`;
            }).join("");
        }).join("")
        + (fold ? `<div class="ov2-gap ov2-hm__more"><button type="button" data-hm-more aria-expanded="${monthsOpen}">${monthsOpen ? "Show less" : `${extra} more`}</button></div>` : "");
      grid.setAttribute("aria-busy", String(!data));
      read.innerHTML = `<span class="ov2-hm__scale"><span>−${R.sat}%</span><i aria-hidden="true"></i><span>+${R.sat}%</span></span>`;
    };
    const load = () => {
      data = null; draw();
      const range = hmRange, my = ++token;
      const key = `${range}|${mapAll.map((p) => p.key).join(",")}`;
      if (!monthCache.has(key)) monthCache.set(key, monthChanges(mapAll, hmSpec()).catch(() => null));
      monthCache.get(key).then((d) => { if (d && my === token && grid.isConnected) { data = d; draw(); } });
    };
    load();
    cardEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-hm-more]")) { monthsOpen = !monthsOpen; draw(); return; }
      const f = e.target.closest("[data-hm-filter]");
      if (f) { hmFiltersOpen = !hmFiltersOpen; f.setAttribute("aria-expanded", String(hmFiltersOpen)); cardEl.querySelector("#ov2-hm-filters").hidden = !hmFiltersOpen; return; }
      const r = e.target.closest("[data-hm-range]");
      if (r) {
        if (r.dataset.hmRange === hmRange) return;
        hmRange = r.dataset.hmRange;
        cardEl.querySelectorAll("[data-hm-range]").forEach((b) => b.setAttribute("aria-checked", String(b === r)));
        load(); return;
      }
      const c = e.target.closest("[data-hm]");
      if (!c) return;
      grid.querySelectorAll(".is-sel").forEach((x) => x.classList.remove("is-sel"));
      c.classList.add("is-sel");
      const [label, when, v, off] = c.dataset.hm.split("|");
      const n = v === "" ? null : Number(v);
      read.innerHTML = `<span><b>${esc(label)}</b> · ${esc(when)}${off ? " · not owned" : ""}</span>`
        + `<b class="${n == null ? "" : dir(n)}">${n == null ? (data ? "no price" : "…") : fmtPct(n)}</b>`;
    });
  }

  // Keep only what fits, measured: shrink the name first, then drop it; drop the value before
  // the %; the Others tile shortens to "Others"; nothing ends in "…" unless most of the name shows.
  function fitTile(tile) {
    const name = tile.querySelector(".ov2-tile__name"), pct = tile.querySelector(".ov2-tile__pct"), val = tile.querySelector(".ov2-tile__val");
    // precise (sub-pixel) check: scrollWidth rounds, which let "OMV" end up as "O…"
    const over = (el) => {
      if (el.scrollWidth > el.clientWidth) return true;
      const r = document.createRange(); r.selectNodeContents(el);
      return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
    };
    const others = name.classList.contains("is-others");
    if (over(name)) name.style.fontSize = "11px";
    if (over(name) && others) name.textContent = "Others";
    if (over(name) && !others) {
      // try two lines; keep it only if every word fits and it really is at most two lines
      name.classList.add("is-wrap");
      const lines = Math.round(name.scrollHeight / parseFloat(getComputedStyle(name).lineHeight));
      if (over(name) || lines > 2) {
        name.classList.remove("is-wrap");
        if (tile.clientWidth < 90) name.remove(); // narrow: no "O…" stubs; wide tiles may end in "…"
      }
    }
    if (name.isConnected && over(name) && others) name.remove();
    if (over(pct)) pct.style.fontSize = "11px";
    if (over(pct)) pct.remove();
    if (over(val)) val.remove();
    // too tall: drop value, then name, then %
    for (const el of [val, name, pct]) if (tile.scrollHeight > tile.clientHeight + 0.5 && el.isConnected) el.remove();
  }
  const card = host.closest(".card");
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-ov2-others]")) { mapZoom = true; layout(); card.querySelector("[data-ov2-map-back]").focus(); }
    else if (e.target.closest("[data-ov2-map-back]")) { mapZoom = false; layout(); }
    const f = e.target.closest("[data-ov2-filter]");
    if (f) {
      filtersOpen = !filtersOpen;
      f.setAttribute("aria-expanded", String(filtersOpen));
      card.querySelector("#ov2-map-filters").hidden = !filtersOpen;
    }
    const typeBtn = e.target.closest("[data-ov2-map-type]");
    if (typeBtn && typeBtn.dataset.ov2MapType !== mapType) {
      mapType = typeBtn.dataset.ov2MapType; mapZoom = false;
      card.querySelectorAll("[data-ov2-map-type]").forEach((b) => b.setAttribute("aria-checked", String(b === typeBtn)));
      layout();
    }
    const rangeBtn = e.target.closest("[data-ov2-map-range]");
    if (rangeBtn && rangeBtn.dataset.ov2MapRange !== mapRange) {
      mapRange = rangeBtn.dataset.ov2MapRange; mapZoom = false;
      card.querySelectorAll("[data-ov2-map-range]").forEach((b) => b.setAttribute("aria-checked", String(b === rangeBtn)));
      loadChanges(); layout();
    }
  });
  loadChanges();
  layout();
  if (mapAll.length && monthChanges) months();
  // labels are measured: measure again once the web fonts have loaded (they're wider than the fallback)
  document.fonts?.ready?.then(() => { if (host.isConnected) layout(); });
  watchRows(body);
  return { relayout: () => { layout(); alignRows(body); } };
}
