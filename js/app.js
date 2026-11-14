import { isConfigured, signIn, signOutUser, onUser } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const fmtPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

$("year").textContent = new Date().getFullYear();

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- movers ---------- */
const GROUPS = [
  { kind: "stocks", title: "Stocks" },
  { kind: "etfs", title: "ETFs" },
];
let activeKind = "stocks";

function rowsHtml(items, dir) {
  const max = Math.max(...items.map((i) => Math.abs(i.changePct)), 0.01);
  return items.map((i, idx) => `
    <li class="row">
      <span class="row__rank">${idx + 1}</span>
      <div class="row__id">
        <div class="row__sym">${esc(i.symbol)}</div>
        <div class="row__name">${esc(i.name)}</div>
        <div class="row__bar"><span style="width:${(Math.abs(i.changePct) / max) * 100}%"></span></div>
      </div>
      <div class="row__nums">
        <div class="row__price">$${fmtPrice.format(i.price)}</div>
        <span class="pill ${dir}">${fmtPct(i.changePct)}</span>
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

function card(dir, title, hint, body) {
  return `
    <article class="card card--${dir}">
      <div class="card__head"><h3 class="card__title">${title}</h3><span class="card__hint">${hint}</span></div>
      <ol class="rows">${body}</ol>
    </article>`;
}

function renderBoards(data) {
  $("boards").innerHTML = GROUPS.map(({ kind, title }) => {
    const g = data?.[kind];
    const up = g ? rowsHtml(g.gainers, "up") : skeletonRows();
    const down = g ? rowsHtml(g.losers, "down") : skeletonRows();
    return `
      <div class="group ${kind === activeKind ? "is-active" : ""}" data-kind="${kind}">
        <h2 class="group__title">${title}</h2>
        <div class="group__cards">
          ${card("up", "Top gainers", "1D change", up)}
          ${card("down", "Top losers", "1D change", down)}
        </div>
      </div>`;
  }).join("");
}

function renderMeta(data) {
  const when = new Date(data.updatedAt);
  const stamp = when.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("asof").textContent = `Movers · ${stamp}`;
  const n = data.quotes?.length ?? 0;
  $("note").innerHTML = data.sample
    ? `<span class="badge">● Sample data.</span> Live numbers appear once the “Update movers” GitHub Action has run.`
    : `Based on ${n} US-listed stocks and ETFs · prices via ${esc(data.source || "market data")} · updated ${stamp}.`;
}

async function loadMovers() {
  renderBoards(null);
  try {
    const res = await fetch(`data/movers.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    renderBoards(data);
    renderMeta(data);
  } catch (e) {
    console.error("Loading movers failed", e);
    $("boards").innerHTML = "";
    $("note").textContent = "Couldn't load today's movers. Try again in a bit.";
  }
}

document.querySelectorAll(".switch button").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeKind = btn.dataset.kind;
    document.querySelectorAll(".switch button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    document.querySelectorAll(".group").forEach((g) => g.classList.toggle("is-active", g.dataset.kind === activeKind));
  });
});

/* ---------- auth ---------- */
async function handleSignIn() {
  if (!isConfigured) {
    toast("Firebase isn't configured yet — add your config to js/firebase-config.js");
    return;
  }
  try {
    await signIn();
  } catch (e) {
    if (e?.code === "auth/popup-closed-by-user" || e?.code === "auth/cancelled-popup-request") return;
    if (e?.code === "auth/unauthorized-domain") toast("Add this domain under Firebase → Authentication → Settings → Authorized domains");
    else toast("Sign-in failed. Please try again.");
    console.error(e);
  }
}

$("signin").addEventListener("click", handleSignIn);
$("cta-signin").addEventListener("click", handleSignIn);
$("signout").addEventListener("click", () => signOutUser().catch(console.error));

onUser((user) => {
  const signedIn = Boolean(user);
  $("signin").hidden = signedIn;
  $("user").hidden = !signedIn;
  $("cta-signin").hidden = signedIn;
  $("cta-portfolio").hidden = !signedIn;
  if (user) {
    $("user-name").textContent = user.displayName || user.email || "";
    if (user.photoURL) $("user-avatar").src = user.photoURL;
    else $("user-avatar").removeAttribute("src");
  }
}).catch((e) => console.error("Auth init failed", e));

loadMovers();
