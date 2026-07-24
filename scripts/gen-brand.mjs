#!/usr/bin/env node
// Generates every derived brand asset from brand/otto.pixels.json — the single
// source of truth for the mascot. Zero dependencies (PNG encoder is ~40 lines
// over node:zlib). Run after any pixel/palette change:
//
//   node scripts/gen-brand.mjs
//
// Outputs (all under brand/): otto.svg, wordmark + lockups (dark/light),
// banner-readme (dark/light), social-card.svg, otto.ansi.txt, png/otto-*.png.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(ROOT, "brand");

export const otto = JSON.parse(readFileSync(join(BRAND, "otto.pixels.json"), "utf8"));

const INK = "#111419";
const INK_BORDER = "#23282F";
const PAPER = "#FBF8F3";
const PAPER_BORDER = "#E7DFD2";
const AMBER = "#F59E0B";
const MUTED_DARK = "#9AA3AD";
const MUTED_LIGHT = "#6B7280";
const MONO = "ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', Consolas, monospace";

// ---------------------------------------------------------------- SVG pieces

export function ottoRects(indent = "  ") {
  const rects = [];
  otto.grid.forEach((row, y) => {
    [...row].forEach((key, x) => {
      const fill = otto.palette[key];
      if (fill) rects.push(`${indent}<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`);
    });
  });
  return rects.join("\n");
}

function ottoGroup(tx, ty, scale) {
  return [
    `  <g transform="translate(${tx} ${ty}) scale(${scale})" shape-rendering="crispEdges">`,
    ottoRects("    "),
    "  </g>"
  ].join("\n");
}

function diamondGlyph(cx, cy, r, fill) {
  return `  <polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="${fill}"/>`;
}

export function ottoSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges">',
    ottoRects(),
    "</svg>",
    ""
  ].join("\n");
}

function wordmarkSvg(ink) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 60">',
    `  <text x="8" y="30" dominant-baseline="central" font-family="${MONO}" font-size="40" font-weight="700" fill="${ink}">openswap</text>`,
    "</svg>",
    ""
  ].join("\n");
}

function lockupHorizontalSvg(ink) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 120">',
    ottoGroup(8, 6, 9),
    `  <text x="140" y="60" dominant-baseline="central" font-family="${MONO}" font-size="44" font-weight="700" fill="${ink}">openswap</text>`,
    "</svg>",
    ""
  ].join("\n");
}

function lockupStackedSvg(ink) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 260">',
    ottoGroup(48, 16, 12),
    `  <text x="120" y="212" text-anchor="middle" dominant-baseline="central" font-family="${MONO}" font-size="36" font-weight="700" fill="${ink}">openswap</text>`,
    "</svg>",
    ""
  ].join("\n");
}

function bannerReadmeSvg(theme) {
  const dark = theme === "dark";
  const panel = dark ? INK : PAPER;
  const border = dark ? INK_BORDER : PAPER_BORDER;
  const ink = dark ? PAPER : INK;
  const muted = dark ? MUTED_DARK : MUTED_LIGHT;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300">',
    `  <rect x="1" y="1" width="1198" height="298" rx="24" fill="${panel}" stroke="${border}" stroke-width="2"/>`,
    ottoGroup(56, 54, 16),
    diamondGlyph(302, 122, 13, AMBER),
    `  <text x="330" y="122" dominant-baseline="central" font-family="${MONO}" font-size="58" font-weight="700" fill="${ink}">openswap</text>`,
    `  <text x="330" y="180" dominant-baseline="central" font-family="${MONO}" font-size="24" fill="${muted}">open-source crosschain swaps · right from your terminal</text>`,
    `  <text x="330" y="228" dominant-baseline="central" font-family="${MONO}" font-size="24"><tspan fill="${muted}">$ </tspan><tspan fill="${AMBER}" font-weight="700">npx openswap</tspan></text>`,
    "</svg>",
    ""
  ].join("\n");
}

// GitHub crops social previews to varying aspect ratios on different surfaces
// — everything meaningful stays inside the center 1000×500 safe zone
// (x 140–1140, y 70–570).
function socialCardSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640">',
    '  <rect width="1280" height="640" fill="#0C0E12"/>',
    ottoGroup(760, 140, 30),
    diamondGlyph(158, 246, 18, AMBER),
    `  <text x="196" y="246" dominant-baseline="central" font-family="${MONO}" font-size="88" font-weight="700" fill="${PAPER}">openswap</text>`,
    `  <text x="140" y="330" dominant-baseline="central" font-family="${MONO}" font-size="32" fill="${MUTED_DARK}">open-source crosschain swaps</text>`,
    `  <text x="140" y="376" dominant-baseline="central" font-family="${MONO}" font-size="32" fill="${MUTED_DARK}">right from your terminal</text>`,
    '  <rect x="140" y="432" width="400" height="68" rx="12" fill="#14171C" stroke="#262B33" stroke-width="2"/>',
    `  <text x="164" y="466" dominant-baseline="central" font-family="${MONO}" font-size="30"><tspan fill="${MUTED_LIGHT}">$ </tspan><tspan fill="${AMBER}" font-weight="700">npx openswap</tspan></text>`,
    `  <text x="140" y="552" dominant-baseline="central" font-family="${MONO}" font-size="24" fill="${MUTED_LIGHT}">by LeoDex</text>`,
    "</svg>",
    ""
  ].join("\n");
}

// ------------------------------------------------- ANSI (terminal preview)

function hexToRgbTriplet(hex) {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => Number.parseInt(h, 16));
}

// Must stay byte-identical to renderOttoAnsi() in src/render/otto.ts under
// truecolor caps — test/unit/otto.test.ts locks the two together.
export function ottoAnsi() {
  const RESET = "\x1b[0m";
  const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
  const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
  const lines = [];
  for (let y = 0; y < otto.grid.length; y += 2) {
    const top = otto.grid[y] ?? "";
    const bottom = otto.grid[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < 12; x++) {
      const t = otto.palette[top[x]] && hexToRgbTriplet(otto.palette[top[x]]);
      const b = otto.palette[bottom[x]] && hexToRgbTriplet(otto.palette[bottom[x]]);
      if (t && b) line += `${fg(t)}${bg(b)}▀${RESET}`;
      else if (t) line += `${fg(t)}▀${RESET}`;
      else if (b) line += `${fg(b)}▄${RESET}`;
      else line += " ";
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

// ----------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Integer nearest-neighbor scale, centered on a transparent canvas — the only
// correct way to resize pixel art (fractional scaling smears the sprite).
export function ottoPng(size) {
  const cols = 12;
  const scale = Math.max(1, Math.floor(size / cols));
  const pad = Math.floor((size - cols * scale) / 2);
  const rgba = Buffer.alloc(size * size * 4);
  otto.grid.forEach((row, gy) => {
    [...row].forEach((key, gx) => {
      const hex = otto.palette[key];
      if (!hex) return;
      const [r, g, b] = hexToRgbTriplet(hex);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = pad + gx * scale + dx;
          const py = pad + gy * scale + dy;
          if (px >= size || py >= size) continue;
          const o = (py * size + px) * 4;
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] = 255;
        }
      }
    });
  });
  return encodePng(size, size, rgba);
}

// ----------------------------------------------------------------- main

export function generate() {
  const files = new Map([
    ["otto.svg", ottoSvg()],
    ["wordmark-dark.svg", wordmarkSvg(PAPER)],
    ["wordmark-light.svg", wordmarkSvg(INK)],
    ["lockup-horizontal-dark.svg", lockupHorizontalSvg(PAPER)],
    ["lockup-horizontal-light.svg", lockupHorizontalSvg(INK)],
    ["lockup-stacked-dark.svg", lockupStackedSvg(PAPER)],
    ["lockup-stacked-light.svg", lockupStackedSvg(INK)],
    ["banner-readme-dark.svg", bannerReadmeSvg("dark")],
    ["banner-readme-light.svg", bannerReadmeSvg("light")],
    ["social-card.svg", socialCardSvg()],
    ["otto.ansi.txt", ottoAnsi()]
  ]);
  for (const [name, content] of files) writeFileSync(join(BRAND, name), content);

  mkdirSync(join(BRAND, "png"), { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
  for (const size of sizes) writeFileSync(join(BRAND, "png", `otto-${size}.png`), ottoPng(size));

  return [...files.keys(), ...sizes.map((s) => `png/otto-${s}.png`)];
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const written = generate();
  console.log(`brand: generated ${written.length} assets from otto.pixels.json`);
}
