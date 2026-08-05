import { describe, expect, it } from "vitest";
import { alternativeCommand, alternativeLabel, enrichNoRoute, findAlternatives } from "../../src/core/alternatives.js";
import { CliError } from "../../src/core/errors.js";
import type { LeoKitApi, QuoteParams } from "../../src/core/api.js";
import type { AssetToken } from "../../src/core/types.js";

function token(identifier: string, symbol: string, blockchain: string, extra: Partial<AssetToken> = {}): AssetToken {
  return {
    identifier,
    blockchain,
    symbol,
    address: null,
    decimals: 8,
    price_usd: 1,
    is_popular: false,
    supports_deposit_address: true,
    ...extra
  };
}

// The pair that produced the user report: native Zcash quotes nothing, the
// Solana wrapper quotes fine, and the CLI used to just say "no route".
const ZEC_NATIVE = token("ZEC.ZEC", "ZEC", "ZEC", { is_popular: true });
const ZEC_SOL = token("SOL.ZEC-a7bdiy", "ZEC", "SOL");
const ZEC_NEAR = token("NEAR.ZEC-zec.omft.near", "ZEC", "NEAR");
const USDC_ETH = token("ETH.USDC-0xa0b8", "USDC", "ETH", { is_popular: true });
const USDC_BASE = token("BASE.USDC-0x8335", "USDC", "BASE");
const TOKENS = [ZEC_NATIVE, ZEC_SOL, ZEC_NEAR, USDC_ETH, USDC_BASE];

function quoteWire(out: string) {
  return {
    quote_id: "q-alt",
    timestamp: "2026-07-29T00:00:00Z",
    quotes: [
      {
        protocol: "rango",
        data: {
          protocol: "rango",
          expected_amount_out: out,
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
      }
    ]
  };
}

// Quotes only the identifiers listed; everything else 404s the way the backend
// does for an unsupported pair. Records what was asked so we can assert the
// probe budget is respected.
function apiThatQuotes(supported: string[]) {
  const asked: Array<{ from: string; to: string }> = [];
  const quote = async (params: QuoteParams) => {
    asked.push({ from: params.from_asset, to: params.to_asset });
    const ok = supported.includes(params.to_asset) || supported.includes(params.from_asset);
    if (!ok) throw new CliError("UPSTREAM", "no quotes", { details: { status: 404 } });
    return quoteWire("300000000");
  };
  const api = { getQuote: quote, getQuoteDeposit: quote } as unknown as LeoKitApi;
  return { api, asked };
}

describe("findAlternatives", () => {
  it("suggests the same coin on a chain that actually routes", async () => {
    const { api } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const alts = await findAlternatives(api, TOKENS, USDC_ETH, ZEC_NATIVE, "100");

    expect(alts.map((a) => a.token.identifier)).toEqual(["SOL.ZEC-a7bdiy"]);
    expect(alts[0]!.side).toBe("to");
    expect(alts[0]!.receiveDisplay).toBeTruthy();
  });

  it("returns nothing rather than suggesting a route that also fails", async () => {
    const { api } = apiThatQuotes([]);
    expect(await findAlternatives(api, TOKENS, USDC_ETH, ZEC_NATIVE, "100")).toEqual([]);
  });

  it("varies the funding side too, so either half of the pair can be the problem", async () => {
    const { api } = apiThatQuotes(["BASE.USDC-0x8335"]);
    const alts = await findAlternatives(api, TOKENS, USDC_ETH, ZEC_NATIVE, "100");

    expect(alts.map((a) => a.token.identifier)).toEqual(["BASE.USDC-0x8335"]);
    expect(alts[0]!.side).toBe("from");
  });

  it("never probes more than the budget — the user is already waiting on a failure", async () => {
    const many = Array.from({ length: 30 }, (_, i) => token(`C${i}.ZEC-x`, "ZEC", `C${i}`));
    const { api, asked } = apiThatQuotes([]);
    await findAlternatives(api, [...TOKENS, ...many], USDC_ETH, ZEC_NATIVE, "100", { max: 4 });

    expect(asked.length).toBeLessThanOrEqual(4);
  });

  it("skips the work entirely when the coin exists on only one chain", async () => {
    const solo = token("XYZ.XYZ", "XYZ", "XYZ");
    const { api, asked } = apiThatQuotes([]);
    const alts = await findAlternatives(api, [solo, ZEC_NATIVE], ZEC_NATIVE, solo, "100");

    expect(alts).toEqual([]);
    // ZEC has no other listing in this token set either, so nothing to probe.
    expect(asked).toEqual([]);
  });

  it("survives an API that throws something unexpected", async () => {
    const api = {
      getQuote: async () => {
        throw new TypeError("socket exploded");
      }
    } as unknown as LeoKitApi;
    await expect(findAlternatives(api, TOKENS, USDC_ETH, ZEC_NATIVE, "100")).resolves.toEqual([]);
  });
});

describe("alternative rendering", () => {
  const alt = { side: "to" as const, token: ZEC_SOL, routes: 2, receiveDisplay: "3.0" };

  it("builds a command the user can paste, preserving the side they did not change", () => {
    expect(alternativeCommand("quote", alt, USDC_ETH, ZEC_NATIVE, "100")).toBe(
      "openswap quote -a 100 -f ETH.USDC-0xa0b8 -t SOL.ZEC-a7bdiy"
    );
  });

  it("swaps the funding side when that is what varied", () => {
    const fromAlt = { side: "from" as const, token: USDC_BASE, routes: 1, receiveDisplay: null };
    expect(alternativeCommand("swap", fromAlt, USDC_ETH, ZEC_NATIVE, "100")).toBe(
      "openswap swap -a 100 -f BASE.USDC-0x8335 -t ZEC.ZEC"
    );
  });

  it("names the chain, which is the whole point of the suggestion", () => {
    expect(alternativeLabel(alt, ZEC_NATIVE)).toContain("ZEC on SOL");
  });

  it("trims float noise the way the rest of the CLI does", () => {
    const noisy = { ...alt, receiveDisplay: "0.21453260498404106" };
    expect(alternativeLabel(noisy, ZEC_NATIVE)).toBe("ZEC on SOL — get 0.2145326 ZEC");
  });

  // The quoted figure is in the DESTINATION asset. Printing it beside a
  // funding-side symbol without a unit would name the wrong currency.
  it("labels a funding-side amount in the destination's symbol", () => {
    const fromAlt = { side: "from" as const, token: USDC_BASE, routes: 1, receiveDisplay: "0.215" };
    expect(alternativeLabel(fromAlt, ZEC_NATIVE)).toBe("pay with USDC on BASE — get 0.215 ZEC");
  });
});

describe("enrichNoRoute", () => {
  const base = (api: LeoKitApi) => ({
    api,
    tokens: TOKENS,
    from: USDC_ETH,
    to: ZEC_NATIVE,
    amount: "100",
    command: "quote" as const
  });

  it("adds runnable suggestions to a NO_ROUTE error", async () => {
    const { api } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const original = new CliError("NO_ROUTE", "No provider quoted this pair.", {
      actions: [{ label: "Search supported assets", command: "openswap assets search" }]
    });

    const out = (await enrichNoRoute(original, base(api))) as CliError;

    expect(out).not.toBe(original);
    expect(out.code).toBe("NO_ROUTE");
    expect(out.exitCode).toBe(original.exitCode);
    expect(out.actions[0]!.command).toContain("SOL.ZEC-a7bdiy");
    // the original guidance survives underneath the new suggestions
    expect(out.actions.at(-1)!.command).toBe("openswap assets search");
    expect((out.details!.alternatives as unknown[]).length).toBe(1);
  });

  it("leaves the error untouched when nothing else routes either", async () => {
    const { api } = apiThatQuotes([]);
    const original = new CliError("NO_ROUTE", "No provider quoted this pair.");
    expect(await enrichNoRoute(original, base(api))).toBe(original);
  });

  it("ignores errors that are not NO_ROUTE, and does not probe", async () => {
    const { api, asked } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const original = new CliError("NETWORK", "connection reset");

    expect(await enrichNoRoute(original, base(api))).toBe(original);
    expect(asked).toEqual([]);
  });

  it("passes non-CliError throwables straight through", async () => {
    const { api } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const boom = new TypeError("something else broke");
    expect(await enrichNoRoute(boom, base(api))).toBe(boom);
  });

  it("always stops the caller's spinner, including when it finds nothing", async () => {
    const { api } = apiThatQuotes([]);
    const events: string[] = [];
    await enrichNoRoute(new CliError("NO_ROUTE", "nope"), {
      ...base(api),
      onStart: () => events.push("start"),
      onDone: (n) => events.push(`done:${n}`)
    });
    expect(events).toEqual(["start", "done:0"]);
  });

  it("does not start a spinner it will never stop for a non-NO_ROUTE error", async () => {
    const { api } = apiThatQuotes([]);
    const events: string[] = [];
    await enrichNoRoute(new CliError("NETWORK", "reset"), {
      ...base(api),
      onStart: () => events.push("start"),
      onDone: (n) => events.push(`done:${n}`)
    });
    expect(events).toEqual([]);
  });

  it("builds swap commands when invoked from swap", async () => {
    const { api } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const out = (await enrichNoRoute(new CliError("NO_ROUTE", "nope"), {
      ...base(api),
      command: "swap"
    })) as CliError;
    expect(out.actions[0]!.command).toMatch(/^openswap swap /);
  });
});

// Real failure: selling ZEC for BASE.USDC. USDC has 25 listings, so queueing
// every destination variant before any source variant spent the whole budget
// on the side that was not broken, and the ZEC variant that routes was never
// tried. Both sides must get budget.
describe("probe budget is shared between both sides", () => {
  const MANY_USDC = Array.from({ length: 24 }, (_, i) =>
    token(`C${i}.USDC-0x${i}`, "USDC", `C${i}`)
  );
  const USDC_BASE_TO = token("BASE.USDC-0x8335", "USDC", "BASE", { is_popular: true });

  it("probes the source side even when the destination has dozens of listings", async () => {
    // only a source variant routes — exactly the ZEC-for-USDC case
    const { api, asked } = apiThatQuotes(["SOL.ZEC-a7bdiy"]);
    const tokens = [ZEC_NATIVE, ZEC_SOL, ZEC_NEAR, USDC_BASE_TO, ...MANY_USDC];

    const alts = await findAlternatives(api, tokens, ZEC_NATIVE, USDC_BASE_TO, "100");

    expect(asked.some((a) => a.from === "SOL.ZEC-a7bdiy")).toBe(true);
    expect(alts.map((a) => a.token.identifier)).toContain("SOL.ZEC-a7bdiy");
  });

  it("still fills the whole budget from one side when the other has no variants", async () => {
    const solo = token("SOLO.SOLO", "SOLO", "SOLO");
    const { api, asked } = apiThatQuotes([]);
    const tokens = [solo, USDC_BASE_TO, ...MANY_USDC];

    await findAlternatives(api, tokens, solo, USDC_BASE_TO, "100", { max: 4 });

    expect(asked.length).toBe(4); // all four spent on the destination side
  });
});

// Real failure: every ZEC listing is popular, but the ONLY one that routes to
// USDC (BSC.ZEC) is the one without deposit-address support. Ranking it last
// meant a quote never reached it. That preference belongs to swap, which can
// only execute deposit routes — not to a read-only quote.
describe("deposit-address preference does not bury working quote routes", () => {
  const ZEC_NEAR_P = token("NEAR.ZEC-zec", "ZEC", "NEAR", { is_popular: true });
  const ZEC_SOL_P = token("SOL.ZEC-a7bdiy", "ZEC", "SOL", { is_popular: true });
  const ZEC_BSC_NODEP = token("BSC.ZEC-0x1ba4", "ZEC", "BSC", {
    is_popular: true,
    supports_deposit_address: false
  });
  // USDC really carries 25 listings, so the destination side competes hard for
  // slots. Without that pressure the bug does not reproduce.
  const CROWD = Array.from({ length: 24 }, (_, i) => token(`C${i}.USDC-0x${i}`, "USDC", `C${i}`));
  const POOL = [ZEC_NATIVE, ZEC_NEAR_P, ZEC_SOL_P, ZEC_BSC_NODEP, USDC_BASE, ...CROWD];

  it("finds a non-deposit route when quoting", async () => {
    const { api } = apiThatQuotes(["BSC.ZEC-0x1ba4"]);
    const alts = await findAlternatives(api, POOL, ZEC_NATIVE, USDC_BASE, "100");
    expect(alts.map((a) => a.token.identifier)).toContain("BSC.ZEC-0x1ba4");
  });

  it("still prefers deposit-capable listings when the caller needs them", async () => {
    const { api, asked } = apiThatQuotes([]);
    await findAlternatives(api, POOL, ZEC_NATIVE, USDC_BASE, "100", {
      depositOnly: true,
      max: 2
    });
    // with only two slots and depositOnly, the non-deposit listing is not worth probing
    expect(asked.some((a) => a.from === "BSC.ZEC-0x1ba4")).toBe(false);
  });
});
