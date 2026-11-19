// Reads flatex trade confirmations (Wertpapierabrechnung Kauf / Verkauf, also Sammelabrechnungen
// with several orders) in the browser. Nothing is uploaded: pdf.js (self-hosted in js/vendor/pdfjs)
// turns the PDF into lines of text here, and only the trades you confirm are saved.
//
// The lines that matter look like this (flatex Austria, 2026):
//   Handelstag 17.11.2026
//   Nr. 319801760/1 Kauf VANGUARD FTSE ALL-WLD UCI (IE00BK5BQT80/A2PKXG)
//   Ausgeführt: 50 St. Kurswert: 8.340,00 EUR        (older: "davon ausgef. : 66,00 St.")
//   Kurs: 166,800000 EUR Provision: 0,00 EUR
//   Devisenkurs: 1,000000 …
// Crypto confirmations name the coin without an ISIN ("Nr.…/1 Kauf BITCOIN"); the coin is found
// in the flatex crypto list (js/crypto.js).

import { num, isoDate } from "./import-csv.js?v=176";
import { CRYPTO } from "./crypto.js?v=176";

const ISIN = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;

// PDF → lines of text, top to bottom, items on one baseline joined left to right
export async function pdfLines(buffer) {
  const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const doc = await task.promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const { items } = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str?.trim()) continue;
      const y = it.transform[5];
      let r = rows.find((row) => Math.abs(row.y - y) < 2.5);
      if (!r) rows.push((r = { y, items: [] }));
      r.items.push({ x: it.transform[4], s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim());
  }
  await task.destroy();
  return lines;
}

const date = (text, label) => {
  const m = text.match(new RegExp(`${label}\\s*:?\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4})`, "i"));
  return m ? isoDate(m[1]) : "";
};
const amount = (text, label) => {
  const m = text.match(new RegExp(`(?<![A-Za-zÄÖÜäöü])${label}\\s*:\\s*(-?[\\d.,]+)\\s*([A-Z]{3})?`, "i"));
  return m ? { v: Math.abs(num(m[1])), cur: (m[2] || "").toUpperCase() } : null;
};
const cryptoByName = (name) => {
  const n = name.toUpperCase().replace(/[^A-Z ]/g, " ").trim();
  return Object.entries(CRYPTO).find(([, c]) => n === c.name.toUpperCase() || n.split(/\s+/).includes(c.ticker))?.[0] || "";
};

// lines → { trades: [{ isin, name, quantity, price, date, side, row }], skipped: [{ row, why }] }
export function parseFlatexPdf(lines) {
  const text = lines.join("\n");
  if (!/flatex/i.test(text)) throw new Error("This PDF doesn't look like a flatex document.");
  // the trade date is in the head of the document, once for all orders
  const docDate = date(text, "Schlusstag") || date(text, "Handelstag") || date(text, "Ausf(?:ü|ue)hrungstag") || date(text, "Valuta");
  const docSide = /abrechnung\s+verkauf/i.test(text) ? "sell" : /abrechnung\s+kauf/i.test(text) ? "buy" : "";

  // one block per order ("Nr. 319801760/1 Kauf …")
  // (anywhere on its line: a barcode number or label may sit on the same baseline, left of it)
  const starts = [];
  lines.forEach((l, i) => {
    const at = l.search(/(?:^|\s)Nr\.\s*\d{5,}\/\d+\s+(?:Kauf|Verkauf)\b/i);
    if (at >= 0) { lines[i] = l.slice(at).trim(); starts.push(i); }
  });
  const trades = [], skipped = [];
  starts.forEach((s, k) => {
    const block = lines.slice(s, starts[k + 1] ?? lines.length).join("\n");
    const head = lines[s];
    const row = s + 1;
    const sideWord = head.match(/^Nr\.\s*\S+\s+(Kauf|Verkauf)\b/i)?.[1];
    const side = sideWord ? (/verkauf/i.test(sideWord) ? "sell" : "buy") : docSide;
    if (!side) { skipped.push({ row, why: "not a buy or sale" }); return; }
    let name = head.replace(/^Nr\.\s*\S+\s+(Kauf|Verkauf)\s*/i, "").replace(/\s*\(.*$/, "").trim();
    // long names wrap around the order line: "035130350000 BERKSHIRE HATHAWAY" / Nr.… / "INC. B"
    if (!name) {
      const before = (lines[s - 1] || "").replace(/^\d{6,}\s*/, "");
      const after = lines[s + 1] || "";
      name = [/[:]|abrechnung|depot/i.test(before) ? "" : before, /:/.test(after) ? "" : after].filter(Boolean).join(" ").trim();
    }
    const isin = head.match(ISIN)?.[1] || block.match(ISIN)?.[1] || cryptoByName(name);
    if (!isin) { skipped.push({ row, why: `no ISIN for ${name || "this order"}` }); return; }
    const q = block.match(/(?:davon ausgef\.?|Ausgef(?:ü|ue)hrt)\s*:\s*([\d.,]+)\s*St/i) || block.match(/Ordervolumen\s*:\s*([\d.,]+)\s*St/i);
    const quantity = q ? num(q[1]) : NaN;
    if (!(quantity > 0)) { skipped.push({ row, why: "no quantity" }); return; }
    // price in EUR: the Kurs when it's in euros, else the euro Kurswert per unit, else via the Devisenkurs
    const kurs = amount(block, "Kurs"), wert = amount(block, "Kurswert"), fx = amount(block, "Devisenkurs");
    let price = NaN;
    if (kurs && (kurs.cur === "EUR" || !kurs.cur)) price = kurs.v;
    else if (wert?.cur === "EUR") price = wert.v / quantity;
    else if (kurs && fx?.v > 0) price = kurs.v / fx.v;
    if (!(price > 0)) { skipped.push({ row, why: kurs?.cur ? `price in ${kurs.cur}` : "no price" }); return; }
    trades.push({
      isin, name,
      quantity: Math.round(quantity * 1e8) / 1e8,
      price: Math.round(price * 1e4) / 1e4,
      date: date(block, "Schlusstag") || date(block, "Handelstag") || docDate,
      side, row,
    });
  });
  if (!trades.length && !skipped.length) {
    // say which document it is: dividends, tax and account statements have no orders to import
    const kind = lines.find((l) => /abrechnung|gutschrift|aussch(ü|ue)ttung|dividende|vorabpauschale|kontoauszug|depotauszug|steuer/i.test(l) && l.length < 90) || "";
    throw new Error(kind ? `“${kind}” has no buy or sale to import. Pick a Wertpapierabrechnung (Kauf / Verkauf).` : "No buy or sale found in this PDF. Pick a Wertpapierabrechnung (Kauf / Verkauf).");
  }
  return { trades, skipped };
}
