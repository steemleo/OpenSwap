import { describe, expect, it } from "vitest";
import { chainRank, resolveAsset, searchAssets } from "../../src/core/assets.js";
import type { AssetToken } from "../../src/core/types.js";

function tok(overrides: Partial<AssetToken>): AssetToken {
  return {
    identifier: "ETH.ETH",
    blockchain: "ETH",
    symbol: "ETH",
    address: null,
    decimals: 18,
    price_usd: 1,
    is_popular: true,
    supports_deposit_address: true,
    ...overrides
  };
}

const TOKENS: AssetToken[] = [
  tok({ identifier: "BASE.USDC-0x8335", blockchain: "BASE", symbol: "USDC", address: "0x8335" }),
  tok({ identifier: "APTOS.USDC-0xbae2", blockchain: "APTOS", symbol: "USDC", address: "0xbae2" }),
  tok({ identifier: "ETH.USDC-0xa0b8", blockchain: "ETH", symbol: "USDC", address: "0xa0b8" }),
  tok({ identifier: "KUJI.USDC-0xdead", blockchain: "KUJI", symbol: "USDC", address: "0xdead", is_popular: false }),
  tok({ identifier: "BTC.BTC", blockchain: "BTC", symbol: "BTC" }),
  tok({ identifier: "SOL.USDC-0x5555", blockchain: "SOL", symbol: "USDC", address: "0x5555" })
];

describe("natural-language + flexible asset grammar", () => {
  it('resolves "usdc on base"', () => {
    const res = resolveAsset(TOKENS, "usdc on base");
    expect("token" in res && res.token.identifier).toBe("BASE.USDC-0x8335");
  });
  it('resolves "USDC ON ETH" case-insensitively', () => {
    const res = resolveAsset(TOKENS, "USDC ON ETH");
    expect("token" in res && res.token.identifier).toBe("ETH.USDC-0xa0b8");
  });
  it('resolves dotted lowercase "base.usdc"', () => {
    const res = resolveAsset(TOKENS, "base.usdc");
    expect("token" in res && res.token.identifier).toBe("BASE.USDC-0x8335");
  });
  it('resolves space-separated "base usdc" (chain first)', () => {
    const res = resolveAsset(TOKENS, "base usdc");
    expect("token" in res && res.token.identifier).toBe("BASE.USDC-0x8335");
  });
  it('resolves space-separated "usdc base" (symbol first)', () => {
    const res = resolveAsset(TOKENS, "usdc base");
    expect("token" in res && res.token.identifier).toBe("BASE.USDC-0x8335");
  });
  it('space form still fails cleanly for nonsense', () => {
    expect(() => resolveAsset(TOKENS, "purple monkey")).toThrow();
  });
  it('resolves "base:USDC" and full identifiers', () => {
    expect("token" in resolveAsset(TOKENS, "base:USDC")).toBe(true);
    const exact = resolveAsset(TOKENS, "BASE.USDC-0x8335");
    expect("token" in exact && exact.exact).toBe(true);
  });
});

describe("chain-ranked ordering", () => {
  it("ranks top chains ahead of long-tail chains", () => {
    expect(chainRank("ETH")).toBeLessThan(chainRank("APTOS"));
    expect(chainRank("BASE")).toBeLessThan(chainRank("KUJI"));
    expect(chainRank("UNKNOWNCHAIN")).toBeGreaterThan(chainRank("APTOS"));
  });
  it("ambiguity candidates lead with top chains, unpopular last", () => {
    const res = resolveAsset(TOKENS, "USDC");
    if (!("ambiguous" in res)) throw new Error("expected ambiguity");
    const order = res.candidates.map((c) => c.blockchain);
    expect(order[0]).toBe("ETH");
    expect(order[1]).toBe("SOL");
    expect(order[2]).toBe("BASE");
    expect(order[order.length - 1]).toBe("KUJI"); // not popular → last
  });
  it("search uses chain rank as tiebreak", () => {
    const results = searchAssets(TOKENS, "usdc", 10);
    expect(results[0]!.blockchain).toBe("ETH");
    expect(results.map((r) => r.blockchain)).not.toContain("BOGUS");
  });
});
