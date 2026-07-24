import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDir, isTestMode } from "./paths.js";
import { CliError } from "./errors.js";

// A local footgun guard, not a security boundary: it stops runaway loops and
// buggy scripts from hammering deposit-address creation from this machine.
// (A determined abuser bypasses any client-side limit by calling the API
// directly — the real limits live at the edge and in the key kill switch.)
const WINDOW_MS = 10 * 60_000;
const MAX_IN_WINDOW = 15;

function throttlePath(): string {
  return join(dataDir(), "deposit-throttle.json");
}

function readStamps(): number[] {
  try {
    const parsed = JSON.parse(readFileSync(throttlePath(), "utf8")) as number[];
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "number") : [];
  } catch {
    return [];
  }
}

export function checkDepositThrottle(now = Date.now()): void {
  if (isTestMode()) return; // simulated deposits are free by definition
  if (process.env.OPENSWAP_NO_THROTTLE === "1") return; // accidents don't set overrides
  const recent = readStamps().filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_IN_WINDOW) {
    const oldest = Math.min(...recent);
    const waitS = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    throw new CliError(
      "VALIDATION",
      `Easy there — ${recent.length} deposit addresses created from this machine in the last 10 minutes. This guard catches runaway loops; it clears in ~${waitS}s.`,
      {
        retryable: true,
        actions: [{ label: "Intentional high volume? Set OPENSWAP_NO_THROTTLE=1 (and consider your own API key)" }]
      }
    );
  }
  recent.push(now);
  ensureDir(dataDir());
  const tmp = `${throttlePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(recent), { mode: 0o600 });
  renameSync(tmp, throttlePath());
}
