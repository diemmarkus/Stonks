// Overview 2 (#/overview2): a visual overview of the portfolio's setup, today's changes and
// recent events. Pure rendering: app.js hands in the valued rows and helpers.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// "N more in between" unfolded per list (movers, returns); kept across re-renders
const open = { movers: false, returns: false };
let mapZoom = false; // map shows only the "Others" (kept across re-renders)
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

// today's % → tile colour: rose ← surface → mint, saturating at ±3 %
function moveColor(pct, live) {
  if (!live) return "var(--bg)";
  const k = clamp(Math.abs(pct) / 3, 0, 1);
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
  const { rows, t, pos, returns, alloc, esc, fmtEur, fmtEurSigned, fmtPct, dir, stamp, events, typeLabel } = ctx;
  const live = pos.filter((p) => p.live);
  const share = (v) => (t.value ? (v / t.value) * 100 : 0);
  const [whole, cents] = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(t.value).split(".");

  /* 1 · today's map */
  const mapItems = pos.filter((p) => p.value > 0.005).sort((a, b) => b.value - a.value);

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
  const top3 = mapItems.slice(0, 3).reduce((n, p) => n + p.value, 0);
  const conc = mapItems.map((p, i) => `<span class="ov2-conc__seg${i < 3 ? ` is-top is-top${i}` : ""}" style="flex:${p.value}" title="${esc(p.label)} · ${share(p.value).toFixed(1)}%"></span>`).join("");
  const topList = mapItems.slice(0, 3).map((p, i) => `<li><span class="ov2-sw is-top${i}"></span><span>${esc(p.label)}</span><b>${share(p.value).toFixed(1)}%</b></li>`).join("");

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
      <div class="card__head"><h3 class="card__title" id="ov2-map-title">Today's map</h3><button type="button" class="ov2-back" data-ov2-map-back hidden>← All positions</button></div>
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
  const layout = () => {
    const W = host.clientWidth, H = host.clientHeight;
    if (!W) return;
    // tiny positions (< 2 % of the map) fold into one "Others" tile; tap it to zoom into just those
    const total = mapItems.reduce((n, p) => n + p.value, 0);
    const small = mapItems.filter((p) => p.value / total < 0.02);
    if (small.length < 2) mapZoom = false;
    let items;
    if (mapZoom) items = [...small];
    else {
      items = small.length > 1 ? mapItems.filter((p) => !small.includes(p)) : [...mapItems];
      if (small.length > 1) {
        const v = small.reduce((n, p) => n + p.value, 0), prev = small.reduce((n, p) => n + (p.live ? p.prevValue : p.value), 0);
        const day = small.reduce((n, p) => n + (p.live ? p.dayChange : 0), 0);
        items.push({ key: "", label: `Others (${small.length})`, value: v, dayPct: prev ? (day / prev) * 100 : 0, live: small.some((p) => p.live), others: true });
      }
    }
    const title = body.querySelector("#ov2-map-title"), back = body.querySelector("[data-ov2-map-back]");
    title.textContent = mapZoom ? `Others (${small.length})` : "Today's map";
    back.hidden = !mapZoom;
    // the Others tile gets at least 7 % of the area, so it stays big enough to tap
    const rects = squarify(items.map((p) => ({ p, size: p.others ? Math.max(p.value, total * 0.07) : p.value })).sort((x, y) => y.size - x.size), 0, 0, W, H);
    host.innerHTML = rects.map(({ p, x, y, w, h }) => {
      const tw = Math.max(1, w - 3), th = Math.max(1, h - 3);
      const small = tw < 64 || th < 44;
      return `<button type="button" class="ov2-tile${small ? " ov2-tile--small" : ""}"${p.others ? " data-ov2-others" : ` data-ov2-chart="${esc(p.isin || p.key)}"${p.isin ? ` data-isin="${esc(p.isin)}"` : ""}`}
        style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${tw.toFixed(1)}px;height:${th.toFixed(1)}px;background:${moveColor(p.dayPct, p.live)}"
        aria-label="${esc(p.label)}, ${share(p.value).toFixed(1)}% of portfolio, ${p.live ? `${fmtPct(p.dayPct)} today` : "no live price"}${p.others ? ", show them" : ""}">
        <span class="ov2-tile__name${p.others ? " is-others" : ""}">${esc(p.label)}</span>
        <span class="ov2-tile__pct">${p.live ? fmtPct(p.dayPct) : "—"}</span>
        <span class="ov2-tile__val">${fmtEur(p.value)}</span>
      </button>`;
    }).join("");
    host.querySelectorAll(".ov2-tile").forEach(fitTile);
  };
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
  });
  layout();
  // labels are measured: measure again once the web fonts have loaded (they're wider than the fallback)
  document.fonts?.ready?.then(() => { if (host.isConnected) layout(); });
  watchRows(body);
  return { relayout: () => { layout(); alignRows(body); } };
}
