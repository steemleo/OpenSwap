import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeStatus, pollStatus, statusImplausibilities } from "../../src/core/status.js";
import type { LeoKitApi } from "../../src/core/api.js";
import type { NormalizedStatus } from "../../src/core/types.js";

// A status source can serve a wrong or stale row: terminal "success" moments
// after the deposit address was minted, no destination transaction, and a
// "received" amount that is not this swap's outcome (classic shape: a raw
// base-unit value, 10^decimals times the quote). The CLI validates every
// terminal claim against the swap's own receipt before endorsing it.

const savedTestMode = process.env.OPENSWAP_TEST_MODE;
beforeEach(() => {
  delete process.env.OPENSWAP_TEST_MODE; // the time signal is live outside test mode
});
afterEach(() => {
  if (savedTestMode === undefined) delete process.env.OPENSWAP_TEST_MODE;
  else process.env.OPENSWAP_TEST_MODE = savedTestMode;
});

function success(over: Partial<NormalizedStatus> = {}): NormalizedStatus {
  return normalizeStatus({
    status: "success",
    out_amount: "55100.12",
    dest_tx_hash: "0xdeadbeef",
    ...over
  } as never);
}

const EXP = { expectedOutDisplay: "55123.42", createdAt: Date.now() - 20 * 60_000 };

describe("statusImplausibilities — uncorroborated claims are caught", () => {
  it("flags a success with no hash, a wild amount, seconds after creation", () => {
    const s = normalizeStatus({ status: "success", out_amount: "123456789012345678" } as never);
    const flags = statusImplausibilities(s, { expectedOutDisplay: "55123.42", createdAt: Date.now() - 500 });
    const codes = flags.map((f) => f.code);
    expect(codes).toContain("SUCCESS_WITHOUT_DEST_TX");
    expect(codes).toContain("OUT_AMOUNT_FAR_FROM_QUOTE");
    expect(codes).toContain("SUCCESS_TOO_SOON");
  });

  it("fingerprints an unconverted base-unit amount: ratio is an exact power of ten", () => {
    // an 18-decimals asset reported raw: base units / display = 10^18
    const s = normalizeStatus({ status: "success", out_amount: "123456789012345678", dest_tx_hash: "0xabc" } as never);
    const flags = statusImplausibilities(s, { ...EXP, expectedOutDisplay: "0.123456789012345678" });
    expect(flags.map((f) => f.code)).toContain("OUT_AMOUNT_LOOKS_LIKE_BASE_UNITS");
  });
});

describe("statusImplausibilities — honest successes pass untouched", () => {
  it("accepts a corroborated success near the quote", () => {
    expect(statusImplausibilities(success(), EXP)).toEqual([]);
  });

  it("tolerates real slippage — a fill 20% under quote is not an anomaly", () => {
    expect(statusImplausibilities(success({ out_amount: "44098.74" } as never), EXP)).toEqual([]);
  });

  it("never inspects non-success states", () => {
    const s = normalizeStatus({ status: "swapping" } as never);
    expect(statusImplausibilities(s, EXP)).toEqual([]);
  });

  it("stays silent when it has nothing to compare against", () => {
    expect(statusImplausibilities(normalizeStatus({ status: "success", dest_tx_hash: "0xabc" } as never), {
      expectedOutDisplay: null,
      createdAt: null
    })).toEqual([]);
  });
});

describe("pollStatus distrusts an implausible terminal", () => {
  const wire = { status: "success", out_amount: "123456789012345678" };
  function apiReturning(responses: Array<Record<string, unknown>>) {
    let calls = 0;
    const api = {
      getStatus: async () => responses[Math.min(calls++, responses.length - 1)]
    } as unknown as LeoKitApi;
    return { api, calls: () => calls };
  }

  it("keeps polling past a flagged success instead of stopping on poll one", async () => {
    const { api, calls } = apiReturning([wire]);
    const final = await pollStatus(api, {
      quoteId: "q",
      intervalMsStart: 1,
      intervalMsMax: 2,
      expectation: { expectedOutDisplay: "55123.42", createdAt: Date.now() - 500 }
    });
    expect(calls()).toBeGreaterThan(1); // an unguarded poll returned after ONE call
    expect(final.state).toBe("success");
    expect(final.implausible!.length).toBeGreaterThan(0);
  });

  it("returns immediately when the terminal is corroborated", async () => {
    const { api, calls } = apiReturning([{ status: "success", out_amount: "55100", dest_tx_hash: "0xabc" }]);
    const final = await pollStatus(api, {
      quoteId: "q",
      intervalMsStart: 1,
      expectation: EXP
    });
    expect(calls()).toBe(1);
    expect(final.implausible).toEqual([]);
  });

  it("recovers when the source corrects itself mid-distrust", async () => {
    const { api } = apiReturning([wire, wire, { status: "success", out_amount: "55100", dest_tx_hash: "0xabc" }]);
    const final = await pollStatus(api, {
      quoteId: "q",
      intervalMsStart: 1,
      expectation: EXP
    });
    expect(final.implausible).toEqual([]);
    expect(final.destTxHash).toBe("0xabc");
  });

  it("does not flag anything when no expectation is provided", async () => {
    const { api, calls } = apiReturning([wire]);
    const final = await pollStatus(api, { quoteId: "q", intervalMsStart: 1 });
    expect(calls()).toBe(1);
    expect(final.implausible).toEqual([]);
  });
});
