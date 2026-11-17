# stonks design guidelines

How stonks looks, reads and behaves. Brand assets (logo, icons, exact palette table) live in
[`brand.md`](brand.md); this file is about using them. When the two disagree, the CSS custom
properties in `css/style.css` are the source of truth. Update this file when a change sets a new rule.

## Principles

1. **Your numbers, not ours.** stonks shows what you own and what moved. No tips, no hype, no
   trading. Copy is plain and down to earth ("See what moved today and what your stocks, ETFs and
   crypto are worth — no trading, no tips, just your numbers.").
2. **Calm by default, detail on tap.** Lists show the top and bottom 3, then "N more in between".
   Sources, disclaimers and explanations sit behind an ⓘ button. Charts, donuts and details unfold
   inline under what you tapped.
3. **Colour means something.** Mint is up, rose is down, everywhere. Pink and cyan are the brand.
   Nothing decorative uses the gain/loss colours.
4. **Phone first.** Designed for a phone held upright, then widened for desktop. Every change gets
   checked at ~390 px wide.
5. **Less chrome.** No hint text next to headings unless it adds information, no separators that
   don't separate, no captions that repeat what's on screen.

## Colour

Dark only, on a plum-black base.

| Role | Token | Hex | Rules |
|---|---|---|---|
| Page | `--bg` | `#151117` | Page background; text on pink and cyan buttons (`--on-accent`) |
| Surface | `--bg-2` | `#201A23` | Cards, tiles, sheets, tab bar |
| Line | `--line` | `#352B39` | Card borders, dividers, empty bar tracks |
| Text | `--ink` / `--ink-2` / `--ink-3` | `#FFF4F8` / `#CDB7C5` / `#A894A3` | Primary / secondary / labels, hints and timestamps |
| Brand | `--accent` | `#FF2E88` | Primary buttons, the "+" tab, focus rings, the open position's title, caret, checkboxes |
| Second | `--accent-2` | `#3CCBF4` | Text selection, "← All positions" style links, the buy-list rule, stock tag |
| Gain | `--up` (+ `--up-dim`) | `#2EE6A6` | Anything that went up |
| Loss | `--down` (+ `--down-dim`) | `#FF4D6A` | Anything that went down; destructive actions |
| Warning | — | `#FFC861` | Stale prices only |
| Open item | `--open-bg` | ink at 5 % | Background of an unfolded row and its chart |

**Gains and losses**
- Always mint / rose, and always with a sign: `+€44.83`, `−€15.66`, `+0.26%` (proper minus `−`).
  Arrows ▲ ▼ where a sign alone isn't enough (e.g. the Latest feed).
- Pills: text in the colour on its `-dim` tint (`.pill.up` / `.pill.down`).
- Charts colour their line and fill by the move of the shown range (mint if up, rose if down).
- The hero headline is the one playful use: "Sometimes **up.** A number of **downs.**"

**Categories** (asset classes, donut slices) use brand colours, never mint or rose:
ETFs `--accent`, stocks `--accent-2`, certificates `#8F72F0`, crypto `#BA8400`.
Donut slices in order: `#FF2E88`, `#3CCBF4`, `#9B7BFF`, `#F5B700`, `#FFA3CF`, `#2F6FE0`; "Other" in `--ink-3`.

**Contrast**: body text and labels ≥ 4.5:1 on `--bg-2`. Check new colours before using them for text.

## Type

| Use | Font | Style |
|---|---|---|
| Wordmark, page titles, hero numbers, headline | Manrope (`--display`) | Light 300 when big (titles 36–52 px, total value 50–84 px), Regular 400 when small; tight tracking (−0.03 em); never italic |
| UI and body | Inter Tight (`--sans`) | 400 body, 500–600 labels and names |
| Numbers, prices, %, dates, hints | JetBrains Mono (`--mono`) | Tabular; 11–14 px in lists |
| Card titles | Inter Tight 600, 13 px | UPPERCASE, +0.08 em tracking |

All fonts are self-hosted in `fonts/` (no Google requests). Cents render smaller than the euros
in big totals (`€28,413.15`).

## Layout

- Content column: `min(1120px, 100% − 40px)`; cards stack with 14 px gaps, two columns from 900 px.
- **Cards**: `--bg-2`, 1 px `--line` border, radius 14 px, padding 18 px (8 px at the bottom when a
  list ends the card). Head: title left, optional hint or control right.
- **Portfolio on a phone in portrait** runs edge to edge: no side borders or corners, 16 px inside.
- **Unfolded items** (rows, positions, allocation classes) and their chart share one `--open-bg`
  block that runs edge to edge across the card; on the last row it reaches the card's bottom edge.
  One thing open at a time.
- **Charts inside cards** run their line to the card edges; labels, readouts and range buttons keep
  the card padding.
- **Tab bar**: on phones docked to the bottom edge, square corners, frosted glass, filling the area
  under the home indicator; on wider screens a floating pill. The page never scrolls sideways.
- Small notes and the "Prices · <time>" stamp (with a pulsing mint dot) go at the bottom of a page,
  not next to titles.

## Components

- **Buttons**: primary = pink pill with plum text; secondary = outline pill. Icon buttons are round,
  32–36 px, 1 px `--line` outline, thin stroke icons (1.8–1.9 px, round caps).
- **Icons**: inline stroke SVG in `currentColor`. Edit = open square with a pencil; while editing it
  turns into a check mark. No emoji.
- **Delete (edit mode)**: small round rose outline with a rose minus, filling solid only on press.
  Deleting is undoable from the toast.
- **ⓘ info**: 28 px circle icon in the card head; opens a cyan-tinted note inside the card.
- **Fold**: "N more in between ▾" centred between the top 3 and bottom 3; "Show less ▴" folds back.
  Only fold when at least 2 rows would be hidden.
- **Tiles** (Overview): label, big mono value, optional split lines (Put in / Sold for, Open /
  Realised) under a hairline, aligned across both tiles.
- **Treemap** (Today's map): size = value, colour = today's move (rose → surface → mint, saturating
  at ±3 %). Labels are measured: shrink, then drop; never a one-letter "O…" stub. Positions under 2 %
  fold into a tappable "Others (n)" tile (≥ 7 % of the area) that zooms in with "← All positions".
- **Diverging bars** (What moved your money, Since you bought): centre line, mint right, rose left,
  value right-aligned in mono.
- **Segmented choice** (settings): pill track on `--bg`, the chosen option filled `--ink` with plum
  text, `role="radio"`; a one-line `--ink-3` note below says what the choice does.
- **Toasts** float above the tab bar; actions (Undo) are underlined text.
- **Add / edit sheet**: title left in Manrope, Save and ✕ right, no divider; the "Bought [10] for
  [€100] each [today]" sentence with pink pills; on phones the keyboard stays up while it's open.

## Data and copy

- Euros by default (`€1,234.56`); US tickers in dollars only where the source is in dollars.
- Cost of a sale follows the setting on the You page: moving average by default (gleitender
  Durchschnittspreis, like flatex Austria: every buy blends into one average per position; a sale
  takes units out at that average) or FIFO (oldest buys first, as in Germany). Which buy rows show
  as "sold" always follows FIFO. Same-day sells that held units cover go before that day's buys.
- Returns per position = open gain + realised gain, divided by everything put in (still held + cost
  of what was sold). Totals follow the same rule.
- Dates: "Today", "Yesterday", "Mon 9 Nov", "17 Sept 2026"; 24-hour times.
- Names: your own nickname if set, else the instrument name.
- Never invent numbers; missing prices say so ("no live price") and are valued at buy price.
- Keep labels short and literal: "Biggest winner", "Net today", "Sold for". No "for you", no
  "incl. …" hints when the number already includes it.

## Motion and interaction

- Transitions 150–220 ms; respect `prefers-reduced-motion`.
- Tap a row → its chart unfolds inline; tap a total → the portfolio chart.
- Swipe between Overview and Portfolio: the page follows the finger (rubber band where there's
  nothing to go to); past a quarter of the width or with a flick it slides out (150 ms) and the next
  page slides in from the other side (300 ms, ease-out); otherwise it springs back. Tapping a tab
  slides in the same direction as the tab order. In edit mode, swipe a position left to delete.
- Text selection is cyan with plum text; focus rings are 2 px pink.

## Accessibility

- Real buttons and links, `aria-label` on icon-only buttons, `aria-expanded` on anything that unfolds.
- Gains and losses are never colour-only (signs and arrows).
- Touch targets ≥ 32 px (prefer 44 px for primary actions).

## Process

- Run `sh scripts/bump-version.sh` and `node tests/smoke.mjs` before committing (see `CLAUDE.md`).
- New colours, fonts or components: add them here and, for brand assets, to `brand.md`.
