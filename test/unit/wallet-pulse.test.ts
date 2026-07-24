import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptKeystoreV3, keystoreAddress } from "../../src/core/signer/keystore.js";
import { decryptKeystoreV3 } from "../../src/core/signer/evm.js";
import { readPulseState, recordSuccess, optOut, pulseMessage } from "../../src/core/pulse.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("keystore encrypt/decrypt roundtrip", () => {
  it("round-trips through our own decryptKeystoreV3", () => {
    const json = encryptKeystoreV3(KEY, "correct horse battery", ADDR);
    expect(keystoreAddress(json)?.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(decryptKeystoreV3(json, "correct horse battery")).toBe(KEY);
  }, 30000);
  it("rejects a wrong passphrase via MAC", () => {
    const json = encryptKeystoreV3(KEY, "right", ADDR);
    expect(() => decryptKeystoreV3(json, "wrong")).toThrow(/MAC mismatch/);
  }, 30000);
});

describe("pulse cadence", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openswap-pulse-"));
    process.env.XDG_DATA_HOME = tempDir;
  });
  afterEach(() => {
    delete process.env.XDG_DATA_HOME;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("asks after a randomized 5-10 successes, then not again within 48h", () => {
    const T0 = 1_800_000_000_000;
    let asked = -1;
    for (let i = 1; i <= 10; i++) {
      if (recordSuccess(T0 + i)) { asked = i; break; }
    }
    expect(asked).toBeGreaterThanOrEqual(5);
    expect(asked).toBeLessThanOrEqual(10);
    // burn through another 10 successes within the 48h window — never asks
    for (let i = 0; i < 10; i++) {
      expect(recordSuccess(T0 + 1000 + i)).toBe(false);
    }
    // after 48h AND enough successes, it can ask again
    const T1 = T0 + 49 * 60 * 60 * 1000;
    let askedAgain = false;
    for (let i = 0; i < 11; i++) {
      if (recordSuccess(T1 + i)) { askedAgain = true; break; }
    }
    expect(askedAgain).toBe(true);
  });

  it("opt-out is permanent and counters stop mattering", () => {
    optOut();
    for (let i = 0; i < 30; i++) expect(recordSuccess()).toBe(false);
    expect(readPulseState().opted_out).toBe(true);
  });

  it("pulse message encodes rating, version, platform", () => {
    expect(pulseMessage(3, "love it")).toMatch(/^\[pulse 3\/3 v\d+\.\d+\.\d+ \w+\] love it$/);
    expect(pulseMessage(1, "")).toMatch(/^\[pulse 1\/3/);
  });
});
