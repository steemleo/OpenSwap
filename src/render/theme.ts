import pc from "picocolors";

// LeoKit terminal design language:
//   - one brand accent (amber) used for STRUCTURE only — active step, pointer,
//     rule, wordmark. Never for warnings.
//   - semantic green/red/yellow appear only at moments of meaning.
//   - idle screens are near-monochrome.
// Degradation: truecolor → 256 → 16 → none, honoring NO_COLOR/TERM/--no-color.

export interface TermCaps {
  color: boolean;
  depth: "truecolor" | "256" | "16" | "none";
  unicode: boolean;
  isTTY: boolean;
  columns: number;
}

let forced: Partial<TermCaps> | null = null;

export function forceCaps(caps: Partial<TermCaps> | null): void {
  forced = caps;
}

export function termCaps(): TermCaps {
  const isTTY = process.stdout.isTTY === true;
  const term = process.env.TERM ?? "";
  const noColor =
    process.env.NO_COLOR !== undefined ||
    term === "dumb" ||
    process.argv.includes("--no-color") ||
    !isTTY;
  let depth: TermCaps["depth"] = "none";
  if (!noColor) {
    if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") depth = "truecolor";
    else if (term.includes("256color")) depth = "256";
    else depth = "16";
  }
  const lang = `${process.env.LC_ALL ?? ""}${process.env.LC_CTYPE ?? ""}${process.env.LANG ?? ""}`;
  const unicode = term !== "dumb" && (/utf-?8/i.test(lang) || process.platform === "darwin");
  const caps: TermCaps = {
    color: depth !== "none",
    depth,
    unicode,
    isTTY,
    columns: Math.max(40, process.stdout.columns ?? 80)
  };
  return forced ? { ...caps, ...forced } : caps;
}

const AMBER_TRUE = "\x1b[38;2;245;158;11m";
const AMBER_256 = "\x1b[38;5;214m";
const RESET = "\x1b[39m";

export function accent(s: string): string {
  const caps = termCaps();
  if (!caps.color) return s;
  if (caps.depth === "truecolor") return `${AMBER_TRUE}${s}${RESET}`;
  if (caps.depth === "256") return `${AMBER_256}${s}${RESET}`;
  return pc.yellow(s);
}

export function accentBold(s: string): string {
  return termCaps().color ? pc.bold(accent(s)) : s;
}

export function ok(s: string): string {
  return termCaps().color ? pc.green(s) : s;
}

export function bad(s: string): string {
  return termCaps().color ? pc.red(s) : s;
}

export function warn(s: string): string {
  return termCaps().color ? pc.yellow(s) : s;
}

export function dim(s: string): string {
  return termCaps().color ? pc.dim(s) : s;
}

export function bold(s: string): string {
  return termCaps().color ? pc.bold(s) : s;
}

export function inverse(s: string): string {
  return termCaps().color ? pc.inverse(s) : s;
}

// Glyph set with ASCII fallbacks — meaning never depends on the glyph alone.
const GLYPHS = {
  diamond: ["◆", "#"],
  diamondOpen: ["◇", "o"],
  rail: ["│", "|"],
  pointer: ["❯", ">"],
  dotFilled: ["●", "*"],
  dotOpen: ["○", "o"],
  check: ["✓", "+"],
  cross: ["✗", "x"],
  caution: ["▲", "!"],
  rule: ["─", "-"],
  boxTL: ["╭", "+"],
  boxTR: ["╮", "+"],
  boxBL: ["╰", "+"],
  boxBR: ["╯", "+"],
  boxV: ["│", "|"],
  boxH: ["─", "-"],
  middot: ["·", "."],
  arrow: ["→", "->"]
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName): string {
  return GLYPHS[name][termCaps().unicode ? 0 : 1];
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}
