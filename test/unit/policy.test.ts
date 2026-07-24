import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy, type PolicyV1 } from "../../src/core/policy.js";
import { logFlight } from "../../src/core/flightlog.js";
import type { RouteOffer } from "../../src/core/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "leokit-test-"));
  process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function offer(overrides: Partial<RouteOffer> = {}): RouteOffer {
  return {
    protocol: "chainflip",
    variant: null,
    expectedOutBase: "154624",
    expectedOutDisplay: "0.00154624",
    expectedOutUsd: 98.88,
    inputUsd: 100,
    outDecimals: 8,
    inDecimals: 6,
    feesTotalUsd: 1.13,
    feesComplete: true,
    fees: [],
    etaSeconds: 400,
    expiresAt: NOW + 25000,
    ttlSeconds: 30,
    route: [],
    supportsDepositAddress: true,
    minInputDisplay: null,
    recommendedSlippageBps: null,
    flags: { bestOutput: true, fastest: false, cheapest: false },
    raw: {} as RouteOffer["raw"],
    ...overrides
  };
}

function policy(overrides: Partial<PolicyV1["limits"]> = {}): PolicyV1 {
  return {
    version: 1,
    name: "test",
    mode: "enforce",
    assets: { allow_from: ["ARB.USDC-0xabc"], allow_to: ["BTC.BTC"] },
    protocols: { allow: ["chainflip"] },
    destinations: { allow: ["bc1qtest"] },
    limits: {
      max_trade_usd: 250,
      max_daily_volume_usd: 1000,
      max_quote_age_seconds: 20,
      cooldown_seconds: 30,
      ...overrides
    }
  };
}

const proposal = {
  fromAsset: "ARB.USDC-0xabc",
  toAsset: "BTC.BTC",
  amountDisplay: "100",
  inputUsd: 100,
  toAddress: "bc1qtest",
  now: NOW
};

describe("evaluatePolicy", () => {
  it("allows a compliant trade", () => {
    const v = evaluatePolicy(policy(), { ...proposal, offer: offer() });
    expect(v.allowed).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it("rejects disallowed assets, protocols, destinations", () => {
    const v = evaluatePolicy(policy(), {
      ...proposal,
      fromAsset: "ETH.ETH",
      toAddress: "bc1qother",
      offer: offer({ protocol: "rango" })
    });
    expect(v.allowed).toBe(false);
    expect(v.violations.join(" ")).toMatch(/allow_from/);
    expect(v.violations.join(" ")).toMatch(/protocols.allow/);
    expect(v.violations.join(" ")).toMatch(/destinations.allow/);
  });

  it("rejects over max_trade_usd and unknown USD value", () => {
    expect(evaluatePolicy(policy(), { ...proposal, inputUsd: 300, offer: offer({ inputUsd: 300 }) }).violations.join(" ")).toMatch(/max_trade_usd/);
    expect(evaluatePolicy(policy(), { ...proposal, inputUsd: null, offer: offer() }).violations.join(" ")).toMatch(/unknown/);
  });

  it("enforces daily volume and cooldown from the flight log", () => {
    logFlight({ type: "trade_executed", usd: 950 });
    const v = evaluatePolicy(policy(), { ...proposal, now: Date.now(), offer: offer({ expiresAt: Date.now() + 25000 }) });
    expect(v.violations.join(" ")).toMatch(/max_daily_volume_usd/);
    expect(v.violations.join(" ")).toMatch(/cooldown/);
  });

  it("rejects expired quotes and unpriced fees when fee limits exist", () => {
    expect(
      evaluatePolicy(policy(), { ...proposal, offer: offer({ expiresAt: NOW - 1 }) }).violations.join(" ")
    ).toMatch(/expired/);
    expect(
      evaluatePolicy(policy({ max_total_fee_usd: 5 }), { ...proposal, offer: offer({ feesTotalUsd: null }) }).violations.join(" ")
    ).toMatch(/not fully priced/);
    expect(
      evaluatePolicy(policy({ max_total_fee_usd: 0.5 }), { ...proposal, offer: offer() }).violations.join(" ")
    ).toMatch(/max_total_fee_usd/);
  });

  it("engages the kill switch", () => {
    const stopFile = join(tempDir, "STOP");
    writeFileSync(stopFile, "");
    const p: PolicyV1 = { ...policy(), kill_switch_file: stopFile };
    expect(evaluatePolicy(p, { ...proposal, offer: offer() }).violations.join(" ")).toMatch(/kill switch/);
  });
});
