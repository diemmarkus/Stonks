# stonks

- Before committing a change to `index.html`, `css/` or `js/`: run `sh scripts/bump-version.sh`, then
  `node tests/smoke.mjs` (Playwright + Chromium) and only commit when it passes. It also runs in GitHub Actions.
- Imprint and privacy text live in `js/legal.js` (operator details are Markus's real ones, required by Austrian
  law). When a change adds a data source, a stored field or a browser-storage key, update `js/legal.js` too.
- If a change removes or renames an element the scripts use, or the legal pages, update the test rather than
  deleting checks.
