// Crypto coins as flatex / DEGIRO list them. Their "ISINs" (XFC…) are broker-internal codes,
// not real ISINs (no check digit), so they're recognised from this table.
// Source: DEGIRO "Übersicht der handelbaren Kryptowerte".
// Prices come from CoinGecko (free, no key, allows browser requests).

export const CRYPTO = {
  XFC000A2YY6Q: { ticker: "BTC", name: "Bitcoin", cg: "bitcoin", tv: "COINBASE:BTCEUR" },
  XFC000A2YY6X: { ticker: "ETH", name: "Ethereum", cg: "ethereum", tv: "COINBASE:ETHEUR" },
  XFC000A402EM: { ticker: "ADA", name: "Cardano", cg: "cardano", tv: "COINBASE:ADAEUR" },
  XFC000A402FC: { ticker: "SOL", name: "Solana", cg: "solana", tv: "COINBASE:SOLEUR" },
  XFC000A402FE: { ticker: "XRP", name: "XRP", cg: "ripple", tv: "COINBASE:XRPEUR" },
  XFC000A402DH: { ticker: "LTC", name: "Litecoin", cg: "litecoin", tv: "COINBASE:LTCEUR" },
  XFC000A3C3BH: { ticker: "DOT", name: "Polkadot", cg: "polkadot", tv: "COINBASE:DOTEUR" },
  XFC000A402DB: { ticker: "BCH", name: "Bitcoin Cash", cg: "bitcoin-cash", tv: "COINBASE:BCHEUR" },
  XFC000A402EN: { ticker: "ATOM", name: "Cosmos", cg: "cosmos", tv: "COINBASE:ATOMEUR" },
  XFC000A402DD: { ticker: "DOGE", name: "Dogecoin", cg: "dogecoin", tv: "COINBASE:DOGEEUR" },
  XFC000A3DH2J: { ticker: "AVAX", name: "Avalanche", cg: "avalanche-2", tv: "COINBASE:AVAXEUR" },
  XFC000A2YY62: { ticker: "TRX", name: "Tron", cg: "tron", tv: "" },
  XFC000A402F9: { ticker: "POL", name: "Polygon", cg: "polygon-ecosystem-token", tv: "COINBASE:POLEUR" },
  XFC000A402EX: { ticker: "LINK", name: "Chainlink", cg: "chainlink", tv: "COINBASE:LINKEUR" },
  XFC000A402EG: { ticker: "UNI", name: "Uniswap", cg: "uniswap", tv: "COINBASE:UNIEUR" },
  XFC000A402ET: { ticker: "ETC", name: "Ethereum Classic", cg: "ethereum-classic", tv: "COINBASE:ETCEUR" },
  XFC000A2YY60: { ticker: "XLM", name: "Stellar", cg: "stellar", tv: "COINBASE:XLMEUR" },
  XFC000A402EL: { ticker: "AAVE", name: "Aave", cg: "aave", tv: "COINBASE:AAVEEUR" },
  XFC000A4AJNY: { ticker: "COMP", name: "Compound", cg: "compound-governance-token", tv: "COINBASE:COMPEUR" },
  XFC000A402FG: { ticker: "HBAR", name: "Hedera", cg: "hedera-hashgraph", tv: "COINBASE:HBAREUR" },
  XFC000A4AJPK: { ticker: "SUI", name: "Sui", cg: "sui", tv: "COINBASE:SUIEUR" },
  XFC000A4AQ5D: { ticker: "HYPE", name: "Hyperliquid", cg: "hyperliquid", tv: "" },
  XFC000A402FA: { ticker: "NEAR", name: "NEAR Protocol", cg: "near", tv: "COINBASE:NEAREUR" },
};

export const isCryptoCode = (code) => Object.prototype.hasOwnProperty.call(CRYPTO, code);

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

// codes → { code: entry } in the same shape as the ISIN price list
export async function lookupCrypto(codes, fetchOpts = {}) {
  const wanted = codes.filter(isCryptoCode);
  if (!wanted.length) return {};
  const ids = [...new Set(wanted.map((c) => CRYPTO[c].cg))].join(",");
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur&include_24hr_change=true`, fetchOpts);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const body = await res.json();
  const out = {};
  for (const code of wanted) {
    const c = CRYPTO[code];
    const q = body[c.cg];
    if (!q || typeof q.eur !== "number") continue;
    const pct = typeof q.eur_24h_change === "number" ? q.eur_24h_change : 0;
    const prev = q.eur / (1 + pct / 100);
    out[code] = {
      isin: code,
      name: `${c.name} (${c.ticker})`,
      type: "crypto",
      tv: c.tv,
      venue: "CoinGecko",
      currency: "EUR",
      price: round(q.eur),
      change: round(q.eur - prev),
      changePct: Math.round(pct * 100) / 100,
    };
  }
  return out;
}
