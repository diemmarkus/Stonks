// Imprint (Impressum) and privacy policy. Austrian operator: § 5 ECG, § 25 MedienG, GDPR, § 165 TKG 2021.
// Keep the services and STORAGE lists in sync with the code. This is a template, not legal advice.

export const OPERATOR = {
  name: "Markus Diem",
  street: "Leitgebgasse 7/25",
  city: "1050 Wien",
  country: "Austria",
  email: "diemmarkus@gmail.com",
};

export const CHARTS_KEY = "stonks-chart-range"; // the chart range you picked last (1D … Max)

// Browser storage. The first entries are strictly necessary (no consent needed, § 165 (3) TKG 2021).
const STORAGE = [
  ["Firebase (IndexedDB)", "keeps you signed in and keeps a copy of your holdings on this device so the app opens quickly; removed when you sign out"],
  ["stonks-session-v1", "your holdings, position names and settings from your last visit, shown right away while fresh data loads; removed when you sign out"],
  ["stonks-prices-v1", "the last known prices of your positions, shown right away while fresh prices load; removed when you sign out"],
  [CHARTS_KEY, "remembers the chart range you picked last (1D, 1W, …)"],
  ["stonks-movers-range", "remembers the period you picked for the top movers on the start page (1D, 1W, 1M, 1Y or 5Y)"],
  ["stonks-theme", "remembers if you picked Light or Dark on the You page (not set when following your system)"],
  ["stonks-reloaded-…", "session only: makes sure a new app version is loaded once, not in a loop"],
];

const contact = () => {
  const o = OPERATOR;
  return `${o.name}, ${o.street}, ${o.city}, ${o.country}, ${o.email}`;
};

function imprint() {
  const o = OPERATOR;
  return {
    title: "Imprint",
    sections: [
      { h: "Operator", p: ["Information under § 5 ECG and disclosure under § 25 MedienG (Impressum / Offenlegung)",
        [o.name, o.street, `${o.city}, ${o.country}`, `Email: ${o.email}`].join("\n")] },
      { h: "Purpose", p: ["stonks is a personal, non-commercial project of mine. There are no ads and no paid features."] },
      { h: "Editorial line", p: ["Information about the price changes of selected US-listed stocks and ETFs over a chosen period, a summary of published analyst ratings, and a private tool to keep track of your own stocks, ETFs and crypto."] },
      { h: "No investment advice", p: [
        "Nothing on this site is investment advice, a recommendation or an offer to buy or sell securities or crypto assets. The \"top movers\" are simply the largest price changes within a fixed watchlist over the period you pick.",
        "The Buy / Hold / Sell labels summarise analyst recommendations published by third parties (via Finnhub). They are not my opinion, are not tailored to you, and can be outdated or wrong.",
        "Gains, losses and sold positions are calculated from what you enter (sells at the moving average buy price or by FIFO, as you choose under You) and are for your own overview only; they are not a tax calculation.",
      ] },
      { h: "Liability", p: ["Prices come from Finnhub, onvista and CoinGecko and may be delayed or wrong; analyst ratings come from Finnhub; price charts use data from onvista and CoinGecko. All figures without guarantee. Operators of linked sites are responsible for their content."] },
    ],
  };
}

function privacy() {
  const o = OPERATOR;
  return {
    title: "Privacy policy",
    sections: [
      { h: "Controller", p: [contact()] },
      { h: "In short", p: ["stonks stores only what it needs to show your portfolio. No tracking, no analytics, no ads, and no selling of data."] },
      { h: "What data we process", p: [
        "Account: when you sign in with Google, we receive your name, email address, profile picture and a technical user ID from Google.",
        "Holdings: for each buy or sell you enter, the ISIN (or crypto code), name, type (stock, ETF or crypto), quantity, price in EUR, date, whether it is a buy or a sell, and when you added or changed it.",
        "CSV import: a file you import (for example flatex Depotumsätze) is read in your browser only and never uploaded. Only the buys and sales you confirm are saved, with the same fields as above.",
        "Position settings: a name of your own for a position and the stock exchange it should be valued with, if you set them.",
        "App settings: how the cost of what you sell is counted (moving average or FIFO), if you change it.",
        "Only you can read your holdings and position settings. We don't use them for anything other than showing you your portfolio.",
        "Visiting the site: the hosting provider processes technically necessary data such as your IP address and browser details.",
      ] },
      { h: "Purpose and legal basis", p: [
        "Account and holdings: to provide the service you choose to use (Art. 6 (1)(b) GDPR).",
        "Hosting and loading the app: secure and reliable operation (legitimate interest, Art. 6 (1)(f) GDPR).",
        "Looking up prices and price history from your browser (onvista, CoinGecko): to show you the charts and prices you open (Art. 6 (1)(b) and (f) GDPR).",
        "You are not required by law or contract to provide data, but without a Google sign-in you can't use the portfolio.",
      ] },
      { h: "Services we use", p: [
        "Firebase Authentication and Cloud Firestore (Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland): sign-in and storing your holdings. The Firebase program code is loaded from Google's servers (www.gstatic.com), and your Google profile picture is loaded from Google's servers; both send your IP address to Google.",
        "GitHub Pages (GitHub B.V., Netherlands, a subsidiary of GitHub Inc., USA): hosting the website.",
        "Finnhub (Finnhub Stock API), onvista, CoinGecko and frankfurter.app (ECB rates): our scheduled server jobs fetch prices, security names and analyst ratings from them for a fixed list of securities. Your holdings are never sent to them.",
        "onvista (onvista media GmbH, Germany): when you open stonks, your browser asks onvista's servers for the current prices of your holdings, when you enter an ISIN, for its name and price; when you search by name, for matching securities (onvista receives what you type); and when you open a price chart, your browser loads its price history from onvista. onvista then receives your IP address and that ISIN or ticker, nothing else. See onvista.de/datenschutz.",
        "CoinGecko (Gecko Labs Pte. Ltd., Singapore): only for crypto. When you enter or open a coin, your browser loads its price and price history from CoinGecko, which receives your IP address and which coin. Singapore has no EU adequacy decision; the request only happens when you look at crypto yourself (Art. 49 (1)(b) GDPR). See coingecko.com/en/privacy.",
        "Fonts are served by stonks itself, not by Google.",
        "Google and GitHub are certified under the EU-US Data Privacy Framework; transfers to the USA rely on it (Art. 45 GDPR) and on standard contractual clauses.",
      ] },
      { h: "Storage on your device", p: ["stonks itself sets no cookies. Browser storage only holds:",
        ...STORAGE.map(([k, v]) => `• ${k}: ${v}`)] },
      { h: "How long we keep data", p: [
        "Holdings and position settings are kept until you delete them, which you can do at any time in the app.",
        "The demo portfolio is kept in memory only and is never saved.",
        `Your account and all its data are deleted on request by email to ${o.email}.`,
      ] },
      { h: "Your rights", p: [
        `You have the right to access, rectification, erasure, restriction of processing, data portability and to object (Art. 15–21 GDPR). Just write to ${o.email}.`,
        "You can also lodge a complaint with a supervisory authority, for example the Austrian Data Protection Authority (Datenschutzbehörde), Barichgasse 40–42, 1030 Vienna, dsb.gv.at.",
        "There is no automated decision-making or profiling.",
      ] },
      { h: "Last updated", p: ["November 2026"] },
    ],
  };
}

export const legalDoc = (kind) => (kind === "imprint" ? imprint : privacy)();
