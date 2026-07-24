import { describe, expect, it } from "vitest";
import { finalStateBlock, stateSteps } from "../../src/commands/status-render.js";
import { stripAnsi } from "../../src/render/theme.js";
import type { NormalizedStatus } from "../../src/core/types.js";

const status = (over: Partial<NormalizedStatus>): NormalizedStatus =>
  ({
    state: "failed", protocol: "relay", inAmount: null, outAmount: null,
    destTxHash: null, refundTxHash: null, error: null, scannerUrl: null, nativeScannerUrl: null,
    ...over
  }) as NormalizedStatus;

describe("stateSteps", () => {
  // The watch view is seeded with "pending" the instant a deposit address is
  // shown, and the backend also reports "pending" before payment. Labelling it
  // "Deposit detected on the source chain" claimed we had seen money the user
  // had not sent yet.
  it("does not claim a deposit was detected while still waiting for one", () => {
    const steps = stateSteps("pending");
    const active = steps.find((s) => s.state === "active")!;
    expect(active.label).toBe("Waiting for your deposit");
    expect(steps.map((s) => s.label).join(" ")).not.toMatch(/detected/i);
  });

  it("says the deposit was received once a later state proves it", () => {
    for (const s of ["confirming", "swapping", "sending", "success"] as const) {
      const first = stateSteps(s)[0]!;
      expect(first.label, s).toBe("Deposit received");
      expect(first.state, s).toBe("done");
    }
  });

  it("marks the deposit received on terminal failure paths", () => {
    for (const s of ["failed", "refunded"] as const) {
      expect(stateSteps(s)[0]!.label, s).toBe("Deposit received");
    }
  });
});

describe("finalStateBlock — a failed swap says where the money went", () => {
  const REFUND = "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2";

  it("names the refund destination when we know it", () => {
    const out = stripAnsi(finalStateBlock(status({ state: "failed" }), "os_x", "USDC", REFUND));
    expect(out).toMatch(/refunded by the protocol/i);
    expect(out).toContain(REFUND);
  });

  it("still states the disposition when the refund address is unknown", () => {
    const out = stripAnsi(finalStateBlock(status({ state: "failed" }), "os_x", "USDC", null));
    expect(out).toMatch(/refunded by the protocol/i);
    expect(out).toMatch(/wallet you paid from/i);
  });

  it("leads with keep-watching, not with contacting support", () => {
    const out = stripAnsi(finalStateBlock(status({ state: "failed" }), "os_x", "USDC", REFUND));
    const watchAt = out.indexOf("--watch");
    const feedbackAt = out.indexOf("feedback");
    expect(watchAt).toBeGreaterThan(-1);
    expect(watchAt).toBeLessThan(feedbackAt);
  });

  it("leaves the success path alone", () => {
    const out = stripAnsi(finalStateBlock(status({ state: "success", outAmount: "24.9" }), "os_x", "USDC", REFUND));
    expect(out).toMatch(/Swap complete/);
    expect(out).not.toMatch(/refunded/i);
  });
});
