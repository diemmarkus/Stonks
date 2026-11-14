# stonks

A personal financial overview, hosted on GitHub Pages with Firebase.

- **Landing page** (`index.html`): the day's top 3 gainers and losers among popular US stocks and ETFs, plus Google sign-in.
- **Portfolio** (`portfolio.html`): coming next. Add holdings and see an overview (Firestore).

## How the movers work

GitHub Pages is static, so prices are fetched by a GitHub Action, not by the browser:

1. `.github/workflows/update-movers.yml` runs every 30 minutes while US markets are open (and once after the close).
2. It runs `scripts/update-movers.mjs`, which pulls quotes for the tickers in `scripts/watchlist.mjs` from [Finnhub](https://finnhub.io).
3. The result is committed to `data/movers.json`, and the landing page reads it.

The Finnhub key lives in GitHub Secrets and never reaches the browser.

## Setup

1. **Finnhub key:** sign up at https://finnhub.io/register (free), then add the key under
   *Repo → Settings → Secrets and variables → Actions → New repository secret* as `FINNHUB_API_KEY`.
2. **First run:** *Actions → Update movers → Run workflow*.
3. **Firebase:** paste your web app config into `js/firebase-config.js`, enable Google sign-in, and add
   `diemmarkus.github.io` under *Authentication → Settings → Authorized domains*.
4. **Firestore:** create the database, then paste `firestore.rules` into *Firestore → Rules* and publish.

## Data

- `users/{uid}/holdings/{id}`: your holdings (private to you).
- `users/{uid}/names/{ISIN}`: your own names for positions (private to you).
- Prices for stocks, ETFs and certificates are fetched in the browser from onvista, so no list of
  held securities is ever published. `data/prices.json` only has crypto prices and EUR/USD.
- Charts are TradingView's free embed widget (no key needed).

## Local preview

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node scripts/update-movers.mjs --sample   # regenerate demo data
```

## Releasing changes

GitHub Pages lets browsers cache files for ~10 minutes. Before committing changes to `css/` or `js/`,
run `sh scripts/bump-version.sh`: it bumps the `?v=` on the page **and on every module import**, so
browsers never mix a new page with old cached scripts. The app also reloads itself once when it notices
a newer version.
