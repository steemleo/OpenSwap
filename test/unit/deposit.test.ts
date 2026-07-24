import { describe, expect, it } from "vitest";
import { looksLikePlaceholder, prepareDepositAddress, validateAddressForChain } from "../../src/core/deposit.js";
import type { LeoKitApi } from "../../src/core/api.js";
import type { RouteOffer, WireDepositAddressResponse } from "../../src/core/types.js";

describe("validateAddressForChain", () => {
  it("accepts valid addresses per family", () => {
    expect(validateAddressForChain("ARB", "0x1111111111111111111111111111111111111111").ok).toBe(true);
    expect(validateAddressForChain("BTC", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").ok).toBe(true);
    expect(validateAddressForChain("SOL", "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK").ok).toBe(true);
  });
  it("rejects malformed and placeholder addresses", () => {
    expect(validateAddressForChain("ETH", "0x1234").ok).toBe(false);
    expect(validateAddressForChain("BTC", "0x1111111111111111111111111111111111111111").ok).toBe(false);
    expect(validateAddressForChain("ETH", "0x" + "0".repeat(40)).ok).toBe(false);
    expect(looksLikePlaceholder("0xdeadbeef00000000000000000000000000000000")).toBe(true);
  });
});

const offer: RouteOffer = {
  protocol: "chainflip",
  variant: null,
  expectedOutBase: "1",
  expectedOutDisplay: "0.00000001",
  expectedOutUsd: null,
  inputUsd: null,
  outDecimals: 8,
  inDecimals: 6,
  feesTotalUsd: null,
  feesComplete: false,
  fees: [],
  etaSeconds: null,
  expiresAt: Date.now() + 30000,
  ttlSeconds: 30,
  route: [],
  supportsDepositAddress: true,
  minInputDisplay: null,
  recommendedSlippageBps: null,
  flags: { bestOutput: false, fastest: false, cheapest: false },
  raw: {} as RouteOffer["raw"]
};

function fakeApi(response: Partial<WireDepositAddressResponse>): LeoKitApi {
  return {
    createDepositAddress: async () => ({
      deposit_address: "0x954d727831e9f959000960f53ac08c3721914182",
      amount: "25",
      amount_raw: "25000000",
      decimals: 6,
      from_asset: "ARB.USDC-0xabc",
      to_asset: "ETH.ETH",
      network: "ARB",
      protocol: "chainflip",
      chainflip_channel_id: 1,
      payment_uri: null,
      qr_url: null,
      expires_at: Date.now() + 600000,
      ...response
    })
  } as unknown as LeoKitApi;
}

const baseOpts = {
  quoteId: "q1",
  offer,
  amountDisplay: "25",
  toAddress: "0x1111111111111111111111111111111111111111",
  fromAddress: "0x1111111111111111111111111111111111111111"
};

describe("prepareDepositAddress", () => {
  it("accepts a clean response and recomputes exact base units", async () => {
    const prepared = await prepareDepositAddress(fakeApi({}), baseOpts);
    expect(prepared.amountBaseUnits).toBe("25000000");
    expect(prepared.warnings).toEqual([]);
  });

  it("rejects a protocol mismatch", async () => {
    await expect(prepareDepositAddress(fakeApi({ protocol: "near" }), baseOpts)).rejects.toThrow(/approved/);
  });

  it("rejects an amount mismatch", async () => {
    await expect(prepareDepositAddress(fakeApi({ amount: "26" }), baseOpts)).rejects.toThrow(/differs from your approved amount/);
  });

  it("rejects placeholder deposit addresses", async () => {
    await expect(
      prepareDepositAddress(fakeApi({ deposit_address: "0x" + "0".repeat(40) }), baseOpts)
    ).rejects.toThrow(/unusable deposit address/);
  });

  it("flags float-derived amount_raw and uses the exact value", async () => {
    const prepared = await prepareDepositAddress(fakeApi({ amount_raw: "24999999" }), baseOpts);
    expect(prepared.amountBaseUnits).toBe("25000000");
    expect(prepared.warnings.join(" ")).toMatch(/differs from the exact conversion/);
  });

  // The server's payment_uri used to be accepted on a substring test: a URI
  // that merely MENTIONED our address passed while paying somewhere else, and
  // for every non-EVM chain that URI became the QR payload verbatim. We now
  // build the URI ourselves and never read the server's.
  describe("payment URI is built locally, never taken from the server", () => {
    const BTC_REAL = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const BTC_ATTACKER = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const btcApi = (payment_uri: string | null) =>
      fakeApi({ deposit_address: BTC_REAL, network: "BTC", payment_uri });
    const btcOpts = { ...baseOpts, sourceChain: "BTC" };

    it("ignores a URI that pays an attacker while naming our address", async () => {
      const hostile = [
        `bitcoin:${BTC_ATTACKER}?amount=25&label=${BTC_REAL}`,
        `bitcoin:${BTC_ATTACKER}?amount=25&message=pay%20${BTC_REAL}`,
        `bitcoin:${BTC_ATTACKER}?req-addr=${BTC_REAL}`,
        `bitcoin:${BTC_ATTACKER}?label=${BTC_REAL}` // no amount: old check returned true
      ];
      for (const uri of hostile) {
        const prepared = await prepareDepositAddress(btcApi(uri), btcOpts);
        expect(prepared.paymentUri, uri).not.toContain(BTC_ATTACKER);
        expect(prepared.paymentUri, uri).toBe(`bitcoin:${BTC_REAL}?amount=25`);
      }
    });

    it("builds a BIP-21 URI from the validated address and exact amount", async () => {
      const prepared = await prepareDepositAddress(btcApi(null), btcOpts);
      expect(prepared.paymentUri).toBe(`bitcoin:${BTC_REAL}?amount=25`);
      // the invariant the QR depends on: the URI's payment target IS the
      // address we display and copy
      expect(prepared.paymentUri!.split(":")[1]!.split("?")[0]).toBe(prepared.depositAddress);
    });

    it("emits no URI for EVM, where the bare address is the safe payload", async () => {
      const uri = "ethereum:0xabc@42161/transfer?address=0x954d727831e9f959000960f53ac08c3721914182&uint256=25000000";
      const prepared = await prepareDepositAddress(fakeApi({ payment_uri: uri }), baseOpts);
      expect(prepared.paymentUri).toBeNull();
    });

    it("emits no URI for a chain with no established scheme", async () => {
      const prepared = await prepareDepositAddress(
        fakeApi({ deposit_address: "cosmos1abcdefghijklmnop", network: "ATOM", payment_uri: "cosmos:whatever" }),
        { ...baseOpts, sourceChain: "ATOM" }
      );
      expect(prepared.paymentUri).toBeNull();
    });
  });

  it("refuses BOB (memo-required) on the QR path", async () => {
    await expect(
      prepareDepositAddress(fakeApi({}), { ...baseOpts, offer: { ...offer, protocol: "bob" } })
    ).rejects.toThrow(/cannot be paid safely/);
  });
});

describe("validateAddressForChain — cross-family pastes", () => {
  const EVM = "0x1111111111111111111111111111111111111111";
  it("rejects an EVM address on known non-EVM chains", () => {
    for (const chain of ["XRP", "TRX", "ATOM", "DOT", "THOR", "ZEC", "NEAR", "TON", "ADA"]) {
      const r = validateAddressForChain(chain, EVM);
      expect(r.ok, `${chain} accepted an EVM address`).toBe(false);
      expect(r.reason).toMatch(/EVM/);
    }
  });
  it("rejects a Bitcoin address on a non-Bitcoin chain", () => {
    expect(validateAddressForChain("XRP", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").ok).toBe(false);
  });
  it("still accepts native-looking addresses on those chains", () => {
    expect(validateAddressForChain("XRP", "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w").ok).toBe(true);
    expect(validateAddressForChain("ATOM", "cosmos1vqpjljwsynsn58dugz0w8ut7kun7t8ls2qkmsq").ok).toBe(true);
    expect(validateAddressForChain("NEAR", "alice.near").ok).toBe(true);
  });
  it("validates EVM chains missing from the old hardcoded list", () => {
    for (const chain of ["UNICHAIN", "GNOSIS", "CELO", "SONIC"]) {
      expect(validateAddressForChain(chain, EVM).ok, chain).toBe(true);
      expect(validateAddressForChain(chain, "not-an-address").ok, chain).toBe(false);
    }
  });
  it("keeps validating every chain the signer registry knows", () => {
    for (const chain of ["ETH", "ARB", "BASE", "OP", "POL", "BSC", "AVAX"]) {
      expect(validateAddressForChain(chain, EVM).ok, chain).toBe(true);
      expect(validateAddressForChain(chain, "0xshort").ok, chain).toBe(false);
    }
  });
  it("leaves an unknown chain on the permissive fallback, not a false rejection", () => {
    // a new EVM chain appearing upstream must not start failing valid addresses
    expect(validateAddressForChain("SOMENEWCHAIN", EVM).ok).toBe(true);
  });
});
