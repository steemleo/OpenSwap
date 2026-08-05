import { describe, expect, it } from "vitest";
import { chainRank, resolveAsset, searchAssets } from "../../src/core/assets.js";
import { CliError } from "../../src/core/errors.js";
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

// A user who types a chain that does not carry the coin gets the same NO_ROUTE
// as a user who typed nonsense, even though the answer is sitting in the local
// token list. Name the chains that do carry it.
describe("wrong-chain asset resolution names the chains that do have it", () => {
  it("suggests the chains carrying the symbol", () => {
    try {
      resolveAsset(TOKENS, "BTC.USDC");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      const e = err as CliError;
      expect(e.code).toBe("NO_ROUTE");
      expect(e.message).toContain("USDC");
      const commands = e.actions.map((a) => a.command ?? "").join(" ");
      expect(commands).toContain("BASE.USDC-0x8335");
      // ranked: popular + deposit-capable first, and never more than a handful
      expect(e.actions.length).toBeLessThanOrEqual(5);
    }
  });

  it("falls back to plain search when the symbol exists nowhere", () => {
    try {
      resolveAsset(TOKENS, "ETH.NOTACOIN");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      const e = err as CliError;
      expect(e.code).toBe("NO_ROUTE");
      expect(e.actions.every((a) => (a.command ?? "").startsWith("openswap assets search"))).toBe(true);
    }
  });
});

// Two contracts for one symbol on one chain produced "available on ETH, ETH"
// and two indistinguishable choices. One row per chain, best listing wins.
describe("wrong-chain suggestions are one per chain", () => {
  const DUPES: AssetToken[] = [
    tok({ identifier: "ETH.DOT-0x196c", blockchain: "ETH", symbol: "DOT", address: "0x196c", is_popular: false }),
    tok({ identifier: "ETH.DOT-0x8d01", blockchain: "ETH", symbol: "DOT", address: "0x8d01", is_popular: true }),
    tok({ identifier: "BSC.DOT-0x7083", blockchain: "BSC", symbol: "DOT", address: "0x7083" })
  ];

  it("never names the same chain twice", () => {
    try {
      resolveAsset(DUPES, "DOT.DOT");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      const e = err as CliError;
      expect(e.message).toContain("ETH, BSC");
      const chains = e.actions.filter((a) => a.label.startsWith("Use ")).map((a) => a.label);
      expect(chains).toEqual(["Use DOT on ETH", "Use DOT on BSC"]);
    }
  });

  it("keeps the best-ranked listing for the chain it collapses", () => {
    try {
      resolveAsset(DUPES, "DOT.DOT");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      const e = err as CliError;
      expect(e.actions[0]!.command).toBe("ETH.DOT-0x8d01"); // the popular one
    }
  });
});

// Interactive recovery reads the machine-readable answer off the error rather
// than re-deriving it from the typed string, which for "usdc on btc" would
// search the whole phrase and find nothing.
describe("NO_ROUTE errors carry structured details for recovery", () => {
  it("wrong chain: names the working listings and the symbol that was meant", () => {
    try {
      resolveAsset(TOKENS, "BTC.USDC");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      const e = err as CliError;
      expect(e.details!.symbol_query).toBe("USDC");
      expect(e.details!.available_elsewhere).toContain("BASE.USDC-0x8335");
    }
  });

  it("unknown symbol: still carries what to search for", () => {
    try {
      resolveAsset(TOKENS, "NOTACOIN");
      throw new Error("expected resolveAsset to throw");
    } catch (err) {
      expect((err as CliError).details!.symbol_query).toBe("NOTACOIN");
    }
  });
});

// "USCD" used to return zero results and read as "unsupported" when the coin
// was one keystroke away. The fallback fires only when nothing matched, so
// real prefixes and substrings keep their exact behaviour.
describe("searchAssets tolerates typos", () => {
  it("finds USDC from the classic transposition", () => {
    const hits = searchAssets(TOKENS, "USCD");
    expect(hits.map((t) => t.symbol)).toContain("USDC");
  });

  it("does not fire when real matches exist", () => {
    // "USD" prefix-matches USDC; no edit-distance noise may join it
    const hits = searchAssets(TOKENS, "USD");
    expect(hits.every((t) => t.symbol === "USDC")).toBe(true);
  });

  it("keeps short queries strict — one edit, not two", () => {
    // BTC -> BCH is two edits; suggesting it for "BTC" typos would be wrong
    expect(searchAssets([tok({ identifier: "BCH.BCH", blockchain: "BCH", symbol: "BCH" })], "btq")).toEqual([]);
  });

  it("still finds nothing for genuine garbage", () => {
    expect(searchAssets(TOKENS, "ZZZZZZZZ")).toEqual([]);
  });
});
