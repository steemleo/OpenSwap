import { readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, ensureDir } from "../core/paths.js";
import { FIXTURE_ASSETS, type FixtureAsset } from "./fixtures.js";

// The simulated world. One JSON file, seeded PRNG, and — the trick that
// avoids any daemon — TIME-DRIVEN progression: a swap's status is a pure
// function of (payment time, scenario, now), so separate CLI invocations
// naturally observe a world that kept moving.

export type Scenario = "happy" | "refund" | "fail" | "expire" | "slow";
export const SCENARIOS: Scenario[] = ["happy", "refund", "fail", "expire", "slow"];

// Stripe-style magic amounts: the cents decide the story, so agents can
// parametrize thousands of runs without touching config.
export const MAGIC_AMOUNTS: Record<string, { outcome: Scenario; label: string }> = {
  ".13": { outcome: "fail", label: "protocol failure after payment" },
  ".19": { outcome: "refund", label: "swap refunds to sender" },
  ".07": { outcome: "expire", label: "short 15s deposit window" },
  ".23": { outcome: "slow", label: "slow confirmations" }
};

export interface SimDeposit {
  quote_id: string;
  receipt_hint: string | null;
  protocol: string;
  from_asset: string;
  to_asset: string;
  amount_display: string;
  deposit_address: string;
  network: string;
  to_address: string;
  from_address: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null; // explicit `test pay`, or autopay fills it lazily
  outcome: Scenario;
  out_base_units: string;
  out_decimals: number;
}

export interface SimQuote {
  from_asset: string;
  to_asset: string;
  amount: string;
  created_at: number;
}

export interface WorldState {
  version: 1;
  seed: number;
  scenario: Scenario;
  created_at: number;
  wallets: Record<string, Record<string, string>>; // address → "CHAIN:SYMBOL" → display amount
}

// Well-known burned key (anvil account #0) — the industry-standard test
// signer. Its only legitimate pairing is a localhost RPC; mode.ts asserts it.
export const TEST_SIGNER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_SIGNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Quotes and deposits live as ONE FILE PER ID — concurrent CLI processes (a
// cycle fleet) writing different swaps can never clobber each other, which a
// single monolithic world file's read-modify-write inevitably would.
function worldDir(): string {
  return join(dataDir(), "test-world");
}
function worldPath(): string {
  return join(worldDir(), "world.json");
}
function quotePath(id: string): string {
  return join(worldDir(), "quotes", `${id}.json`);
}
function depositPath(id: string): string {
  return join(worldDir(), "deposits", `${id}.json`);
}

function writeAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveQuote(id: string, quote: SimQuote): void {
  writeAtomic(quotePath(id), quote);
  // bounded across thousands of cycles: prune quote files older than an hour
  try {
    const dir = join(worldDir(), "quotes");
    const files = readdirSync(dir);
    if (files.length > 400) {
      const cutoff = Date.now() - 60 * 60_000;
      for (const f of files) {
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        } catch {
          // another process may have pruned it first
        }
      }
    }
  } catch {
    // pruning is best-effort
  }
}

export function loadQuote(id: string): SimQuote | null {
  try {
    return JSON.parse(readFileSync(quotePath(id), "utf8")) as SimQuote;
  } catch {
    return null;
  }
}

export function saveDeposit(dep: SimDeposit): void {
  writeAtomic(depositPath(dep.quote_id), dep);
}

export function loadDeposit(quoteId: string): SimDeposit | null {
  try {
    return JSON.parse(readFileSync(depositPath(quoteId), "utf8")) as SimDeposit;
  } catch {
    return null;
  }
}

export function listDeposits(): SimDeposit[] {
  try {
    const dir = join(worldDir(), "deposits");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf8")) as SimDeposit;
        } catch {
          return null;
        }
      })
      .filter((d): d is SimDeposit => d !== null);
  } catch {
    return [];
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function timescale(): number {
  const n = Number(process.env.OPENSWAP_TEST_TIMESCALE ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 1;
}

function defaultWorld(seed: number): WorldState {
  return {
    version: 1,
    seed,
    scenario: "happy",
    created_at: Date.now(),
    wallets: {
      [TEST_SIGNER_ADDRESS]: {
        "ETH:USDC": "10000",
        "BASE:USDC": "10000",
        "ARB:USDC": "10000",
        "ETH:ETH": "2",
        "BASE:ETH": "2",
        "BTC:BTC": "0.5"
      }
    }
  };
}

export function loadWorld(): WorldState {
  try {
    const parsed = JSON.parse(readFileSync(worldPath(), "utf8")) as WorldState;
    if (parsed && parsed.version === 1) return parsed;
  } catch {
    // fresh world below
  }
  const seed = Number(process.env.OPENSWAP_TEST_SEED ?? Date.now() % 2147483647);
  const world = defaultWorld(Number.isFinite(seed) ? seed : 1);
  saveWorld(world);
  return world;
}

export function saveWorld(world: WorldState): void {
  writeAtomic(worldPath(), world);
}

export function resetWorld(): WorldState {
  try {
    rmSync(worldDir(), { recursive: true, force: true });
  } catch {
    // nothing to remove
  }
  const seed = Number(process.env.OPENSWAP_TEST_SEED ?? Date.now() % 2147483647);
  const world = defaultWorld(Number.isFinite(seed) ? seed : 1);
  saveWorld(world);
  return world;
}

export function magicOutcome(amountDisplay: string, fallback: Scenario): Scenario {
  for (const [suffix, cfg] of Object.entries(MAGIC_AMOUNTS)) {
    if (amountDisplay.endsWith(suffix)) return cfg.outcome;
  }
  return fallback;
}

export function newQuoteId(): string {
  return randomUUID();
}

// Deterministic, format-valid, recognizably fake ("7e57" = TEST) addresses.
export function simDepositAddress(chain: string, rand: () => number): string {
  const hex = "0123456789abcdef";
  const pick = (alphabet: string, n: number): string =>
    Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
  const c = chain.toUpperCase();
  const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (c === "BTC") return `bc1q7e57${pick("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 31)}`;
  if (c === "LTC") return `ltc1q7e57${pick("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 30)}`;
  if (c === "BCH") return `q7e57${pick("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 37)}`;
  if (c === "ZEC") return `t1Z${pick(base58, 32)}`;
  if (c === "SOL") return `7e57${pick(base58, 39)}`;
  if (c === "DOGE") return `D7${pick(base58, 30)}`;
  if (c === "XRP") return `r7e57${pick(base58, 28)}`;
  if (c === "TRX") return `T7e57${pick(base58, 29)}`;
  if (c === "ATOM") return `cosmos17e57${pick("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 27)}`;
  if (c === "THOR") return `thor17e57${pick("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 29)}`;
  if (c === "DOT") return `17e57${pick(base58, 42)}`;
  if (c === "NEAR") return `7e57${pick("0123456789abcdef", 40)}`;
  return `0x7e57${pick(hex, 36)}`; // EVM family + sensible default
}

// ── Time-driven status machine ──────────────────────────────────────────
// Millisecond offsets from payment, divided by OPENSWAP_TEST_TIMESCALE so
// agent fleets can run the same story at 10-100x speed.
const STAGES_MS = { confirming: 5000, swapping: 12000, sending: 20000, success: 26000 };
const AUTOPAY_MS = 8000;
const FAIL_AT_MS = 18000;
const REFUND_AT_MS = 20000;

export type SimStatusState = "pending" | "confirming" | "swapping" | "sending" | "success" | "failed" | "refunded";

export function effectivePaidAt(dep: SimDeposit, now: number): number | null {
  if (dep.paid_at !== null) return dep.paid_at;
  if (dep.outcome === "expire") return null; // never auto-pays; window lapses
  // Autopay is a historical fact once its moment passes — no upper bound.
  // (A bound here made a SUCCEEDED swap revert to "pending" when statused
  // late, e.g. an agent polling >26s after creation at high timescale.)
  const autopayAt = dep.created_at + AUTOPAY_MS / timescale();
  return now >= autopayAt ? autopayAt : null;
}

export function depositStatus(dep: SimDeposit, now = Date.now()): {
  state: SimStatusState;
  dest_tx_hash: string | null;
  refund_tx_hash: string | null;
  out_amount: string | null;
  error: string | null;
} {
  const paidAt = effectivePaidAt(dep, now);
  const ts = timescale();
  if (paidAt === null) {
    return { state: "pending", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: null };
  }
  const elapsed = (now - paidAt) * ts;
  const slowFactor = dep.outcome === "slow" ? 3 : 1;
  if (dep.outcome === "fail" && elapsed >= FAIL_AT_MS) {
    return { state: "failed", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: "Simulated protocol failure (magic amount .13)" };
  }
  if (dep.outcome === "refund" && elapsed >= REFUND_AT_MS) {
    return { state: "refunded", dest_tx_hash: null, refund_tx_hash: `0x7e57refund${dep.quote_id.slice(0, 8)}`, out_amount: null, error: null };
  }
  if (elapsed >= STAGES_MS.success * slowFactor) {
    return {
      state: "success",
      dest_tx_hash: `0x7e57de57${dep.quote_id.replace(/-/g, "").slice(0, 32)}`,
      refund_tx_hash: null,
      out_amount: null, // filled by the server from out_base_units
      error: null
    };
  }
  if (elapsed >= STAGES_MS.sending * slowFactor) return { state: "sending", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: null };
  if (elapsed >= STAGES_MS.swapping * slowFactor) return { state: "swapping", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: null };
  if (elapsed >= STAGES_MS.confirming * slowFactor) return { state: "confirming", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: null };
  return { state: "pending", dest_tx_hash: null, refund_tx_hash: null, out_amount: null, error: null };
}

export function fixtureFor(identifier: string): FixtureAsset | undefined {
  return FIXTURE_ASSETS.find((a) => a.identifier.toLowerCase() === identifier.toLowerCase());
}
