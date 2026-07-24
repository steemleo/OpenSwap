import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ottoData from "../../brand/otto.pixels.json";
import { ottoAnsi, ottoPng, ottoSvg } from "../../scripts/gen-brand.mjs";
import { bannerLines, nearest256, renderOttoAnsi } from "../../src/render/otto.js";
import { stripAnsi, type TermCaps } from "../../src/render/theme.js";

const BRAND = join(__dirname, "..", "..", "brand");

function caps(over: Partial<TermCaps> = {}): TermCaps {
  return { color: true, depth: "truecolor", unicode: true, isTTY: true, columns: 80, ...over };
}

describe("otto pixel source", () => {
  it("is a 12x12 grid of palette keys", () => {
    expect(ottoData.grid).toHaveLength(12);
    for (const row of ottoData.grid) {
      expect(row).toHaveLength(12);
      for (const ch of row) {
        expect(ch === "." || ch in ottoData.palette).toBe(true);
      }
    }
  });
  it("palette is #RRGGBB and includes the amber brand accent", () => {
    for (const hex of Object.values(ottoData.palette)) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(ottoData.palette.A).toBe("#F59E0B");
    expect(ottoData.grid.join("")).toContain("A");
  });
});

describe("renderOttoAnsi", () => {
  it("renders 6 half-block rows in truecolor", () => {
    const lines = renderOttoAnsi(caps());
    expect(lines).toHaveLength(6);
    const joined = lines.join("\n");
    expect(joined).toContain("▀");
    expect(joined).toContain("▄");
    expect(joined).toContain("38;2;245;158;11"); // amber diamond
    for (const line of lines) {
      expect(stripAnsi(line)).toHaveLength(12); // every row is exactly sprite-width
    }
  });
  it("falls back to 256-color codes without truecolor", () => {
    const joined = renderOttoAnsi(caps({ depth: "256" })).join("\n");
    expect(joined).toContain("38;5;");
    expect(joined).not.toContain("38;2;");
  });
  it("steps aside on degraded terminals", () => {
    expect(renderOttoAnsi(caps({ color: false, depth: "none" }))).toEqual([]);
    expect(renderOttoAnsi(caps({ unicode: false }))).toEqual([]);
    expect(renderOttoAnsi(caps({ depth: "16" }))).toEqual([]);
  });
  it("matches the committed brand/otto.ansi.txt byte for byte", () => {
    const file = readFileSync(join(BRAND, "otto.ansi.txt"), "utf8");
    expect(`${renderOttoAnsi(caps()).join("\n")}\n`).toBe(file);
  });
});

describe("nearest256", () => {
  it("maps anchors to their xterm codes", () => {
    expect(nearest256([0, 0, 0])).toBe(16);
    expect(nearest256([255, 255, 255])).toBe(231);
    expect(nearest256([245, 158, 11])).toBe(214); // same amber the theme uses
  });
});

describe("bannerLines", () => {
  it("composes otto beside the wordmark", () => {
    const lines = bannerLines(caps());
    expect(lines).toHaveLength(6);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("OpenSwap");
    expect(plain).toContain("v0.");
    expect(plain).toContain("by LeoDex");
  });
  it("yields to the text header when the terminal can't do otto justice", () => {
    expect(bannerLines(caps({ columns: 45 }))).toEqual([]);
    expect(bannerLines(caps({ color: false, depth: "none", isTTY: false }))).toEqual([]);
    expect(bannerLines(caps({ unicode: false }))).toEqual([]);
  });
  it("never leaks escape codes into a line's visible width", () => {
    for (const line of bannerLines(caps())) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
    }
  });
});

describe("gen-brand pipeline stays in lockstep with the runtime", () => {
  it("script ANSI === runtime ANSI === committed file", () => {
    expect(ottoAnsi()).toBe(`${renderOttoAnsi(caps()).join("\n")}\n`);
  });
  it("committed otto.svg is fresh", () => {
    expect(ottoSvg()).toBe(readFileSync(join(BRAND, "otto.svg"), "utf8"));
  });
  it("committed PNGs are fresh and deterministic", () => {
    const bytes = ottoPng(64);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.equals(readFileSync(join(BRAND, "png", "otto-64.png")))).toBe(true);
    expect(bytes.equals(ottoPng(64))).toBe(true);
  });
});
