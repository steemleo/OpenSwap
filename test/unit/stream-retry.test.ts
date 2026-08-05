import { describe, expect, it } from "vitest";
import { streamQuoteSet } from "../../src/core/quotes.js";
import { CliError } from "../../src/core/errors.js";
import type { LeoKitApi } from "../../src/core/api.js";

// A quote stream is read-only, so a transient failure before anything arrived
// deserves one silent retry — the one-shot request path already retries, and
// without this a single connection blip reported "no routes" for a pair that
// quotes fine a second later (seen live: ETH.ETH -> ZEC.ZEC).

const QUOTE_EVENT = {
  type: "quote",
  protocol: "rango",
  data: {
    protocol: "rango",
    expected_amount_out: "300000000",
    expected_amount_out_usd: 99,
    input_amount_usd: 100,
    expires_at: 0,
    ttl_seconds: 30,
    total_swap_seconds: 60,
    out_asset_decimal: 8,
    in_asset_decimal: 6,
    fees: [],
    route: []
  }
};
const INIT_EVENT = { type: "init", quote_id: "11111111-2222-3333-4444-555555555555", timestamp: "2026-08-04T00:00:00Z" };

// Each attempt consumes the next script entry: an Error throws before any
// event; an array yields its events then ends the stream cleanly.
function apiWithScript(script: Array<Error | Record<string, unknown>[]>) {
  let attempts = 0;
  const api = {
    async *streamQuotes() {
      const step = script[Math.min(attempts++, script.length - 1)]!;
      if (step instanceof Error) throw step;
      for (const e of step) yield e;
    }
  } as unknown as LeoKitApi;
  return { api, attempts: () => attempts };
}

const PARAMS = { from_asset: "ETH.ETH", to_asset: "ZEC.ZEC", amount: "25" };
const netErr = () => new CliError("NETWORK", "Could not reach the LeoKit API.", { retryable: true });

describe("streamQuoteSet retries one transient failure", () => {
  it("recovers when the second attempt succeeds, and says so", async () => {
    const { api, attempts } = apiWithScript([netErr(), [INIT_EVENT, QUOTE_EVENT]]);
    const retries: number[] = [];
    const set = await streamQuoteSet(api, PARAMS, { onRetry: () => retries.push(1) });

    expect(set.offers.map((o) => o.protocol)).toEqual(["rango"]);
    expect(set.quoteId).toBe("11111111-2222-3333-4444-555555555555");
    expect(attempts()).toBe(2);
    expect(retries).toEqual([1]);
  });

  it("gives up after the one retry — two failures is a real outage", async () => {
    const { api, attempts } = apiWithScript([netErr(), netErr()]);
    await expect(streamQuoteSet(api, PARAMS)).rejects.toMatchObject({ code: "NETWORK" });
    expect(attempts()).toBe(2);
  });

  it("does not retry a non-retryable failure", async () => {
    const { api, attempts } = apiWithScript([new CliError("VALIDATION", "bad amount"), [INIT_EVENT, QUOTE_EVENT]]);
    await expect(streamQuoteSet(api, PARAMS)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(attempts()).toBe(1);
  });

  it("does not retry once the round has started — a second round would swap the quote_id", async () => {
    let attempts = 0;
    const api = {
      async *streamQuotes() {
        attempts++;
        yield INIT_EVENT;
        throw netErr();
      }
    } as unknown as LeoKitApi;
    await expect(streamQuoteSet(api, PARAMS)).rejects.toMatchObject({ code: "NETWORK" });
    expect(attempts).toBe(1);
  });

  it("still maps a 404 to NO_ROUTE without retrying", async () => {
    const { api, attempts } = apiWithScript([
      new CliError("UPSTREAM", "no quotes", { details: { status: 404 } }),
      [INIT_EVENT, QUOTE_EVENT]
    ]);
    await expect(streamQuoteSet(api, PARAMS)).rejects.toMatchObject({ code: "NO_ROUTE" });
    expect(attempts()).toBe(1);
  });
});
