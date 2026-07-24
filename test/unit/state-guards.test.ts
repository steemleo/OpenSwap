import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveIdempotencyKey,
  findIdempotentResult,
  releaseIdempotentKey,
  reserveIdempotentKey,
  saveIdempotentResult
} from "../../src/core/idempotency.js";
import { latestOpenReceipt, listReceipts, newReceiptId, readReceipt, updateReceipt, writeReceipt } from "../../src/core/receipts.js";
import { receiptsDir, ensureDir } from "../../src/core/paths.js";
import { redactKey, resolveCredential } from "../../src/core/credentials.js";
import { setConfigValue } from "../../src/core/config.js";
import type { ReceiptV1 } from "../../src/core/types.js";

const saved = {
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
  cache: process.env.XDG_CACHE_HOME,
  key: process.env.OPENSWAP_API_KEY
};

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "openswap-state-"));
  process.env.XDG_DATA_HOME = join(base, "data");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.XDG_CACHE_HOME = join(base, "cache");
});

afterEach(() => {
  for (const [envName, value] of [
    ["XDG_DATA_HOME", saved.data],
    ["XDG_CONFIG_HOME", saved.config],
    ["XDG_CACHE_HOME", saved.cache],
    ["OPENSWAP_API_KEY", saved.key]
  ] as const) {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
});

function sampleReceipt(id: string, state: ReceiptV1["last_state"]): ReceiptV1 {
  return {
    schema_version: "1",
    receipt_id: id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    environment: "mainnet",
    api_url: "https://api.leokit.dev",
    quote_id: "q-1",
    protocol: "relay",
    from_asset: "ETH.USDC-0xa",
    to_asset: "BASE.USDC-0xb",
    amount_display: "5",
    amount_base_units: "5000000",
    expected_out_display: "4.99",
    expected_out_usd: 4.99,
    destination_address: "0x1111111111111111111111111111111111111111",
    refund_address: null,
    deposit: null,
    tx_hashes: { source: null, destination: null, refund: null },
    last_state: state,
    last_checked_at: null,
    last_error: null,
    notes: null
  };
}

describe("idempotency reservation (double-broadcast guard)", () => {
  it("reserve → pending for rivals → done after save", () => {
    const key = deriveIdempotencyKey({ a: "1", b: "2" });
    expect(reserveIdempotentKey(key)).toEqual({ state: "reserved" });
    // an identical concurrent run must be refused, not allowed to trade
    const rival = reserveIdempotentKey(key);
    expect(rival.state).toBe("pending");
    // pending entries never replay as results
    expect(findIdempotentResult(key)).toBeUndefined();
    saveIdempotentResult(key, { tx: "0xabc" });
    expect(findIdempotentResult(key)).toEqual({ tx: "0xabc" });
    expect(reserveIdempotentKey(key)).toEqual({ state: "done", result: { tx: "0xabc" } });
  });
  it("release frees only pending reservations (pre-broadcast failures)", () => {
    const key = deriveIdempotencyKey({ x: "1" });
    reserveIdempotentKey(key);
    releaseIdempotentKey(key);
    expect(reserveIdempotentKey(key)).toEqual({ state: "reserved" }); // retry allowed
    saveIdempotentResult(key, "done");
    releaseIdempotentKey(key); // done entries are immune
    expect(findIdempotentResult(key)).toBe("done");
  });
  it("keys are order-independent and stable", () => {
    expect(deriveIdempotencyKey({ a: "1", b: "2" })).toBe(deriveIdempotencyKey({ b: "2", a: "1" }));
    expect(deriveIdempotencyKey({ a: "1" })).not.toBe(deriveIdempotencyKey({ a: "2" }));
  });
});

describe("receipts store", () => {
  it("write → read → update round-trips atomically", () => {
    const id = newReceiptId();
    expect(id).toMatch(/^os_[a-z0-9]+$/);
    writeReceipt(sampleReceipt(id, "awaiting_payment"));
    expect(readReceipt(id).amount_display).toBe("5");
    const updated = updateReceipt(id, { last_state: "success" });
    expect(updated.last_state).toBe("success");
    expect(readReceipt(id).last_state).toBe("success");
  });
  it("a corrupt receipt file is skipped, never fatal", () => {
    writeReceipt(sampleReceipt(newReceiptId(), "pending"));
    ensureDir(receiptsDir());
    writeFileSync(join(receiptsDir(), "os_corrupt.json"), "{not json");
    const listed = listReceipts();
    expect(listed).toHaveLength(1);
    expect(readdirSync(receiptsDir()).length).toBe(2); // corrupt file untouched
  });
  it("latestOpenReceipt ignores terminal and expired states", () => {
    writeReceipt(sampleReceipt("os_done1111111111", "success"));
    writeReceipt(sampleReceipt("os_dead1111111111", "expired"));
    expect(latestOpenReceipt()).toBeNull();
    writeReceipt(sampleReceipt("os_live1111111111", "awaiting_payment"));
    expect(latestOpenReceipt()?.receipt_id).toBe("os_live1111111111");
  });
});

describe("credentials", () => {
  it("env key outranks everything and redacts to last four", () => {
    process.env.OPENSWAP_API_KEY = "test-key-abcd1234";
    const cred = resolveCredential();
    expect(cred.source).toBe("env");
    expect(cred.key).toBe("test-key-abcd1234");
    expect(redactKey(cred.key)).toBe("••••1234");
    expect(redactKey("ab")).toBe("••••");
  });
});

describe("config secret refusal", () => {
  it("rejects secret-like keys outright", () => {
    for (const key of ["api_key", "apiKey", "private_key", "secret", "password", "PASSWORD"]) {
      expect(() => setConfigValue(key, "x")).toThrow();
    }
  });
  it("rejects unknown keys (allowlist)", () => {
    expect(() => setConfigValue("definitely_not_a_setting", "x")).toThrow();
  });
});

describe("deposit throttle (footgun guard)", () => {
  it("allows normal volume, blocks a runaway loop, honors the override", async () => {
    const { checkDepositThrottle } = await import("../../src/core/throttle.js");
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 15; i++) checkDepositThrottle(t0 + i * 1000);
    expect(() => checkDepositThrottle(t0 + 16_000)).toThrow(/runaway loops/);
    // window slides: 10 minutes later it clears
    expect(() => checkDepositThrottle(t0 + 11 * 60_000)).not.toThrow();
    process.env.OPENSWAP_NO_THROTTLE = "1";
    try {
      for (let i = 0; i < 20; i++) checkDepositThrottle(t0 + 12 * 60_000 + i);
    } finally {
      delete process.env.OPENSWAP_NO_THROTTLE;
    }
  });
});
