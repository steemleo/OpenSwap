import { afterEach, describe, expect, it } from "vitest";
import { validateEvmPlan } from "../../src/core/signer/evm.js";

const OPTS = { expectedChainId: 42161, chainLabel: "ARB", maxValueBaseUnits: 1_000_000_000_000_000_000n };
const APPROVE = { to: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", data: "0x095ea7b3", value: "0" };

describe("validateEvmPlan", () => {
  it("accepts a well-formed approval + swap plan", () => {
    expect(() =>
      validateEvmPlan([APPROVE, { to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", value: "0" }], OPTS)
    ).not.toThrow();
  });
  it("refuses an invalid target address", () => {
    expect(() => validateEvmPlan([{ to: "not-an-address" }], OPTS)).toThrow(/invalid target/);
    expect(() => validateEvmPlan([{ to: "" }], OPTS)).toThrow(/invalid target/);
  });
  it("refuses a chain-id mismatch", () => {
    expect(() => validateEvmPlan([{ ...APPROVE, chainId: 1 }], OPTS)).toThrow(/Refusing to sign/);
  });
  it("refuses a plan whose total value exceeds the approved ceiling", () => {
    expect(() =>
      validateEvmPlan(
        [
          { to: APPROVE.to, value: "600000000000000000" },
          { to: APPROVE.to, value: "600000000000000000" }
        ],
        OPTS
      )
    ).toThrow(/exceeds the approved amount/);
  });
  it("handles hex values", () => {
    expect(() => validateEvmPlan([{ to: APPROVE.to, value: "0x0de0b6b3a7640000" }], OPTS)).not.toThrow(); // exactly 1e18
    expect(() => validateEvmPlan([{ to: APPROVE.to, value: "0x0de0b6b3a7640001" }], OPTS)).toThrow();
  });
});

// The signing lane ships OFF while validateEvmPlan still accepts arbitrary
// backend calldata, writes its receipt after broadcast, and takes no
// idempotency reservation. This test is the tripwire: deleting the gate
// without hardening the lane should break the build.
describe("signer lane release gate", () => {
  const saved = { test: process.env.OPENSWAP_TEST_MODE, enable: process.env.OPENSWAP_ENABLE_SIGNER };
  afterEach(() => {
    for (const [k, v] of [["OPENSWAP_TEST_MODE", saved.test], ["OPENSWAP_ENABLE_SIGNER", saved.enable]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is off by default outside test mode", async () => {
    delete process.env.OPENSWAP_TEST_MODE;
    delete process.env.OPENSWAP_ENABLE_SIGNER;
    process.env.OPENSWAP_TEST_MODE = "0";
    const { signerLaneEnabled } = await import("../../src/core/chains.js");
    expect(signerLaneEnabled()).toBe(false);
  });

  it("opens only for an explicit opt-in", async () => {
    process.env.OPENSWAP_TEST_MODE = "0";
    process.env.OPENSWAP_ENABLE_SIGNER = "1";
    const { signerLaneEnabled } = await import("../../src/core/chains.js");
    expect(signerLaneEnabled()).toBe(true);
  });

  it("stays open in test mode, where no real funds can move", async () => {
    process.env.OPENSWAP_TEST_MODE = "1";
    delete process.env.OPENSWAP_ENABLE_SIGNER;
    const { signerLaneEnabled } = await import("../../src/core/chains.js");
    expect(signerLaneEnabled()).toBe(true);
  });
});
