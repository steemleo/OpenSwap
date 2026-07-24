import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { childEnv, configDir, ensureDir } from "./paths.js";
import { CliError } from "./errors.js";

// Zero-setup default identity — the LeoKit community client key. Intentionally
// public (ships in this source); it grants quote/prepare access only — never
// custody. A personal or integrator key (env or keychain) always overrides it,
// and integrators (or forks!) using their own key earn their own affiliate fees.
export const COMMUNITY_API_KEY = "0af0a156-32ad-4a4c-88a8-ee7c8b132648";

export type CredentialSource = "flagfile" | "env" | "keychain" | "community" | "none";

export interface ResolvedCredential {
  key: string;
  source: CredentialSource;
}

const KEYCHAIN_SERVICE = "openswap-cli";
const LEGACY_KEYCHAIN_SERVICE = "leokit-cli"; // pre-rename installs
const KEYCHAIN_ACCOUNT = "api-key";

export function redactKey(key: string): string {
  if (key.length <= 4) return "••••";
  return `••••${key.slice(-4)}`;
}

function fallbackFile(): string {
  return join(configDir(), "credentials.json");
}

function readKeychainMacService(service: string): string | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: childEnv() }
    );
    const key = out.trim();
    return key || null;
  } catch {
    return null;
  }
}

function readKeychainMac(): string | null {
  return readKeychainMacService(KEYCHAIN_SERVICE) ?? readKeychainMacService(LEGACY_KEYCHAIN_SERVICE);
}

// Keys stored via the stdin grammar must have a boring charset — a crafted
// "key" with quotes/newlines could otherwise smuggle a second `security`
// subcommand. Anything unusual falls back to the 0600 credential file.
const KEYCHAIN_SAFE_KEY = /^[A-Za-z0-9._-]{8,256}$/;

// `security -i` reads commands from stdin, keeping the secret out of argv/ps.
function writeKeychainMac(key: string): boolean {
  if (!KEYCHAIN_SAFE_KEY.test(key)) return false;
  const script = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${JSON.stringify(key)}\n`;
  const res = spawnSync("security", ["-i"], { input: script, encoding: "utf8", env: childEnv() });
  return res.status === 0;
}

function deleteKeychainMac(): void {
  for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
    spawnSync("security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT], {
      stdio: "ignore",
      env: childEnv()
    });
  }
}

function readSecretToolLinux(): string | null {
  for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
    try {
      const out = execFileSync("secret-tool", ["lookup", "service", service, "account", KEYCHAIN_ACCOUNT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnv()
      });
      const key = out.trim();
      if (key) return key;
    } catch {
      // try the next service name
    }
  }
  return null;
}

function writeSecretToolLinux(key: string): boolean {
  const res = spawnSync(
    "secret-tool",
    ["store", "--label", "OpenSwap CLI API key", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
    { input: key, encoding: "utf8", env: childEnv() }
  );
  return res.status === 0;
}

function readFallbackFile(): string | null {
  try {
    const path = fallbackFile();
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      // group/world-readable secret file — refuse to use it
      throw new CliError(
        "CONFIG",
        `Credential file ${path} is readable by other users. Run: chmod 600 "${path}"`,
        { actions: [{ label: "Fix permissions", command: `chmod 600 "${path}"` }] }
      );
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { api_key?: string };
    return parsed.api_key?.trim() || null;
  } catch (err) {
    if (err instanceof CliError) throw err;
    return null;
  }
}

function writeFallbackFile(key: string): void {
  ensureDir(configDir());
  const path = fallbackFile();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ api_key: key }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readStoredKey(): string | null {
  const os = platform();
  if (os === "darwin") {
    const key = readKeychainMac();
    if (key) return key;
  } else if (os === "linux") {
    const key = readSecretToolLinux();
    if (key) return key;
  }
  return readFallbackFile();
}

export interface StoreResult {
  backend: "keychain" | "secret-service" | "file";
}

export function storeKey(key: string): StoreResult {
  const os = platform();
  if (os === "darwin" && writeKeychainMac(key)) return { backend: "keychain" };
  if (os === "linux" && writeSecretToolLinux(key)) return { backend: "secret-service" };
  writeFallbackFile(key);
  return { backend: "file" };
}

export function clearStoredKey(): void {
  if (platform() === "darwin") deleteKeychainMac();
  if (platform() === "linux") {
    spawnSync("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT], {
      stdio: "ignore"
    });
  }
  try {
    unlinkSync(fallbackFile());
  } catch {
    // nothing stored in the fallback file
  }
}

// Resolution ladder: env (OPENSWAP_API_KEY, or LEOKIT_API_KEY — the key IS a
// LeoKit API key) > keychain (personal/integrator) > community (zero-setup
// default). Flags never carry secrets.
export function resolveCredential(): ResolvedCredential {
  const env = (process.env.OPENSWAP_API_KEY ?? process.env.LEOKIT_API_KEY)?.trim();
  if (env) return { key: env, source: "env" };
  const stored = readStoredKey();
  if (stored) return { key: stored, source: "keychain" };
  if (COMMUNITY_API_KEY) return { key: COMMUNITY_API_KEY, source: "community" };
  return { key: "", source: "none" };
}

export function requireCredential(): ResolvedCredential {
  const cred = resolveCredential();
  if (cred.source === "none") {
    throw new CliError("AUTH_REQUIRED", "LeoKit needs an API key for this request.", {
      actions: [
        { label: "Store your key securely", command: "openswap auth login" },
        { label: "Or set it for this shell", command: "export OPENSWAP_API_KEY=…" }
      ]
    });
  }
  return cred;
}
