# Fonts

This directory holds the web font files used by the Comic theme
(introduced in Increment 1, Sprint 1.1).

## Required files

| Filename                       | Family       | Weight | Source                                                |
|--------------------------------|--------------|--------|-------------------------------------------------------|
| `BebasNeue-Regular.woff2`      | Bebas Neue   | 400    | https://fonts.google.com/specimen/Bebas+Neue          |
| `Montserrat-Regular.woff2`     | Montserrat   | 400    | https://fonts.google.com/specimen/Montserrat          |
| `Montserrat-Bold.woff2`        | Montserrat   | 700    | https://fonts.google.com/specimen/Montserrat          |

If any of these files are missing the CSS `@font-face` declaration
(in `styles/comic.css`) will simply fail and the next stack in
`--cm-font-display` / `--cm-font-body` takes over. Nothing breaks —
the sheet just renders in Oswald / Impact / system-ui.

## Why these two?

- **Bebas Neue** — Tall, bold, condensed all-caps sans-serif. Used for
  character names, stat numbers, panel headers, and any display
  typography. Matches the visual idiom of modern comic-book lettering.
- **Montserrat** — Highly legible geometric sans-serif. Used for body
  text, descriptions, and labels. Pairs well with Bebas Neue.

## How to convert TTF → WOFF2

Google Fonts ships `.ttf` files. Foundry serves static files directly,
so we want `.woff2` for the ~50% smaller payload and built-in browser
caching.

Option 1 — Browser tool (no install):
1. Download the TTF from Google Fonts.
2. Drop it on https://cloudconvert.com/ttf-to-woff2 (or any equivalent).
3. Save the result here with the filename from the table above.

Option 2 — Command line (if you have it):
```
woff2_compress BebasNeue-Regular.ttf
```

## Licensing

Both fonts are licensed under the **SIL Open Font License 1.1**, which
permits redistribution as part of a software bundle including
commercial and fan-made products, provided the original copyright
notice is preserved.

When releasing the system, ensure this directory contains a copy of
each font's `LICENSE.txt` (or `OFL.txt`) alongside the `.woff2` files.
The license text is distributed with each Google Fonts download.
