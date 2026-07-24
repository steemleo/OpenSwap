import { defineCommand } from "citty";
import { accessSync, constants } from "node:fs";
import { resolveApiUrl } from "../cli-context.js";
import { LeoKitApi } from "../core/api.js";
import { assetCacheAgeMs } from "../core/assets.js";
import { redactKey, resolveCredential } from "../core/credentials.js";
import { ensureDir, receiptsDir, cacheDir, configDir } from "../core/paths.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { bad, dim, glyph, ok, termCaps, warn } from "../render/theme.js";
import { VERSION } from "../version.js";
import { CliError } from "../core/errors.js";

interface Check {
  name: string;
  state: "ok" | "warn" | "fail";
  detail: string;
}

function mark(state: Check["state"]): string {
  if (state === "ok") return ok(glyph("check"));
  if (state === "warn") return warn(glyph("caution"));
  return bad(glyph("cross"));
}

export default defineCommand({
  meta: { name: "doctor", description: "Check that this machine is ready to swap" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("doctor", args);
    try {
      const checks: Check[] = [];
      const caps = termCaps();

      const nodeMajor = Number(process.versions.node.split(".")[0]);
      checks.push({
        name: "Runtime",
        state: nodeMajor >= 20 ? "ok" : "fail",
        detail: `node ${process.versions.node}${nodeMajor >= 20 ? "" : " (need ≥ 20)"} · openswap ${VERSION}`
      });

      checks.push({
        name: "Terminal",
        state: "ok",
        detail: `${caps.isTTY ? "interactive" : "non-interactive"} · ${caps.depth} color · ${caps.unicode ? "unicode" : "ascii"} · ${caps.columns} cols`
      });

      const cred = resolveCredential();
      checks.push({
        name: "Credential",
        state: cred.source === "none" ? "warn" : "ok",
        detail:
          cred.source === "none"
            ? "none found — run `openswap auth login` or set OPENSWAP_API_KEY"
            : `${redactKey(cred.key)} via ${cred.source}`
      });

      let apiUrl = "";
      try {
        apiUrl = resolveApiUrl(args);
        // any HTTP response proves reachability — auth is checked separately
        const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10000) });
        checks.push({
          name: "API reachable",
          state: "ok",
          detail: `${apiUrl} responds ${dim("(auth checked separately)")}${res.ok ? "" : ` · HTTP ${res.status}`}`
        });
      } catch (err) {
        checks.push({
          name: "API reachable",
          state: "fail",
          detail: err instanceof CliError ? err.message : `${apiUrl || "API"} unreachable`
        });
      }

      if (cred.source !== "none" && apiUrl) {
        try {
          const api = new LeoKitApi({ apiKey: cred.key, baseUrl: apiUrl, timeoutMs: 15000 });
          await api.getQuote({ from_asset: "", to_asset: "", amount: "" });
          checks.push({ name: "Credential valid", state: "ok", detail: "LeoKit accepted the key" });
        } catch (err) {
          if (err instanceof CliError && err.code === "AUTH_INVALID") {
            checks.push({ name: "Credential valid", state: "fail", detail: "LeoKit rejected the key (inactive or unknown)" });
          } else if (err instanceof CliError && (err.code === "VALIDATION" || err.code === "UPSTREAM") && err.details?.status !== 401 && err.details?.status !== 403) {
            // a non-auth complaint about our deliberately empty probe = the key passed auth
            checks.push({ name: "Credential valid", state: "ok", detail: "LeoKit accepted the key" });
          } else {
            checks.push({ name: "Credential valid", state: "warn", detail: "could not verify right now (upstream error) — not a key problem" });
          }
        }
      }

      const age = assetCacheAgeMs();
      checks.push({
        name: "Asset cache",
        state: "ok",
        detail: age === null ? "not yet built (first quote builds it)" : `${Math.round(age / 60000)} minutes old · ${cacheDir()}`
      });

      try {
        ensureDir(receiptsDir());
        accessSync(receiptsDir(), constants.W_OK);
        checks.push({ name: "Receipts", state: "ok", detail: receiptsDir() });
      } catch {
        checks.push({ name: "Receipts", state: "fail", detail: `${receiptsDir()} is not writable` });
      }
      checks.push({ name: "Config", state: "ok", detail: configDir() });

      const failed = checks.filter((c) => c.state === "fail");
      if (ctx.mode === "json") {
        // Same rule as `bot check`: an unhealthy result must not report ok:true
        // while exiting non-zero.
        if (failed.length > 0) {
          throw new CliError("CONFIG", `Setup problem: ${failed.map((c) => c.detail).join("; ")}`, {
            details: { healthy: false, checks }
          });
        }
        emitData(ctx, { healthy: true, checks });
        return;
      }
      if (ctx.mode === "human") process.stdout.write(header("doctor") + "\n\n");
      for (const c of checks) {
        process.stdout.write(`${mark(c.state)} ${c.name.padEnd(18)} ${dim(c.detail)}\n`);
      }
      process.stdout.write("\n");
      if (failed.length === 0) {
        process.stdout.write(
          `${ok("Ready.")} ${dim("Try: openswap quote --amount 100 --from arb:USDC --to btc:BTC · new here? openswap tour")}\n`
        );
      } else {
        process.stdout.write(
          `${bad(`${failed.length} check${failed.length === 1 ? "" : "s"} need attention`)} ${dim("— fixes are listed on each line above. Still stuck? openswap feedback")}\n`
        );
        process.exitCode = 3;
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
