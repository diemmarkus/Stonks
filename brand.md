# stonks brand

## Logo

A cartoon cloth money bag ("Sack"): burlap body, warm-ink outline, rope-gold neck band, and the
double-bar dollar sign on the front.

- `img/logo.svg`: full logo, transparent background
- `img/dollar.svg`: the double-bar dollar on its own (single color, use as a CSS mask)
- Design canvas: https://claude.ai/artifact/ESW4eTMq8SsCW4Qubs7PuG

### The double-bar dollar

A heavy S with two parallel bars running through it, past the top and bottom. It is the
recurring Stonks glyph: section markers (the hero eyebrow), list icons, buttons. Tint it with
`background: var(--gold)` plus `mask: url(img/dollar.svg)`.

## Sack palette

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Ink | `#1F1A14` | `--bg` | Dark background, text on gold, `theme-color` |
| Ink raised | `#2B241C` | `--bg-2` | Cards, tab bar, sheets |
| Line | `#3D3328` | `--line` | Borders, dividers |
| Canvas | `#FBF5E9` | `--ink` | Main text on dark (light-mode background) |
| Muted | `#C9B89A` | `--ink-2` | Secondary text |
| Faint | `#A3937A` | `--ink-3` | Tertiary text (still ≥ 4.5:1 on cards) |
| Rope gold | `#F5B700` | `--gold` | Primary buttons, focus rings, active tab, key accents |
| Burlap | `#E7C98F` | `--burlap`, `--etfs` | Brand tint, ETF tag |
| Burlap deep | `#B8925A` | – | Illustration shade, borders in light mode |
| Gain | `#5BD48A` | `--up` | Up moves, always with ▲ or a + sign |
| Loss | `#FF8A75` | `--down` | Down moves, always with ▼ or a − sign |

Light mode (not built yet): background `#FBF5E9`, cards `#FFFFFF`, text `#1F1A14`,
muted `#6B5E4B`, gain `#1E7A46`, loss `#B83A2B`.

Type on the site: Instrument Serif (display, wordmark), Inter Tight (UI), JetBrains Mono (numbers).

## Icons

| File | Size | Purpose |
|---|---|---|
| `favicon.ico` | 16, 32, 48 | Classic browsers; simplified bag with thicker lines |
| `favicon.svg` | vector | Modern browser tabs |
| `favicon-96x96.png` | 96 | Fallback PNG |
| `apple-touch-icon.png` | 180 | iOS home screen (ink background) |
| `icon-192.png`, `icon-512.png` | 192, 512 | Manifest, `purpose: any` |
| `icon-maskable-192.png`, `icon-maskable-512.png` | 192, 512 | Manifest, `purpose: maskable`: full-bleed ink square, bag inside the safe zone |
| `site.webmanifest` | – | Name, colors, icons |

Android stays full color: the maskable icon fills every launcher shape, and there is deliberately
no `monochrome` icon, so themed-icon mode can't flatten it.
