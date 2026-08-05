import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeoKitApi } from "../../src/core/api.js";
import { streamQuoteSet } from "../../src/core/quotes.js";
import { prepareDepositAddress } from "../../src/core/deposit.js";
import { newReceiptId } from "../../src/core/receipts.js";
import { isTestMode, receiptsDir } from "../../src/core/paths.js";
import { header } from "../../src/render/components.js";
import { forceCaps, stripAnsi } from "../../src/render/theme.js";
import { simFetch } from "../../src/testmode/server.js";
import { depositStatus, magicOutcome, loadWorld, saveWorld, type SimDeposit } from "../../src/testmode/world.js";

const saved = {
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
  cache: process.env.XDG_CACHE_HOME,
  mode: process.env.OPENSWAP_TEST_MODE,
  scale: process.env.OPENSWAP_TEST_TIMESCALE
};

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "openswap-testmode-"));
  process.env.XDG_DATA_HOME = join(base, "data");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.XDG_CACHE_HOME = join(base, "cache");
  process.env.OPENSWAP_TEST_MODE = "1";
  delete process.env.OPENSWAP_TEST_TIMESCALE;
});

afterEach(() => {
  for (const [key, value] of [
    ["XDG_DATA_HOME", saved.data],
    ["XDG_CONFIG_HOME", saved.config],
    ["XDG_CACHE_HOME", saved.cache],
    ["OPENSWAP_TEST_MODE", saved.mode],
    ["OPENSWAP_TEST_TIMESCALE", saved.scale]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  forceCaps(null);
});

function simApi(): LeoKitApi {
  return new LeoKitApi({ apiKey: "test", baseUrl: "http://127.0.0.1/test-mode", fetchImpl: simFetch() });
}

const FROM = "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TO = "BASE.ETH";

describe("test-mode safety invariants", () => {
  it("namespaces all simulated state and receipts", () => {
    expect(isTestMode()).toBe(true);
    expect(receiptsDir()).toContain("test-mode");
    expect(newReceiptId()).toMatch(/^ost_/);
    process.env.OPENSWAP_TEST_MODE = "0";
    expect(isTestMode()).toBe(false);
    expect(receiptsDir()).not.toContain("test-mode");
    expect(newReceiptId()).toMatch(/^os_[^t]/);
  });
  it("brands every header with the TEST badge, only in test mode", () => {
    forceCaps({ color: true, depth: "truecolor", unicode: true, isTTY: true, columns: 80 });
    expect(stripAnsi(header("swap"))).toContain("TEST");
    process.env.OPENSWAP_TEST_MODE = "0";
    expect(stripAnsi(header("swap"))).not.toContain("TEST");
  });
});

describe("simulated backend speaks the production wire", () => {
  it("streams SSE quotes the real client fully normalizes (bigint path included)", async () => {
    process.env.OPENSWAP_TEST_TIMESCALE = "1000"; // no real waiting
    const set = await streamQuoteSet(simApi(), { from_asset: FROM, to_asset: TO, amount: "30" });
    expect(set.quoteId).toMatch(/^[0-9a-f-]{36}$/);
    const protocols = set.offers.map((o) => o.protocol).sort();
    expect(protocols).toEqual(["chainflip", "near", "rango", "relay"]);
    const eth = set.offers[0]!;
    expect(BigInt(eth.expectedOutBase)).toBeGreaterThan(2n ** 53n); // wei amounts exercise the bigint parse
    expect(eth.feesTotalUsd).not.toBeNull();
  });
  // Regression: above 1e21 the wire switches to exponent notation, which the
  // bigint-preserving parse could not see. Every route was then dropped in
  // silence and reported to the user as "this pair may not be supported".
  it("normalizes payouts above 1e21, where the wire uses exponent form", async () => {
    process.env.OPENSWAP_TEST_TIMESCALE = "1000";
    const set = await streamQuoteSet(simApi(), {
      from_asset: FROM,
      to_asset: "ARB.ARB-0x912CE59144191C1204E64559FE8253a0e49E6548", // 18 decimals, ~$0.62
      amount: "50000"
    });
    expect(set.offers.length).toBeGreaterThan(0);
    for (const o of set.offers) {
      expect(o.expectedOutBase, `${o.protocol} base units`).toMatch(/^\d+$/);
      expect(BigInt(o.expectedOutBase)).toBeGreaterThan(10n ** 21n);
      // the catastrophic symptom was a display of 0.000000000000000002
      expect(Number(o.expectedOutDisplay)).toBeGreaterThan(1000);
    }
  });
  it("mints deposits that pass the production gauntlet, with recognizable addresses", async () => {
    process.env.OPENSWAP_TEST_TIMESCALE = "1000";
    const api = simApi();
    const set = await streamQuoteSet(api, { from_asset: FROM, to_asset: TO, amount: "30" }, { depositOnly: true });
    const offer = set.offers.find((o) => o.protocol === "relay")!;
    const prepared = await prepareDepositAddress(api, {
      quoteId: set.quoteId,
      offer,
      amountDisplay: "30",
      toAddress: "0x1111111111111111111111111111111111111111",
      sourceChain: "ETH"
    });
    expect(prepared.depositAddress).toMatch(/^0x7e57[0-9a-f]{36}$/);
    expect(prepared.amountBaseUnits).toBe("30000000");
    // EVM pays from the bare address: wallets have mangled EIP-681 token URIs,
    // and the simulator's URI is ignored here exactly as production's is.
    expect(prepared.paymentUri).toBeNull();
    expect(prepared.warnings).toEqual([]);
  });
  it("unknown pairs 404 into the friendly NO_ROUTE path", async () => {
    await expect(streamQuoteSet(simApi(), { from_asset: "XX.YY", to_asset: TO, amount: "1" })).rejects.toMatchObject({
      code: "NO_ROUTE"
    });
  });
});

describe("world state machine", () => {
  const dep = (outcome: SimDeposit["outcome"], paidAt: number | null): SimDeposit => ({
    quote_id: "q",
    receipt_hint: null,
    protocol: "relay-deposit",
    from_asset: FROM,
    to_asset: TO,
    amount_display: "30",
    deposit_address: "0x7e57",
    network: "ETH",
    to_address: "0x1",
    from_address: null,
    created_at: 1_000_000,
    expires_at: 1_000_000 + 30 * 60_000,
    paid_at: paidAt,
    outcome,
    out_base_units: "1000000000000000000",
    out_decimals: 18
  });
  it("progresses paid deposits through the full happy timeline", () => {
    const d = dep("happy", 1_000_000);
    expect(depositStatus(d, 1_000_000 + 1000).state).toBe("pending");
    expect(depositStatus(d, 1_000_000 + 6000).state).toBe("confirming");
    expect(depositStatus(d, 1_000_000 + 13_000).state).toBe("swapping");
    expect(depositStatus(d, 1_000_000 + 21_000).state).toBe("sending");
    expect(depositStatus(d, 1_000_000 + 27_000).state).toBe("success");
    expect(depositStatus(d, 1_000_000 + 27_000).dest_tx_hash).toMatch(/^0x7e57/);
  });
  it("magic amounts steer outcomes; expire never auto-pays", () => {
    expect(magicOutcome("100.13", "happy")).toBe("fail");
    expect(magicOutcome("100.19", "happy")).toBe("refund");
    expect(magicOutcome("100", "refund")).toBe("refund");
    const failing = dep("fail", 1_000_000);
    expect(depositStatus(failing, 1_000_000 + 19_000).state).toBe("failed");
    const refunding = dep("refund", 1_000_000);
    expect(depositStatus(refunding, 1_000_000 + 21_000).state).toBe("refunded");
    expect(depositStatus(refunding, 1_000_000 + 21_000).refund_tx_hash).toMatch(/^0x7e57/);
  });
  it("auto-paid success is sticky — a late status check never regresses", () => {
    const d = dep("happy", null); // no explicit payment: pure autopay path
    const hourLater = 1_000_000 + 60 * 60_000;
    expect(depositStatus(d, hourLater).state).toBe("success");
    const dayLater = 1_000_000 + 24 * 60 * 60_000;
    expect(depositStatus(d, dayLater).state).toBe("success");
  });
  it("persists and reloads the world", () => {
    const world = loadWorld();
    world.scenario = "refund";
    saveWorld(world);
    expect(loadWorld().scenario).toBe("refund");
  });
});

// The phantom scenario plays a hostile status source: terminal success on the
// FIRST poll, unpaid, no hash, raw base-unit out_amount. It exists so the e2e
// gate can prove the CLI refuses to endorse an uncorroborated claim.
describe("phantom scenario wire shape", () => {
  it("reports instant success with no corroboration, before any payment", () => {
    const d: SimDeposit = {
      quote_id: "q", receipt_hint: null, protocol: "rango",
      from_asset: "BTC.BTC", to_asset: "ETH.USDC", amount_display: "1.62",
      deposit_address: "x", network: "BTC", to_address: "0x1", from_address: null,
      created_at: Date.now(), expires_at: Date.now() + 60_000, paid_at: null,
      outcome: "phantom", out_base_units: "55123420000", out_decimals: 6
    };
    const s = depositStatus(d, Date.now() + 1);
    expect(s.state).toBe("success");
    expect(s.dest_tx_hash).toBeNull();
    expect(s.out_amount).toBe("123456789012345678");
  });
});
