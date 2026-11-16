// Reads a broker CSV export (flatex "Depotumsätze" / transactions, and similar) in the browser.
// Nothing is uploaded: the file is parsed here and only the trades you confirm are saved.
//
// Columns are found by their header names (German or English), so the order doesn't matter:
//   ISIN · name (Bezeichnung) · quantity (Nominal / Stück) · price (Kurs) · date (Buchtag / Datum)
//   and optionally the kind (Buchungsinformation: Kauf / Verkauf), amount and currency.
// flatex writes sales as negative quantities; a "Verkauf" in the kind column also marks a sale.

const HEAD = {
  isin: /^isin$/i,
  name: /bezeichnung|wertpapier(name)?$|^name$|produkt|instrument|security/i,
  qty: /nominal|st(ü|ue)ck|anzahl|menge|quantity|shares|units/i,
  price: /^kurs$|ausf(ü|ue)hrungskurs|kurs \(|preis|^price|execution price/i,
  date: /buchungstag|buchtag|schlusstag|ausf(ü|ue)hrungs(tag|datum)|handelstag|handelsdatum|^datum$|^date$|trade date|valuta/i,
  kind: /buchungsinfo|transaktion|umsatzart|^typ$|^art$|^type$|transaction|richtung|order/i,
  amount: /kurswert|^betrag|^wert$|amount|value/i,
  currency: /w(ä|ae)hrung|currency|^whg/i,
};
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$|^XFC[A-Z0-9]{9}$/;

// "1.234,56" / "-3,5" / "1,234.56" / "12" → number
export function num(v) {
  let s = String(v ?? "").replace(/[^\d,.\-−+]/g, "").replace("−", "-");
  if (!s || !/\d/.test(s)) return NaN;
  const c = s.lastIndexOf(","), d = s.lastIndexOf(".");
  if (c > d) s = s.replace(/\./g, "").replace(",", ".");   // German: 1.234,56
  else s = s.replace(/,/g, "");                             // English: 1,234.56
  return Number(s);
}
// "15.03.2024" / "15.03.24" / "2024-03-15" → "2024-03-15"
export function isoDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // 03/15/2024 (US) is ambiguous; flatex doesn't use it
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

function splitLines(text, sep) {
  const rows = [];
  let row = [], cur = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// bytes → text: UTF-8 if it decodes cleanly, else Windows-1252 (older Excel/flatex exports)
export function decode(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, ""); }
  catch { return new TextDecoder("windows-1252").decode(buffer); }
}

// → { trades: [{ isin, name, quantity, price, date, side, row }], skipped: [{ row, why }], columns }
export function parseTrades(text) {
  const first = text.split(/\r?\n/).find((l) => /isin/i.test(l)) || text.split(/\r?\n/)[0] || "";
  const sep = [";", "\t", ","].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = splitLines(text, sep).filter((r) => r.some(Boolean));
  const h = rows.findIndex((r) => r.some((c) => HEAD.isin.test(c)));
  if (h < 0) throw new Error("No ISIN column found. Export the depot transactions (Depotumsätze) as CSV.");
  const header = rows[h];
  const col = {};
  for (const [k, re] of Object.entries(HEAD)) {
    const i = header.findIndex((c, j) => re.test(c) && !Object.values(col).includes(j));
    if (i >= 0) col[k] = i;
  }
  if (col.qty == null) throw new Error("No quantity column (Nominal / Stück) found in this file.");
  if (col.price == null && col.amount == null) throw new Error("No price column (Kurs) found in this file.");

  const trades = [], skipped = [];
  rows.slice(h + 1).forEach((r, k) => {
    const line = h + k + 2;
    const isin = (r[col.isin] || "").toUpperCase().replace(/\s/g, "");
    if (!ISIN_RE.test(isin)) { if (r.filter(Boolean).length > 2) skipped.push({ row: line, why: "no ISIN" }); return; }
    const kind = col.kind != null ? r[col.kind] || "" : "";
    if (/dividend|aussch(ü|ue)ttung|ertrag|zins|coupon|kupon|steuer|tax|geb(ü|ue)hr|fee|split|kapitalma/i.test(kind)) {
      skipped.push({ row: line, why: kind || "not a trade" }); return;
    }
    let qty = num(r[col.qty]);
    if (!isFinite(qty) || qty === 0) { skipped.push({ row: line, why: "no quantity" }); return; }
    const sell = qty < 0 || /verkauf|\bsell\b|\bsale\b|ausbuchung|auslieferung/i.test(kind);
    qty = Math.abs(qty);
    let price = col.price != null ? Math.abs(num(r[col.price])) : NaN;
    // flatex puts the currency in an unnamed column right after Kurs (and after Betrag)
    const unit = (i) => (i != null && /^[A-Z]{3}$/.test((r[i + 1] || "").trim()) ? r[i + 1].trim() : "");
    const cur = (col.currency != null ? (r[col.currency] || "").toUpperCase() : "") || unit(col.price);
    // a price in another currency: use the EUR amount instead when there is one
    let eurAmount = false;
    if ((!(price > 0) || (cur && cur !== "EUR")) && col.amount != null && (!unit(col.amount) || unit(col.amount) === "EUR")) {
      const amt = Math.abs(num(r[col.amount]));
      if (amt > 0) { price = amt / qty; eurAmount = true; }
    }
    if (!(price > 0)) { skipped.push({ row: line, why: "no price" }); return; }
    if (cur && cur !== "EUR" && !eurAmount) { skipped.push({ row: line, why: `price in ${cur}` }); return; }
    trades.push({
      isin,
      name: col.name != null ? r[col.name] || "" : "",
      quantity: qty,
      price: Math.round(price * 1e4) / 1e4,
      date: col.date != null ? isoDate(r[col.date]) : "",
      side: sell ? "sell" : "buy",
      row: line,
    });
  });
  // oldest first, buys before sells on the same day (so a sale never comes before its buy)
  trades.sort((a, b) => a.date.localeCompare(b.date) || (a.side === "sell") - (b.side === "sell"));
  return { trades, skipped, columns: Object.keys(col) };
}
