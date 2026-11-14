# stonks brand

## Logo

A cartoon cloth money bag ("Sack"): hot-pink body, plum-black outline, electric-cyan neck band,
and the double-bar dollar sign on the front.

- `img/logo.svg`: full logo, transparent background
- `img/dollar.svg`: the double-bar dollar on its own (single color, use as a CSS mask)
- Design canvas: https://claude.ai/artifact/ESW4eTMq8SsCW4Qubs7PuG

### The double-bar dollar

A heavy S with two parallel bars running through it, past the top and bottom. It is the
recurring Stonks glyph: section markers (the hero eyebrow), list icons, buttons. Tint it with
`background: var(--accent)` plus `mask: url(img/dollar.svg)`.

## Pink palette

Hot pink is the main highlight, electric cyan the second. Gains stay green; losses are orange so they never read as the brand pink.

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Plum black | `#151117` | `--bg` | Page background, text on pink, `theme-color`, icon background |
| Raised | `#201A23` | `--bg-2` | Cards, tab bar, sheets |
| Line | `#352B39` | `--line` | Borders, dividers |
| Text | `#FFF4F8` | `--ink` | Main text |
| Muted | `#CDB7C5` | `--ink-2` | Secondary text |
| Faint | `#A894A3` | `--ink-3` | Tertiary text |
| Hot pink | `#FF2E88` | `--accent` | Primary buttons, "+" tab, focus rings, active tab, dollar glyph, headline highlight |
| Pink hover | `#FF5CA3` | `--accent-hi` | Hover state of pink buttons |
| Gain | `#5BD48A` | `--up` | Up moves, always with a + sign or ▲ |
| Loss | `#FF9F4A` | `--down` | Down moves, always with a − sign or ▼ |
| Warning | `#FFC861` | – | Stale prices, notes |
| Electric cyan | `#3CCBF4` | `--accent-2`, `--stocks` | Second highlight: text selection, logo neck band, stock tag and allocation, buy list rule |
| (ETFs) | `#FF2E88` | `--etfs` | ETF tag and allocation use the pink |

Logo colors: pink `#FF2E88`, pink shade `#B3175A`, pink highlight `#FF9CC8`, outline and $ `#151117`, neck band `#3CCBF4`.

Type on the site: **Manrope** for titles and the wordmark (`--display`; Light 300 for big titles, Regular 400 for small ones, no italics), Inter Tight (UI, body), JetBrains Mono (numbers). All self-hosted under `fonts/`.

Earlier palette (Sack: warm ink + rope gold) was tried and replaced on 2026-11-14.

## Icons

| File | Size | Purpose |
|---|---|---|
| `favicon.ico` | 16, 32, 48 | Classic browsers; simplified bag with thicker lines |
| `favicon.svg` | vector | Modern browser tabs |
| `favicon-96x96.png` | 96 | Fallback PNG |
| `apple-touch-icon.png` | 180 | iOS home screen (plum-black background) |
| `icon-192.png`, `icon-512.png` | 192, 512 | Manifest, `purpose: any` |
| `icon-maskable-192.png`, `icon-maskable-512.png` | 192, 512 | Manifest, `purpose: maskable`: full-bleed plum-black square, bag inside the safe zone |
| `site.webmanifest` | – | Name, colors, icons |

Android stays full color: the maskable icon fills every launcher shape, and there is deliberately
no `monochrome` icon, so themed-icon mode can't flatten it.
