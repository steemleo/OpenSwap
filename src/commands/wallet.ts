import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { defaultKeystorePath, signerConfigured, SIGNER_ONLY_EXAMPLES } from "../core/chains.js";
import { encryptKeystoreV3, keystoreAddress } from "../core/signer/keystore.js";
import { ensureDir, configDir } from "../core/paths.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput, type OutputContext } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, glyph, ok, warn } from "../render/theme.js";
import { emphasizeAddress } from "../render/money.js";
import { guardCancel } from "./shared.js";

// The signing wallet unlocks routes that have no deposit-address support.
// Security model: the RECOMMENDED path generates a fresh dedicated wallet —
// the user's main wallet key never enters this CLI. Import exists for power
// users, hidden-prompt only, encrypted immediately, never stored plaintext.

async function askPassphrase(): Promise<string> {
  while (true) {
    const a = guardCancel(
      await p.password({
        message: "Choose a keystore passphrase (asked each time you sign)",
        validate: (v) => ((v ?? "").length >= 8 ? undefined : "At least 8 characters")
      })
    );
    const b = guardCancel(await p.password({ message: "Repeat the passphrase" }));
    if (a === b) return a;
    p.log.warn("Passphrases didn't match — try again.");
  }
}

function writeKeystore(json: string): string {
  ensureDir(configDir());
  const path = defaultKeystorePath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

// Exported so the swap funnel can offer "unlock these routes" inline.
export async function setupWalletInteractive(): Promise<boolean> {
  p.log.message(
    [
      `Some routes (${SIGNER_ONLY_EXAMPLES}) have no deposit-address support —`,
      "executing them means signing transactions. A dedicated signing wallet",
      "keeps that safe: small balance, separate from your main wallet."
    ].join("\n")
  );
  if (existsSync(defaultKeystorePath())) {
    const addr = keystoreAddress(readFileSync(defaultKeystorePath(), "utf8"));
    const replace = guardCancel(
      await p.confirm({
        message: `A signing wallet already exists${addr ? ` (${addr.slice(0, 6)}…${addr.slice(-4)})` : ""} — replace it? Funds on it stay on-chain, but you'd need its key to access them.`,
        initialValue: false
      })
    );
    if (!replace) return true;
  }
  const how = guardCancel(
    await p.select({
      message: "How do you want to set it up?",
      options: [
        { value: "create", label: "Create a new signing wallet (recommended)", hint: "generated locally, encrypted, you fund it" },
        { value: "import", label: "Import an existing private key", hint: "hidden prompt → encrypted keystore; prefer a dedicated wallet" },
        { value: "env", label: "I'll manage keys myself via environment variables", hint: "prints the exact variables" },
        { value: "later", label: "Not now" }
      ]
    })
  );
  if (how === "later") return false;
  if (how === "env") {
    p.note(
      [
        `${accent("export OPENSWAP_EVM_PRIVATE_KEY=0x…")}          ${dim("hot key (simplest, least safe)")}`,
        `${accent("export OPENSWAP_EVM_KEYSTORE=/path/to/v3.json")} ${dim("encrypted keystore")}`,
        `${accent("export OPENSWAP_EVM_KEYSTORE_PASSWORD=…")}       ${dim("required for bots/CI; humans get prompted")}`
      ].join("\n"),
      "Environment-variable setup"
    );
    return false;
  }

  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  let privateKey: `0x${string}`;
  if (how === "create") {
    privateKey = generatePrivateKey();
  } else {
    p.log.warn("Importing a key makes this machine able to spend from that wallet. A dedicated low-balance wallet is safer than your main one.");
    privateKey = guardCancel(
      await p.password({
        message: "Private key (0x + 64 hex — hidden, encrypted immediately, never stored in plain text)",
        validate: (v) => (/^0x[0-9a-fA-F]{64}$/.test((v ?? "").trim()) ? undefined : "Must be 0x followed by 64 hex characters")
      })
    ).trim() as `0x${string}`;
  }
  const account = privateKeyToAccount(privateKey);
  const passphrase = await askPassphrase();
  const path = writeKeystore(encryptKeystoreV3(privateKey, passphrase, account.address));

  p.log.success(`${ok("Signing wallet ready.")} ${dim(path)}`);
  p.note(
    [
      `Address   ${emphasizeAddress(account.address, (s) => bold(s))}`,
      "",
      `${how === "create" ? "Fund it on the chain you'll swap from (start small — it only ever" : "It signs from your imported wallet (keep the balance small — it only"}`,
      `${how === "create" ? "needs what you're actively trading)." : "needs what you're actively trading)."}`,
      `Unlocks: ${SIGNER_ONLY_EXAMPLES} — and every future EVM route.`,
      `Your passphrase is asked at each signing and never stored.`
    ].join("\n"),
    "Your signing wallet"
  );
  return true;
}

const setup = defineCommand({
  meta: { name: "setup", description: "Set up a signing wallet — unlocks routes without deposit-address support" },
  args: { json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("wallet setup", args);
    try {
      if (ctx.noInput) {
        throw new CliError(
          "USAGE",
          "wallet setup is interactive by design (keys and passphrases never travel through flags). For machines, set OPENSWAP_EVM_PRIVATE_KEY or OPENSWAP_EVM_KEYSTORE + OPENSWAP_EVM_KEYSTORE_PASSWORD."
        );
      }
      p.intro(header("signing wallet"));
      const configured = await setupWalletInteractive();
      p.outro(
        configured
          ? `Try it: ${accent("openswap swap")} ${dim("— wallet-signed routes are now selectable")}`
          : dim("No changes made. Come back any time: openswap wallet setup")
      );
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const status = defineCommand({
  meta: { name: "status", description: "Show the configured signing wallet and what it unlocks" },
  args: { json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("wallet status", args);
    try {
      const envKey = Boolean(process.env.OPENSWAP_EVM_PRIVATE_KEY || process.env.LEOKIT_EVM_PRIVATE_KEY);
      const envKeystore = (process.env.OPENSWAP_EVM_KEYSTORE ?? process.env.LEOKIT_EVM_KEYSTORE)?.trim();
      const defaultExists = existsSync(defaultKeystorePath());
      let source: string = "none";
      let address: string | null = null;
      if (envKey) {
        source = "env-private-key";
        const { privateKeyToAccount } = await import("viem/accounts");
        try {
          address = privateKeyToAccount((process.env.OPENSWAP_EVM_PRIVATE_KEY ?? process.env.LEOKIT_EVM_PRIVATE_KEY) as `0x${string}`).address;
        } catch {
          address = null;
        }
      } else if (envKeystore) {
        source = "env-keystore";
        try { address = keystoreAddress(readFileSync(envKeystore, "utf8")); } catch { address = null; }
      } else if (defaultExists) {
        source = "keystore";
        address = keystoreAddress(readFileSync(defaultKeystorePath(), "utf8"));
      }
      const data = {
        configured: signerConfigured(),
        source,
        address,
        keystore_path: source === "keystore" ? defaultKeystorePath() : envKeystore ?? null,
        unlocks: `wallet-signed routes (${SIGNER_ONLY_EXAMPLES}) on EVM source chains`
      };
      if (ctx.mode === "json") { emitData(ctx, data); return; }
      process.stdout.write(header("signing wallet") + "\n\n");
      if (!data.configured) {
        process.stdout.write(`${warn(glyph("caution"))} No signing wallet configured — routes without deposit-address support (${SIGNER_ONLY_EXAMPLES}) stay locked.\n`);
        process.stdout.write(`\nSet one up: ${accent("openswap wallet setup")}\n`);
        return;
      }
      process.stdout.write(`Source     ${data.source}\n`);
      if (address) process.stdout.write(`Address    ${emphasizeAddress(address, (s) => bold(s))}\n`);
      if (data.keystore_path) process.stdout.write(`Keystore   ${dim(data.keystore_path)}\n`);
      process.stdout.write(`Unlocks    ${data.unlocks}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

// Human-mode passphrase bridge: called by the swap funnel before signing when
// a keystore is in play and no password env is set. The passphrase is RETURNED
// and threaded in-memory to loadEvmSigner — never written into process.env,
// where every spawned child (clipboard, keychain) would inherit it.
export async function ensureSignerPassphrase(ctx: OutputContext): Promise<string | undefined> {
  const passwordSet = Boolean(process.env.OPENSWAP_EVM_KEYSTORE_PASSWORD ?? process.env.LEOKIT_EVM_KEYSTORE_PASSWORD);
  const keyEnvSet = Boolean(process.env.OPENSWAP_EVM_PRIVATE_KEY || process.env.LEOKIT_EVM_PRIVATE_KEY);
  const keystoreInPlay = Boolean(
    (process.env.OPENSWAP_EVM_KEYSTORE ?? process.env.LEOKIT_EVM_KEYSTORE)?.trim() || existsSync(defaultKeystorePath())
  );
  if (keyEnvSet || passwordSet || !keystoreInPlay) return undefined;
  if (ctx.noInput) {
    throw new CliError("SIGNER_UNAVAILABLE", "Keystore passphrase required: set OPENSWAP_EVM_KEYSTORE_PASSWORD in machine mode.");
  }
  return guardCancel(await p.password({ message: "Keystore passphrase" }));
}

export default defineCommand({
  meta: { name: "wallet", description: "The optional signing wallet — unlocks routes without deposit-address support" },
  subCommands: { setup, status }
});
