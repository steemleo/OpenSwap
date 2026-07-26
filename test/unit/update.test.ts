import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNewer, pendingUpdateNotice, refreshUpdateCache } from "../../src/core/update.js";
import { cacheDir, ensureDir } from "../../src/core/paths.js";
import { VERSION } from "../../src/version.js";

const saved = { cache: process.env.XDG_CACHE_HOME, off: process.env.OPENSWAP_NO_UPDATE_CHECK, test: process.env.OPENSWAP_TEST_MODE };

beforeEach(() => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "openswap-update-"));
  delete process.env.OPENSWAP_NO_UPDATE_CHECK;
  process.env.OPENSWAP_TEST_MODE = "0";
});
afterEach(() => {
  for (const [k, v] of [["XDG_CACHE_HOME", saved.cache], ["OPENSWAP_NO_UPDATE_CHECK", saved.off], ["OPENSWAP_TEST_MODE", saved.test]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const seed = (latest: string | null, checked_at = Date.now()): void => {
  ensureDir(cacheDir());
  writeFileSync(join(cacheDir(), "update-check.json"), JSON.stringify({ latest, checked_at }));
};

describe("isNewer", () => {
  it("orders releases correctly", () => {
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });
  it("compares numerically, not lexically", () => {
    // the classic bug: "0.1.10" < "0.1.9" as strings
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("2.0.0", "10.0.0")).toBe(false);
  });
  it("treats a prerelease as older than its release", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });
  it("refuses to guess on malformed input", () => {
    for (const junk of ["", "latest", "1.0", "1.0.0.0", "abc", "-1.0.0"]) {
      expect(isNewer(junk, "0.1.0"), junk).toBe(false);
    }
  });
});

describe("pendingUpdateNotice", () => {
  it("is silent with no cache", () => {
    expect(pendingUpdateNotice()).toBeNull();
  });
  it("is silent when current", () => {
    seed(VERSION);
    expect(pendingUpdateNotice()).toBeNull();
  });
  it("names the version and the @latest command when behind", () => {
    seed("99.0.0");
    const n = pendingUpdateNotice();
    expect(n).toContain("99.0.0");
    expect(n).toContain(VERSION);
    // @latest is the whole point — bare `npx openswap` would serve the stale
    // cached build forever
    expect(n).toContain("npx openswap@latest");
  });
  it("honours the opt-out", () => {
    seed("99.0.0");
    process.env.OPENSWAP_NO_UPDATE_CHECK = "1";
    expect(pendingUpdateNotice()).toBeNull();
  });
  it("survives a corrupt cache file", () => {
    ensureDir(cacheDir());
    writeFileSync(join(cacheDir(), "update-check.json"), "{not json");
    expect(() => pendingUpdateNotice()).not.toThrow();
    expect(pendingUpdateNotice()).toBeNull();
  });
});

describe("refreshUpdateCache", () => {
  it("stamps the attempt before the request, so a dead network cannot refetch every run", () => {
    seed(null, 0);
    refreshUpdateCache();
    const after = JSON.parse(readFileSync(join(cacheDir(), "update-check.json"), "utf8")) as { checked_at: number };
    expect(after.checked_at).toBeGreaterThan(0);
  });
  it("does not re-check inside the interval", () => {
    const stamp = Date.now();
    seed("99.0.0", stamp);
    refreshUpdateCache();
    const after = JSON.parse(readFileSync(join(cacheDir(), "update-check.json"), "utf8")) as { checked_at: number };
    expect(after.checked_at).toBe(stamp);
  });
  it("never throws", () => {
    expect(() => refreshUpdateCache()).not.toThrow();
  });
});
