import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { LeoKitApi } from "../core/api.js";
import { resolveApiUrl } from "../cli-context.js";
import {
  clearStoredKey,
  redactKey,
  resolveCredential,
  storeKey
} from "../core/credentials.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, dim, ok } from "../render/theme.js";
import { guardCancel } from "./shared.js";

// Cheap key validation: /quote without params passes the client gate first.
// A handler-side JSON error means the key is valid; 401/403 means it is not.
async function validateKey(apiUrl: string, key: string): Promise<boolean> {
  try {
    const api = new LeoKitApi({ apiKey: key, baseUrl: apiUrl, timeoutMs: 15000 });
    await api.getQuote({ from_asset: "", to_asset: "", amount: "" });
    return true;
  } catch (err) {
    if (err instanceof CliError && err.code === "AUTH_INVALID") return false;
    if (err instanceof CliError && (err.code === "UPSTREAM" || err.code === "VALIDATION")) return true;
    throw err;
  }
}

const login = defineCommand({
  meta: { name: "login", description: "Store your LeoKit API key securely in the OS keychain" },
  args: {
    json: { type: "boolean" }, "no-input": { type: "boolean" }, "no-color": { type: "boolean" },
    "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("auth login", args);
    try {
      if (ctx.noInput) {
        throw new CliError(
          "USAGE",
          "auth login is interactive by design (keys are never accepted as flags). For CI and bots, set OPENSWAP_API_KEY in the environment.",
        );
      }
      const apiUrl = resolveApiUrl(args);
      p.intro(header("sign in"));
      p.log.message(
        [
          "Your API key identifies you to LeoKit. It is stored in the OS keychain,",
          "never in plain config, shell history, or command arguments.",
          "",
          `${dim("Building an app or a bot? Your own key routes affiliate fees to you.")}`,
          `${dim("Create one free at https://dash.leokit.dev — sign in with Google or GitHub.")}`
        ].join("\n")
      );
      const key = guardCancel(
        await p.password({
          message: "Paste your LeoKit API key",
          validate: (v) => (v && v.trim().length >= 8 ? undefined : "That doesn't look like an API key")
        })
      ).trim();

      const s = p.spinner();
      s.start("Validating with LeoKit");
      const valid = await validateKey(apiUrl, key);
      if (!valid) {
        s.stop("LeoKit rejected this key", 1);
        throw new CliError("AUTH_INVALID", "The key was rejected. Check it is active, then try again.", {
          actions: [{ label: "Check credential state", command: "openswap auth status" }]
        });
      }
      const stored = storeKey(key);
      s.stop("Key validated");
      const where =
        stored.backend === "keychain"
          ? "macOS Keychain"
          : stored.backend === "secret-service"
            ? "system secret service"
            : "a permission-restricted local file (no OS keychain available)";
      p.outro(`${ok("Signed in.")} Credential stored in ${where}. ${dim(`(${redactKey(key)})`)}`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const status = defineCommand({
  meta: { name: "status", description: "Show which credential the CLI is using" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "api-url": { type: "string" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("auth status", args);
    try {
      const cred = resolveCredential();
      const apiUrl = resolveApiUrl(args);
      let valid: boolean | null = null;
      if (cred.source !== "none") {
        valid = await validateKey(apiUrl, cred.key);
      }
      const data = {
        credential_source: cred.source,
        credential: cred.source === "none" ? null : redactKey(cred.key),
        api_url: apiUrl,
        valid
      };
      if (ctx.mode === "json") {
        emitData(ctx, data, { apiUrl });
        return;
      }
      process.stdout.write(header("auth") + "\n\n");
      const sourceLabel: Record<string, string> = {
        env: `${process.env.OPENSWAP_API_KEY ? "OPENSWAP_API_KEY" : "LEOKIT_API_KEY"} environment variable`,
        keychain: "OS keychain (openswap auth login)",
        community: "built-in community access",
        flagfile: "credential file",
        none: "no credential"
      };
      process.stdout.write(`Credential   ${cred.source === "none" ? "none" : `${redactKey(cred.key)} ${dim(`via ${sourceLabel[cred.source]}`)}`}\n`);
      process.stdout.write(`API          ${apiUrl}\n`);
      if (valid !== null) {
        process.stdout.write(`Validated    ${valid ? ok("yes") : `no — LeoKit rejected this key`}\n`);
      }
      if (cred.source === "none") {
        process.stdout.write(`\nSet one: ${accent("openswap auth login")} ${dim("or")} ${accent("export OPENSWAP_API_KEY=…")}\n`);
        process.exitCode = 3;
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const logout = defineCommand({
  meta: { name: "logout", description: "Remove the stored credential from this machine" },
  args: { json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("auth logout", args);
    try {
      const before = resolveCredential();
      clearStoredKey();
      const data = { removed: before.source === "keychain" || before.source === "flagfile" };
      if (ctx.mode === "json") {
        emitData(ctx, data);
        return;
      }
      process.stdout.write(data.removed ? "Stored credential removed.\n" : "No stored credential to remove.\n");
      if (process.env.LEOKIT_API_KEY) {
        process.stdout.write(dim("Note: LEOKIT_API_KEY is still set in this shell's environment.\n"));
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "auth", description: "Manage LeoKit credentials on this machine" },
  subCommands: { login, status, logout }
});
