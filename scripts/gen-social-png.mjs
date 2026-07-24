#!/usr/bin/env node
// Rasterizes brand/social-card.svg -> brand/png/social-card.png.
//
// Separate from `npm run brand` on purpose: gen-brand.mjs is dependency-free
// because it only ever encodes an integer-scaled pixel grid. The social card
// carries live text, so rasterizing it needs a real font shaper. Rather than
// take a heavyweight dependency for one asset, this shells out to a Chrome you
// already have. Run it only when the card or the palette changes.
//
//   node scripts/gen-social-png.mjs
//
// GitHub renders social previews at 1280x640; we emit 2x so the type stays
// crisp on retina, which is well inside GitHub's 1 MB ceiling.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVG = join(ROOT, "brand", "social-card.svg");
const OUT = join(ROOT, "brand", "png", "social-card.png");
const WIDTH = 1280;
const HEIGHT = 640;
const SCALE = 2;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error(
    "No Chrome/Chromium found. Set CHROME_PATH to a binary, or install one.\n" +
      "Tried:\n  " + CHROME_CANDIDATES.join("\n  ")
  );
  process.exit(1);
}

// Wrap the SVG in a fixed-size document. Screenshotting a bare .svg lets the
// browser apply its own default sizing and leaves stray margins.
const work = join(tmpdir(), `openswap-social-${process.pid}`);
mkdirSync(work, { recursive: true });
const page = join(work, "card.html");
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#0C0E12}
svg{display:block;width:${WIDTH}px;height:${HEIGHT}px}</style>
${readFileSync(SVG, "utf8")}`
);

mkdirSync(dirname(OUT), { recursive: true });
execFileSync(
  chrome,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${OUT}`,
    page,
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
rmSync(work, { recursive: true, force: true });

const png = readFileSync(OUT);
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
if (w !== WIDTH * SCALE || h !== HEIGHT * SCALE) {
  console.error(`Expected ${WIDTH * SCALE}x${HEIGHT * SCALE}, got ${w}x${h}`);
  process.exit(1);
}
console.log(`brand/png/social-card.png  ${w}x${h}  ${(png.length / 1024).toFixed(1)} kB`);
