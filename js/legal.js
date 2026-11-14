// Imprint (Impressum) and privacy policy. Austrian operator: § 5 ECG, § 25 MedienG, GDPR, § 165 TKG 2021.
// Keep the services and STORAGE lists in sync with the code. This is a template, not legal advice.

export const OPERATOR = {
  name: "Markus Diem",
  street: "Leitgebgasse 7/25",
  city: "1050 Wien",
  country: "Austria",
  email: "diemmarkus@gmail.com",
};

export const CHARTS_KEY = "stonks.charts"; // "on" = load TradingView charts without asking

// Browser storage. The first entries are strictly necessary (no consent needed, § 165 (3) TKG 2021).
const STORAGE = [
  ["Firebase (IndexedDB)", "keeps you signed in"],
  [CHARTS_KEY, "remembers that you chose to always load TradingView charts (only if you ticked that box)"],
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
      { h: "Editorial line", p: ["Information about the daily price changes of selected US stocks and ETFs, and a private tool to keep track of your own holdings."] },
      { h: "No investment advice", p: ["Nothing on this site is investment advice, a recommendation or an offer to buy or sell securities. The \"top movers\" are simply the largest daily price changes within a fixed watchlist."] },
      { h: "Liability", p: ["Prices come from Finnhub and may be delayed or wrong; charts come from TradingView. All figures without guarantee. Operators of linked sites are responsible for their content."] },
    ],
  };
}

function privacy() {
  const o = OPERATOR;
  return {
    title: "Privacy policy",
    sections: [
      { h: "Controller", p: [contact()] },
      { h: "In short", p: ["stonks stores only what it needs to show your portfolio. No tracking, no analytics, no ads, and no selling of data. Charts from TradingView only load after you agree."] },
      { h: "What data we process", p: [
        "Account: when you sign in with Google, we receive your name, email address, profile picture and a technical user ID from Google.",
        "Holdings: for each holding you add, the ticker, name, type (stock/ETF), quantity, buy price, buy date and when you added or changed it. Only you can read your holdings.",
        "Public ticker list: when you add a holding, its ticker, type and the name you entered are added to a public list, so that prices for it get fetched. This list contains nothing that links a ticker to you.",
        "Visiting the site: the hosting provider processes technically necessary data such as your IP address and browser details.",
      ] },
      { h: "Purpose and legal basis", p: [
        "Account and holdings: to provide the service you choose to use (Art. 6 (1)(b) GDPR).",
        "Hosting and loading the app: secure and reliable operation (legitimate interest, Art. 6 (1)(f) GDPR).",
        "TradingView charts: your consent (Art. 6 (1)(a) GDPR, § 165 (3) TKG 2021). You can withdraw it at any time below; this does not affect loading done before.",
        "You are not required by law or contract to provide data, but without a Google sign-in you can't use the portfolio.",
      ] },
      { h: "Services we use", p: [
        "Firebase Authentication and Cloud Firestore (Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland): sign-in and storing your holdings. The Firebase program code is loaded from Google's servers (www.gstatic.com), and your Google profile picture is loaded from Google's servers; both send your IP address to Google.",
        "GitHub Pages (GitHub B.V., Netherlands, a subsidiary of GitHub Inc., USA): hosting the website.",
        "TradingView (TradingView Inc., USA): the price chart that opens when you tap a ticker. Only after you tap \"Load chart\", your browser loads the chart from TradingView, which receives your IP address and the ticker, and may set its own cookies or similar storage. See tradingview.com/privacy-policy/.",
        "Finnhub (Finnhub Stock API): our server job fetches prices from it. Your browser never contacts Finnhub and no personal data is sent to it.",
        "Fonts are served by stonks itself, not by Google.",
        "Google and GitHub are certified under the EU-US Data Privacy Framework; transfers to the USA rely on it (Art. 45 GDPR) and on standard contractual clauses. For TradingView, the transfer happens only with your consent (Art. 49 (1)(a) GDPR); the USA may not offer the same level of data protection as the EU, and US authorities may be able to access data.",
      ] },
      { h: "Storage on your device", p: ["stonks itself sets no cookies. Browser storage only holds:",
        ...STORAGE.map(([k, v]) => `• ${k}: ${v}`)] },
      { h: "How long we keep data", p: [
        "Holdings are kept until you delete them, which you can do at any time in the app.",
        `Your account and all its data are deleted on request by email to ${o.email}.`,
      ] },
      { h: "Your rights", p: [
        `You have the right to access, rectification, erasure, restriction of processing, data portability and to object (Art. 15–21 GDPR), and to withdraw consent at any time. Just write to ${o.email}.`,
        "You can also lodge a complaint with a supervisory authority, for example the Austrian Data Protection Authority (Datenschutzbehörde), Barichgasse 40–42, 1030 Vienna, dsb.gv.at.",
        "There is no automated decision-making or profiling.",
      ] },
      { h: "Last updated", p: ["November 2026"] },
    ],
  };
}

export const legalDoc = (kind) => (kind === "imprint" ? imprint : privacy)();
