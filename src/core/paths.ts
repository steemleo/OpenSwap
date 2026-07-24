import { homedir } from "node:os";
import { join } from "node:path";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";

function envDir(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

// One-time, copy-only migration from the pre-rename ("leokit") state dirs.
// The legacy directory is never modified or removed — receipts and config
// carry forward, and rolling back to an old build keeps working.
function withLegacyMigration(newDir: string, legacyDir: string): string {
  if (!existsSync(newDir) && existsSync(legacyDir)) {
    try {
      cpSync(legacyDir, newDir, { recursive: true, force: false });
    } catch {
      // a failed migration must never block the CLI
    }
  }
  return newDir;
}

// ── Test mode ───────────────────────────────────────────────────────────
// Env override (OPENSWAP_TEST_MODE=1|0) beats the persistent marker file
// written by `openswap test on`. The marker lives in the REAL config dir —
// it's how we know which world we're in, so it can never be namespaced.
export function testModeMarkerPath(): string {
  const base = envDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(base, "openswap", "test-mode.on");
}

export function isTestMode(): boolean {
  const env = process.env.OPENSWAP_TEST_MODE;
  if (env === "1") return true;
  if (env === "0") return false;
  try {
    return existsSync(testModeMarkerPath());
  } catch {
    return false;
  }
}

// Simulated state lives in a sibling namespace — real receipts, cache, and
// counters are untouchable from test mode, and vice versa.
function maybeTestNamespace(dir: string): string {
  return isTestMode() ? join(dir, "test-mode") : dir;
}

export function configDir(): string {
  const base = envDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return withLegacyMigration(join(base, "openswap"), join(base, "leokit"));
}

export function cacheDir(): string {
  const base = envDir("XDG_CACHE_HOME") ?? join(homedir(), ".cache");
  return maybeTestNamespace(withLegacyMigration(join(base, "openswap"), join(base, "leokit")));
}

export function dataDir(): string {
  const base = envDir("XDG_DATA_HOME") ?? join(homedir(), ".local", "share");
  return maybeTestNamespace(withLegacyMigration(join(base, "openswap"), join(base, "leokit")));
}

export function receiptsDir(): string {
  return join(dataDir(), "receipts");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Minimal environment for spawned helpers (clipboard, keychain): children
// never inherit OPENSWAP_EVM_PRIVATE_KEY / keystore passphrases / API keys.
// Display + DBus vars stay so secret-tool and wl-copy keep working.
export function childEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

// "First run" = no receipts and no saved config yet — used only to reorder
// menu suggestions (never to gate features), so a wrong answer is harmless.
export function isFirstRun(): boolean {
  try {
    const receipts = receiptsDir();
    const hasReceipts = existsSync(receipts) && readdirSync(receipts).some((f) => f.endsWith(".json"));
    const hasConfig = existsSync(join(configDir(), "config.json"));
    return !hasReceipts && !hasConfig;
  } catch {
    return false;
  }
}
