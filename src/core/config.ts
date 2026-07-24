import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDir } from "./paths.js";
import { CliError } from "./errors.js";

export interface CliConfig {
  api_url?: string;
  default_slippage_bps?: number;
  default_from?: string;
  default_to?: string;
  receipts_dir?: string;
}

const CONFIG_KEYS: ReadonlySet<keyof CliConfig> = new Set([
  "api_url",
  "default_slippage_bps",
  "default_from",
  "default_to",
  "receipts_dir"
]);

// Secrets never live here — this file is plain JSON by design.
const SECRET_LIKE = /key|secret|token|password|mnemonic|seed/i;

function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  ensureDir(configDir());
  const tmp = configPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath());
}

export function setConfigValue(key: string, value: string): CliConfig {
  if (SECRET_LIKE.test(key)) {
    throw new CliError("USAGE", `"${key}" looks like a secret. Secrets are never stored in config — use \`openswap auth login\`.`);
  }
  if (!CONFIG_KEYS.has(key as keyof CliConfig)) {
    throw new CliError("USAGE", `Unknown config key "${key}". Known keys: ${[...CONFIG_KEYS].join(", ")}`);
  }
  const config = readConfig();
  if (key === "default_slippage_bps") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 10000) {
      throw new CliError("VALIDATION", "default_slippage_bps must be an integer between 0 and 10000.");
    }
    config.default_slippage_bps = n;
  } else {
    (config as Record<string, unknown>)[key] = value;
  }
  writeConfig(config);
  return config;
}
