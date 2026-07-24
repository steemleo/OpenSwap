# OpenSwap brand

**Otto the Otter** — a 12×12 pixel otter clutching an amber diamond — is the
OpenSwap mascot. The **amber diamond ◆** is the product glyph (it already leads
every CLI header). One system: Otto is the face, the diamond is the mark he
holds.

## Source of truth

`otto.pixels.json` is canonical — the grid + palette everything else derives
from. Every SVG, PNG, and the terminal sprite are **generated**:

```bash
npm run brand        # = node scripts/gen-brand.mjs
```

Edit the JSON (or the generator), rerun, commit the outputs. Never hand-edit a
generated file — `test/unit/otto.test.ts` fails if committed assets drift from
the source (and locks the terminal renderer in `src/render/otto.ts` to
`otto.ansi.txt` byte for byte).

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| amber | `#F59E0B` | Brand accent — diamond, CLI structure, CTAs. Never used for warnings. |
| honey | `#FFC24D` | Diamond highlight |
| fur | `#A16A45` | Otto's fur |
| paw | `#7A4E32` | Paws, fur shading |
| shadow | `#3D2A1D` | Eyes, deep shading |
| muzzle | `#EFDDC3` | Muzzle, belly — light text on dark grounds |
| ink | `#111419` | Terminal ground, dark surfaces |
| paper | `#FBF8F3` | Light ground |
| muted dark / light | `#9AA3AD` / `#6B7280` | Secondary text on dark / light |

Wordmark: lowercase monospace **`openswap`** (stack: `ui-monospace, 'SF Mono',
Menlo, 'Cascadia Mono', Consolas, monospace`). In UI prose the product is
"OpenSwap"; the command is `openswap`.

## Asset index (all generated unless noted)

| File | Use |
| --- | --- |
| `otto.pixels.json` | **Canonical pixel source** (hand-edited) |
| `otto.svg` | The mascot mark, any size (vector, crisp edges) |
| `png/otto-{16,32,48,64,128,180,192,256,512,1024}.png` | Favicons (16/32/48), Apple touch (180), Android/PWA (192/512), avatars — integer-scaled, transparent |
| `diamond.svg` | Product glyph (hand-made vector, kept in sync by eye) |
| `wordmark-{dark,light}.svg` | Text-only lockup |
| `lockup-horizontal-{dark,light}.svg` | Otto + wordmark, side by side |
| `lockup-stacked-{dark,light}.svg` | Otto + wordmark, stacked |
| `banner-readme-{dark,light}.svg` | README hero (used via `<picture>` for theme switching) |
| `social-card.svg` | 1280×640 social preview — export to PNG at publish time for GitHub's social-preview upload |
| `otto.ansi.txt` | Terminal preview — `cat brand/otto.ansi.txt` in a truecolor terminal |
| `exploration/` | Retired logo candidates from the selection rounds (hand-made, kept for history) |

## Otto in the terminal

- Rendered by `src/render/otto.ts` with half-blocks (`▀` foreground = upper
  pixel, background = lower) — the 12×12 sprite lands in **6 rows**.
- Appears **only** on the bare `openswap` intent menu. Never on subcommands,
  never in `--json`/piped output, never with a startup delay.
- Degradation ladder: truecolor → nearest xterm-256 → **not shown** (plain
  text header instead). `NO_COLOR`, `--no-color`, `TERM=dumb`, non-UTF-8
  locales, and terminals narrower than 52 columns all get the text header.

## Usage rules

- Don't stretch, recolor, outline, or add effects to Otto — scale in whole
  multiples only (nearest-neighbor; the PNGs already do this).
- Keep clear space around marks of at least one sprite pixel (1/12 of width).
- Dark grounds use `ink`, light grounds use `paper` — don't put Otto on busy
  imagery.
- The diamond stays amber. Amber is never a warning color.
- Stickers/swag: die-cut Otto's silhouette (the outer sprite edge), minimum
  1.5 in — pixel art reads great at sticker scale.

## Reuse & forks

MIT, like the rest of the repo. Forks are welcome to ship Otto or to rebrand —
`otto.pixels.json` + `scripts/gen-brand.mjs` are a complete pixel-mascot
pipeline: swap in your own grid and palette and regenerate the whole kit.
