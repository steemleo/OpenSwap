import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isFirstRun } from "../../src/core/paths.js";
import { tourPaymentCardLines } from "../../src/commands/tour.js";
import { stripAnsi } from "../../src/render/theme.js";

const savedEnv = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME };

afterEach(() => {
  if (savedEnv.data === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.data;
  if (savedEnv.config === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.config;
  if (savedEnv.cache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.cache;
});

describe("tour simulated payment card", () => {
  it("never contains anything that looks payable", () => {
    const plain = tourPaymentCardLines("99.73").map(stripAnsi).join("\n");
    expect(plain).not.toMatch(/0x[0-9a-fA-F]{40}/); // no EVM address
    expect(plain).not.toMatch(/\b(bc1|ltc1)[a-z0-9]{20,}/i); // no bech32
    expect(plain.toLowerCase()).toContain("simulated");
    expect(plain).toContain("99.73");
  });
});

describe("isFirstRun", () => {
  it("true on a pristine machine, false once a receipt or config exists", () => {
    const base = mkdtempSync(join(tmpdir(), "openswap-tour-"));
    process.env.XDG_DATA_HOME = join(base, "data");
    process.env.XDG_CONFIG_HOME = join(base, "config");
    process.env.XDG_CACHE_HOME = join(base, "cache");
    expect(isFirstRun()).toBe(true);

    const receipts = join(base, "data", "openswap", "receipts");
    mkdirSync(receipts, { recursive: true });
    expect(isFirstRun()).toBe(true); // empty dir still counts as first run
    writeFileSync(join(receipts, "os_x.json"), "{}");
    expect(isFirstRun()).toBe(false);
  });
});
