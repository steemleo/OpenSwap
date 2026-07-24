import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { pollStatus } from "../../src/core/status.js";
import type { LeoKitApi } from "../../src/core/api.js";
import { renderQr } from "../../src/render/qr.js";
import { forceCaps, stripAnsi } from "../../src/render/theme.js";

// The real relay payment URI shape from a live swap — long enough to produce
// a version-6+ QR, which is what exposed the width-measurement bug.
const RELAY_URI =
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48@1/transfer?address=0x976afd1f75accecbf05f9100bb33e9b0efb29761&uint256=100000000";

afterEach(() => forceCaps(null));

describe("renderQr", () => {
  it("renders a long EIP-681 URI inside 80 columns (ANSI-aware width)", async () => {
    forceCaps({ color: true, depth: "truecolor", unicode: true, isTTY: true, columns: 80 });
    const qr = await renderQr(RELAY_URI);
    expect(qr.ok).toBe(true);
    for (const line of qr.lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
    }
  });
  it("still refuses terminals that are genuinely too narrow", async () => {
    forceCaps({ color: true, depth: "truecolor", unicode: true, isTTY: true, columns: 20 });
    const qr = await renderQr(RELAY_URI);
    expect(qr.ok).toBe(false);
    expect(qr.reason).toBe("too-narrow");
  });
});

describe("pollStatus abort-listener hygiene", () => {
  it("does not accumulate listeners across poll iterations", async () => {
    const api = {
      getStatus: async () => ({ status: "pending" })
    } as unknown as LeoKitApi;
    const abort = new AbortController();
    const running = pollStatus(api, {
      quoteId: "test",
      signal: abort.signal,
      intervalMsStart: 1,
      intervalMsMax: 2,
      timeoutMs: null
    });
    await new Promise((r) => setTimeout(r, 100)); // dozens of iterations
    expect(getEventListeners(abort.signal, "abort").length).toBeLessThanOrEqual(1);
    abort.abort();
    const final = await running;
    expect(final.state).toBe("pending");
  });
});
