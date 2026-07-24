import ottoData from "../../brand/otto.pixels.json";
import { VERSION } from "../version.js";
import { isTestMode } from "../core/paths.js";
import { accent, accentBold, bold, dim, glyph, termCaps, warn, type TermCaps } from "./theme.js";

// Otto the Otter — the OpenSwap mascot. brand/otto.pixels.json is the single
// source of truth for the sprite; every brand/ SVG and PNG is generated from it
// (`node scripts/gen-brand.mjs`), so the terminal, README, and press kit can
// never drift apart.
//
// Rendering contract: Otto appears ONLY on the bare `openswap` menu, only in a
// TTY, and only when the terminal can do him justice (unicode + 256/truecolor).
// Anywhere else — subcommands, pipes, --json, NO_COLOR — he stays out of the way.

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

const GRID: readonly string[] = ottoData.grid;
const SPRITE_COLS = 12;
const PALETTE = new Map<string, Rgb>(
  Object.entries(ottoData.palette).map(([key, hex]) => [key, hexToRgb(hex)])
);

// Nearest xterm-256 code: 6×6×6 color cube (16–231) vs grayscale ramp (232–255).
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(v: number): number {
  let best = 0;
  for (let i = 1; i < CUBE.length; i++) {
    if (Math.abs((CUBE[i] ?? 0) - v) < Math.abs((CUBE[best] ?? 0) - v)) best = i;
  }
  return best;
}

export function nearest256(rgb: Rgb): number {
  const [r, g, b] = rgb;
  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  const cubeDist =
    ((CUBE[ri] ?? 0) - r) ** 2 + ((CUBE[gi] ?? 0) - g) ** 2 + ((CUBE[bi] ?? 0) - b) ** 2;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayDist = (gray - r) ** 2 + (gray - g) ** 2 + (gray - b) ** 2;
  return grayDist < cubeDist ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
}

type OttoDepth = "truecolor" | "256";
const RESET = "\x1b[0m";

function fg(rgb: Rgb, depth: OttoDepth): string {
  return depth === "truecolor"
    ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[38;5;${nearest256(rgb)}m`;
}

function bg(rgb: Rgb, depth: OttoDepth): string {
  return depth === "truecolor"
    ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[48;5;${nearest256(rgb)}m`;
}

// Half-block rendering: one terminal cell holds two vertically stacked pixels
// (▀ paints the upper pixel with the foreground, the lower with the background),
// so a 12×12 sprite lands in 6 rows — mascot-sized, not banner-sized.
// Every cell carries its own reset: no bleed into padding or scroll-back.
function renderGridAnsi(grid: readonly string[], palette: Map<string, Rgb>, caps: TermCaps): string[] {
  if (!caps.color || !caps.unicode) return [];
  if (caps.depth !== "truecolor" && caps.depth !== "256") return [];
  const depth: OttoDepth = caps.depth;
  const cols = grid[0]?.length ?? 0;
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? "";
    const bottom = grid[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < cols; x++) {
      const t = palette.get(top[x] ?? ".");
      const b = palette.get(bottom[x] ?? ".");
      if (t && b) line += `${fg(t, depth)}${bg(b, depth)}▀${RESET}`;
      else if (t) line += `${fg(t, depth)}▀${RESET}`;
      else if (b) line += `${fg(b, depth)}▄${RESET}`;
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}

export function renderOttoAnsi(caps: TermCaps = termCaps()): string[] {
  return renderGridAnsi(GRID, PALETTE, caps);
}

// ── Otto's sandbox (test mode) ──────────────────────────────────────────
// The mascot sits in a wooden sandbox: walls beside his lower half, two rows
// of sand under him. Two frames differ by sand speckles + a tossed grain, so
// `openswap test on` can play a tiny dig animation.
const SANDBOX_PALETTE = new Map<string, Rgb>([
  ...PALETTE,
  ["S", hexToRgb("#E8C982")], // sand
  ["T", hexToRgb("#D4A757")], // sand shade
  ["W", hexToRgb("#8B5E34")] // sandbox wall
]);

export function sandboxGrid(frame: 0 | 1): string[] {
  const rows: string[] = [];
  for (let y = 0; y < GRID.length; y++) {
    const wall = y >= 7 ? "W" : ".";
    rows.push(`${wall}.${GRID[y]}.${wall}`);
  }
  const speckle = (specks: number[]): string => {
    let row = "W";
    for (let x = 1; x <= 14; x++) row += specks.includes(x) ? "T" : "S";
    return `${row}W`;
  };
  rows.push(speckle(frame === 0 ? [3, 7, 11] : [4, 8, 12]));
  rows.push(speckle(frame === 0 ? [5, 9, 13] : [2, 6, 10]));
  if (frame === 1) {
    // a grain of sand mid-toss beside his paw
    const r = rows[10]!.split("");
    r[3] = "S";
    rows[10] = r.join("");
  }
  return rows;
}

export function renderSandboxAnsi(caps: TermCaps = termCaps(), frame: 0 | 1 = 0): string[] {
  return renderGridAnsi(sandboxGrid(frame), SANDBOX_PALETTE, caps);
}

// The front-door hero: Otto beside the wordmark. Empty array = caller falls
// back to the plain text header, so degraded terminals lose nothing. In test
// mode, Otto sits in his sandbox — the mascot itself signals the mode.
export function bannerLines(caps: TermCaps = termCaps()): string[] {
  const testing = isTestMode();
  const otto = testing ? renderSandboxAnsi(caps, 0) : renderOttoAnsi(caps);
  if (otto.length === 0 || caps.columns < 56) return [];
  const text = new Map<number, string>([
    [1, `${accent(glyph("diamond"))} ${accentBold("OpenSwap")}${testing ? ` ${warn(bold("TEST"))}` : ""} ${dim(`v${VERSION}`)}`],
    [2, dim("open-source crosschain swaps")],
    [3, testing ? dim("sandbox — nothing in here is real") : dim("by LeoDex")]
  ]);
  return otto.map((line, i) => `  ${line}   ${text.get(i) ?? ""}`.trimEnd());
}
