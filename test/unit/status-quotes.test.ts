import { describe, expect, it } from "vitest";
import { normalizeStatus } from "../../src/core/status.js";
import { normalizeQuoteResponse } from "../../src/core/quotes.js";
import type { WireQuoteResponse } from "../../src/core/types.js";

describe("normalizeStatus — dual response shapes", () => {
  it("normalizes the live shape (scanner_url keys)", () => {
    const s = normalizeStatus({
      status: "swapping",
      protocol: "chainflip",
      dest_tx_hash: null,
      scanner_url: "https://scanner.example/x",
      native_scanner_url: "https://arbiscan.io/tx/0xabc"
    });
    expect(s.state).toBe("swapping");
    expect(s.scannerUrl).toBe("https://scanner.example/x");
    expect(s.nativeScannerUrl).toBe("https://arbiscan.io/tx/0xabc");
  });

  it("normalizes the DB-cached terminal shape (scanner/hash keys)", () => {
    const s = normalizeStatus({
      status: "success",
      protocol: "relay-deposit",
      scanner: "https://relay.link/tx",
      native_scanner: "https://arbiscan.io/tx/0xdef",
      hash: "0xdef"
    });
    expect(s.state).toBe("success");
    expect(s.scannerUrl).toBe("https://relay.link/tx");
    expect(s.destTxHash).toBe("0xdef");
  });

  it("maps unknown states to pending, never failed", () => {
    expect(normalizeStatus({ status: "weird_upstream_state" }).state).toBe("pending");
  });
});

const wire: WireQuoteResponse = {
  quote_id: "q-test",
  timestamp: "2026-07-17T00:00:00Z",
  quotes: [
    {
      protocol: "relay",
      data: {
        protocol: "relay",
        expected_amount_out: "54010865043954520999",
        expected_amount_out_usd: 99.28,
        input_amount_usd: 100.07,
        expires_at: 1784303525217,
        ttl_seconds: 30,
        total_swap_seconds: 5,
        out_asset_decimal: 18,
        in_asset_decimal: 6,
        fees: [{ type: "gas Fee", asset: "ARB.ETH", amount: 0.0000015, usd: 0.0029 }],
        route: ["ARB.USDC", "ETH.ETH"]
      }
    },
    {
      protocol: "bob",
      data: {
        protocol: "bob",
        expected_amount_out: 155000,
        expected_amount_out_usd: 99.1,
        input_amount_usd: 100.07,
        expires_at: 1784303525217,
        ttl_seconds: 30,
        total_swap_seconds: 2,
        out_asset_decimal: 8,
        in_asset_decimal: 6,
        fees: [{ type: "Fee", asset: "BTC.BTC", amount: 0.00001, usd: null }],
        route: []
      }
    }
  ]
};

describe("normalizeQuoteResponse", () => {
  const set = normalizeQuoteResponse(wire, { fromAsset: "ARB.USDC", toAsset: "X", amountDisplay: "100" });

  it("preserves >2^53 base units exactly", () => {
    const relay = set.offers.find((o) => o.protocol === "relay")!;
    expect(relay.expectedOutBase).toBe("54010865043954520999");
    expect(relay.expectedOutDisplay).toBe("54.010865043954520999");
  });

  it("null-usd fees can never win cheapest and never total", () => {
    const bob = set.offers.find((o) => o.protocol === "bob")!;
    expect(bob.feesTotalUsd).toBeNull();
    expect(bob.flags.cheapest).toBe(false);
    const relay = set.offers.find((o) => o.protocol === "relay")!;
    expect(relay.flags.cheapest).toBe(true);
  });

  it("ranks by exact output and flags fastest", () => {
    expect(set.offers[0]!.protocol).toBe("relay");
    expect(set.offers.find((o) => o.protocol === "bob")!.flags.fastest).toBe(true);
  });
});

// The wire signals "could not price this fee" with usd: 0, not null. Counting
// that as priced understated live debridge fees ~8.6x and handed the "cheapest"
// badge to the one route whose fees were unknown.
describe("normalizeQuoteResponse — usd:0 is unpriced, not free", () => {
  const outData = (protocol: string, out: string, fees: unknown[]) => ({
    protocol,
    data: {
      protocol,
      expected_amount_out: out,
      out_asset_decimal: 6,
      in_asset_decimal: 6,
      total_swap_seconds: 10,
      expires_at: 0,
      ttl_seconds: 30,
      fees,
      route: []
    }
  });

  // Shapes copied from live production responses, 2026-07-24.
  const mixed = {
    quote_id: "q",
    timestamp: "t",
    quotes: [
      // every component priced — this one is genuinely comparable
      outData("relay", "99961251", [
        { type: "relayer Fee", asset: "ARB.USDC", amount: "0.115752", usd: 0.11574 },
        { type: "app Fee", asset: "ARB.USDC", amount: "0.1", usd: 0.09999 }
      ]),
      // three real components the backend could not price
      outData("debridge", "99910024", [
        { type: "DlnProtocolFee", asset: "USD", amount: 40101, usd: 0.040101 },
        { type: "AffiliateFee", asset: "USD", amount: 10021, usd: 0 },
        { type: "TakerMargin", asset: "USD", amount: 40081, usd: 0 }
      ]),
      // a single unpriced fee totalling zero — used to render "$0 fees"
      outData("across", "99900000", [{ type: "Relay Fee", asset: "BASE.USDC", amount: 136485, usd: 0 }])
    ]
  } as unknown as WireQuoteResponse;

  const set = normalizeQuoteResponse(mixed, { fromAsset: "ETH.USDC", toAsset: "BASE.USDC", amountDisplay: "100" });
  const by = (p: string) => set.offers.find((o) => o.protocol === p)!;

  it("does not total a fee set that omits real components", () => {
    expect(by("debridge").feesComplete).toBe(false);
    expect(by("debridge").feesTotalUsd).toBeNull();
    expect(by("across").feesComplete).toBe(false);
    expect(by("across").feesTotalUsd).toBeNull();
  });

  it("still totals a fully priced fee set", () => {
    expect(by("relay").feesComplete).toBe(true);
    expect(by("relay").feesTotalUsd).toBeCloseTo(0.21573, 5);
  });

  it("gives cheapest to the only comparable route, not the least-known one", () => {
    expect(by("across").flags.cheapest).toBe(false);
    expect(by("debridge").flags.cheapest).toBe(false);
    expect(by("relay").flags.cheapest).toBe(true);
  });

  it("reports an unpriced fee as null so agents never read it as zero", () => {
    const aff = by("debridge").fees.find((f) => f.type === "AffiliateFee")!;
    expect(aff.usd).toBeNull();
    expect(aff.amount).toBe(10021); // the amount itself is untouched
  });

  it("treats a genuinely zero-amount fee as priced", () => {
    const zero = {
      quote_id: "q",
      timestamp: "t",
      quotes: [outData("relay", "1000", [{ type: "subsidized Fee", asset: "ARB.USDC", amount: "0", usd: 0 }])]
    } as unknown as WireQuoteResponse;
    const s = normalizeQuoteResponse(zero, { fromAsset: "A", toAsset: "B", amountDisplay: "1" });
    expect(s.offers[0]!.feesComplete).toBe(true);
    expect(s.offers[0]!.feesTotalUsd).toBe(0);
  });
});

describe("executionLane", () => {
  it("classifies deposit, signer, and unsupported lanes", async () => {
    const { executionLane } = await import("../../src/core/quotes.js");
    const mk = (protocol: string, sda: boolean | null) =>
      ({ protocol, supportsDepositAddress: sda } as never);
    expect(executionLane(mk("chainflip", null), "ARB.USDC-0x1")).toBe("deposit_address");
    expect(executionLane(mk("relay", null), "BTC.BTC")).toBe("deposit_address");
    expect(executionLane(mk("rango", null), "BASE.USDC-0x1")).toBe("wallet_signed");
    expect(executionLane(mk("bob", null), "BASE.USDC-0x1")).toBe("wallet_signed");
    expect(executionLane(mk("mayachain", null), "BTC.BTC")).toBe("unsupported");
    expect(executionLane(mk("rango", true), "BTC.BTC")).toBe("deposit_address");
  });
});

// Relay lists its relayer fee as a subtotal AND its two components, so summing
// every line counts it twice. Ground truth for the numbers below comes from a
// real funded swap (receipt os_ms2atn8ve4dcfece, 6 USDC ARB->BASE): relay's own
// API reported $0.031342 of fees, the wallet lost 0.031964 USDC, and the CLI
// displayed $0.07 — roughly double.
describe("normalizeQuoteResponse — nested provider fees are not double-counted", () => {
  const offer = (fees: unknown[]) => ({
    quote_id: "q",
    timestamp: "t",
    quotes: [
      {
        protocol: "relay",
        data: {
          protocol: "relay",
          expected_amount_out: "5968036",
          out_asset_decimal: 6,
          in_asset_decimal: 6,
          total_swap_seconds: 3,
          expires_at: 0,
          ttl_seconds: 30,
          fees,
          route: []
        }
      }
    ]
  }) as unknown as WireQuoteResponse;

  const USDC = "ARB.USDC-0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const ETH = "ARB.ETH-0x0000000000000000000000000000000000000000";

  // Exactly the six lines from the funded swap.
  const REAL_SWAP_FEES = [
    { type: "gas Fee", asset: ETH, amount: "0.0000014101214292", usd: 0.0027 },
    { type: "relayer Fee", asset: USDC, amount: "0.031356", usd: 0.031356 },
    { type: "relayerGas Fee", asset: USDC, amount: "0.010785", usd: 0.010785 },
    { type: "relayerService Fee", asset: USDC, amount: "0.020571", usd: 0.020571 },
    { type: "app Fee", asset: USDC, amount: "0.0006", usd: 0.0006 },
    { type: "subsidized Fee", asset: USDC, amount: "0", usd: 0 }
  ];

  it("counts the relayer fee once, not once per component", () => {
    const set = normalizeQuoteResponse(offer(REAL_SWAP_FEES), {
      fromAsset: "ARB.USDC",
      toAsset: "BASE.USDC",
      amountDisplay: "6"
    });
    const o = set.offers[0]!;
    // gas 0.0027 + relayer 0.031356 + app 0.0006 = 0.034656
    // (the old behaviour also added the two components: 0.066012)
    expect(o.feesTotalUsd).toBeCloseTo(0.034656, 6);
    expect(o.feesTotalUsd!).toBeLessThan(0.05);
  });

  it("keeps every line visible — collapsing the total must not hide a fee", () => {
    const set = normalizeQuoteResponse(offer(REAL_SWAP_FEES), {
      fromAsset: "ARB.USDC",
      toAsset: "BASE.USDC",
      amountDisplay: "6"
    });
    const types = set.offers[0]!.fees.map((f) => f.type);
    expect(types).toContain("relayerGas Fee");
    expect(types).toContain("relayerService Fee");
    expect(types).toHaveLength(6);
  });

  it("leaves a flat fee list untouched", () => {
    // mayachain-shaped: three independent fees, nothing nested
    const flat = [
      { type: "Affiliate Fee", asset: USDC, amount: "1", usd: 1 },
      { type: "Outbound Fee", asset: USDC, amount: "2", usd: 2 },
      { type: "Network Fee", asset: USDC, amount: "3", usd: 3 }
    ];
    const set = normalizeQuoteResponse(offer(flat), { fromAsset: "A", toAsset: "B", amountDisplay: "6" });
    expect(set.offers[0]!.feesTotalUsd).toBeCloseTo(6, 6);
  });

  it("does not collapse across different assets", () => {
    // same arithmetic, but the 'parent' is denominated in ETH — coincidence, not containment
    const crossAsset = [
      { type: "gas Fee", asset: ETH, amount: "3", usd: 3 },
      { type: "a Fee", asset: USDC, amount: "1", usd: 1 },
      { type: "b Fee", asset: USDC, amount: "2", usd: 2 }
    ];
    const set = normalizeQuoteResponse(offer(crossAsset), { fromAsset: "A", toAsset: "B", amountDisplay: "6" });
    expect(set.offers[0]!.feesTotalUsd).toBeCloseTo(6, 6);
  });

  it("does not collapse when a zero-amount line makes the sum trivially match", () => {
    const withZero = [
      { type: "x Fee", asset: USDC, amount: "5", usd: 5 },
      { type: "y Fee", asset: USDC, amount: "5", usd: 5 },
      { type: "z Fee", asset: USDC, amount: "0", usd: 0 }
    ];
    const set = normalizeQuoteResponse(offer(withZero), { fromAsset: "A", toAsset: "B", amountDisplay: "6" });
    expect(set.offers[0]!.feesTotalUsd).toBeCloseTo(10, 6);
  });

  it("does not collapse when names nest but the arithmetic does not", () => {
    // relay-shaped names, but the components do NOT sum to the parent
    const mismatched = [
      { type: "relayer Fee", asset: USDC, amount: "0.05", usd: 0.05 },
      { type: "relayerGas Fee", asset: USDC, amount: "0.01", usd: 0.01 },
      { type: "relayerService Fee", asset: USDC, amount: "0.02", usd: 0.02 }
    ];
    const set = normalizeQuoteResponse(offer(mismatched), { fromAsset: "A", toAsset: "B", amountDisplay: "6" });
    expect(set.offers[0]!.feesTotalUsd).toBeCloseTo(0.08, 6);
    expect(set.offers[0]!.fees.every((f) => f.component_of === undefined)).toBe(true);
  });

  it("labels each component with the parent that already counts it", () => {
    const set = normalizeQuoteResponse(offer(REAL_SWAP_FEES), {
      fromAsset: "ARB.USDC",
      toAsset: "BASE.USDC",
      amountDisplay: "6"
    });
    const byType = Object.fromEntries(set.offers[0]!.fees.map((f) => [f.type, f.component_of]));
    expect(byType["relayerGas Fee"]).toBe("relayer Fee");
    expect(byType["relayerService Fee"]).toBe("relayer Fee");
    expect(byType["relayer Fee"]).toBeUndefined();
    expect(byType["app Fee"]).toBeUndefined();
  });
});
