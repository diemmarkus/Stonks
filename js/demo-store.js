// Demo portfolio: same API as store.js, but in memory only. Nothing is read from or written to
// Firestore, so it is safe to show to friends. Changes last until the demo is closed or the page reloads.

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD
};

// Well-known ISINs so live prices and charts work. Buy prices are illustrative.
const SAMPLE = () => [
  { isin: "IE00BK5BQT80", type: "etf", name: "Vanguard FTSE All-World", quantity: 40, buyPrice: 118.4, buyDate: daysAgo(900) },
  { isin: "IE00BK5BQT80", type: "etf", name: "Vanguard FTSE All-World", quantity: 25, buyPrice: 139.9, buyDate: daysAgo(420) },
  { isin: "IE00B4L5Y983", type: "etf", name: "iShares Core MSCI World", quantity: 60, buyPrice: 96.2, buyDate: daysAgo(700) },
  { isin: "US0378331005", type: "stock", name: "Apple", quantity: 12, buyPrice: 172.5, buyDate: daysAgo(610) },
  { isin: "US5949181045", type: "stock", name: "Microsoft", quantity: 8, buyPrice: 395, buyDate: daysAgo(380) },
  { isin: "US67066G1040", type: "stock", name: "NVIDIA", quantity: 30, buyPrice: 118, buyDate: daysAgo(300) },
  { isin: "AT0000743059", type: "stock", name: "OMV", quantity: 50, buyPrice: 41.8, buyDate: daysAgo(520) },
  { isin: "XFC000A2YY6Q", type: "crypto", name: "Bitcoin (BTC)", quantity: 0.08, buyPrice: 61200, buyDate: daysAgo(200) },
  { isin: "US88160R1014", type: "stock", name: "Tesla", quantity: 10, buyPrice: 210, buyDate: daysAgo(480) },
  // sells (FIFO: the oldest buys go first). buyPrice is the sell price.
  { isin: "IE00BK5BQT80", type: "etf", name: "Vanguard FTSE All-World", quantity: 15, buyPrice: 132.5, buyDate: daysAgo(150), side: "sell" },
  { isin: "US67066G1040", type: "stock", name: "NVIDIA", quantity: 10, buyPrice: 158, buyDate: daysAgo(60), side: "sell" },
  { isin: "XFC000A2YY6Q", type: "crypto", name: "Bitcoin (BTC)", quantity: 0.03, buyPrice: 92500, buyDate: daysAgo(40), side: "sell" },
  { isin: "US88160R1014", type: "stock", name: "Tesla", quantity: 10, buyPrice: 305, buyDate: daysAgo(240), side: "sell" }, // fully sold
].map((h, i) => ({ id: `demo-${i + 1}`, currency: "EUR", ...h }));

let holdings = SAMPLE();
let names = {}, venues = {};
const holdingSubs = new Set(), nameSubs = new Set();
const emitHoldings = () => holdingSubs.forEach((cb) => cb(holdings.map((h) => ({ ...h }))));
const emitNames = () => nameSubs.forEach((cb) => cb({ ...names }, { ...venues }));
let nextId = 100;

export function resetDemo() {
  holdings = SAMPLE();
  names = {};
  venues = {};
}

export async function watchHoldings(uid, callback) {
  holdingSubs.add(callback);
  setTimeout(() => callback(holdings.map((h) => ({ ...h }))), 0);
  return () => holdingSubs.delete(callback);
}

export async function saveHolding(uid, id, h) {
  const data = { isin: h.isin, name: h.name || "", type: h.type, quantity: h.quantity, buyPrice: h.buyPrice, currency: "EUR", buyDate: h.buyDate || "" };
  if (h.side === "sell") data.side = "sell";
  if (id) holdings = holdings.map((x) => (x.id === id ? (({ side, ...rest }) => ({ ...rest, ...data }))(x) : x));
  else holdings = [...holdings, { id: `demo-${nextId++}`, ...data }];
  emitHoldings();
}

export async function deleteHolding(uid, id) {
  holdings = holdings.filter((x) => x.id !== id);
  emitHoldings();
}

export async function watchNames(uid, callback) {
  nameSubs.add(callback);
  setTimeout(() => callback({ ...names }, { ...venues }), 0);
  return () => nameSubs.delete(callback);
}

function setField(map, key, value) {
  const clean = (value || "").trim().slice(0, 60);
  if (clean) map[key] = clean;
  else delete map[key];
  emitNames();
}
export const setName = async (uid, key, name) => setField(names, key, name);
export const setVenue = async (uid, key, venue) => setField(venues, key, venue);
