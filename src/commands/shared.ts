import * as p from "@clack/prompts";
import type { LeoKitApi } from "../core/api.js";
import { loadAssets, popularAssets, resolveAsset, searchAssets } from "../core/assets.js";
import { parseDecimalInput } from "../core/amount.js";
import { CliError } from "../core/errors.js";
import type { AssetToken } from "../core/types.js";
import type { OutputContext } from "../render/output.js";
import { assetChain, assetSymbol, sanitize } from "../render/money.js";
import { dim } from "../render/theme.js";

// Ctrl-C / cancel inside a prompt exits calmly with the conventional 130.
export function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Nothing was sent. Come back any time.");
    process.exit(130);
  }
  return value as T;
}

export function assetLabel(t: AssetToken): string {
  // ≈ because price_usd is the API's indicative price (it can lag the market;
  // no freshness field exists on /assets) — swap rates come from live quotes.
  const price = t.price_usd ? dim(`  ≈ $${t.price_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`) : "";
  return `${sanitize(t.symbol)} on ${sanitize(t.blockchain)}${price}`;
}

export async function resolveAssetOrPrompt(
  ctx: OutputContext,
  tokens: AssetToken[],
  input: string | undefined,
  promptLabel: string
): Promise<AssetToken> {
  if (input) {
    const res = resolveAsset(tokens, input);
    if ("token" in res) return res.token;
    if (ctx.noInput) {
      throw new CliError(
        "VALIDATION",
        `"${input}" matches several assets: ${res.candidates
          .slice(0, 6)
          .map((c) => c.identifier)
          .join(", ")}. Use the full identifier (CHAIN.SYMBOL-ADDRESS) or chain:symbol.`
      );
    }
    const chosen = guardCancel(
      await p.select({
        message: `"${sanitize(input)}" exists on several networks — which one?`,
        options: res.candidates.slice(0, 10).map((c) => ({ value: c.identifier, label: assetLabel(c) }))
      })
    );
    const picked = res.candidates.find((c) => c.identifier === chosen);
    if (!picked) throw new CliError("INTERNAL", "Selection did not match a candidate.");
    return picked;
  }

  if (ctx.noInput) {
    throw new CliError("USAGE", `Missing required asset. Pass --from and --to (e.g. --from arb:USDC --to btc:BTC).`);
  }

  // free-text with live resolution; a search fallback keeps the user moving
  while (true) {
    const typed = guardCancel(
      await p.text({
        message: promptLabel,
        placeholder: "e.g. USDC, base usdc, usdc on base, or BTC.BTC",
        validate: (v) => (v && v.trim() ? undefined : "Type an asset symbol")
      })
    );
    try {
      const res = resolveAsset(tokens, typed.trim());
      if ("token" in res) {
        p.log.step(`${assetSymbol(res.token.identifier)} on ${assetChain(res.token.identifier)}  ${dim(res.token.identifier)}`);
        return res.token;
      }
      const chosen = guardCancel(
        await p.select({
          message: `"${sanitize(typed)}" exists on several networks — which one?`,
          options: res.candidates.slice(0, 10).map((c) => ({ value: c.identifier, label: assetLabel(c) }))
        })
      );
      const picked = res.candidates.find((c) => c.identifier === chosen);
      if (picked) return picked;
    } catch (err) {
      if (err instanceof CliError && err.code === "NO_ROUTE") {
        const suggestions = searchAssets(tokens, typed, 8);
        if (suggestions.length > 0) {
          const chosen = guardCancel(
            await p.select({
              message: `No exact match for "${sanitize(typed)}". Close matches:`,
              options: [
                ...suggestions.map((c) => ({ value: c.identifier, label: assetLabel(c) })),
                { value: "__again", label: "Type something else" }
              ]
            })
          );
          if (chosen !== "__again") {
            const picked = suggestions.find((c) => c.identifier === chosen);
            if (picked) return picked;
          }
          continue;
        }
        p.log.warn(`No supported asset matches "${sanitize(typed)}". Try another symbol.`);
        continue;
      }
      throw err;
    }
  }
}

export async function amountOrPrompt(
  ctx: OutputContext,
  input: string | undefined,
  fromToken: AssetToken
): Promise<string> {
  if (input) return parseDecimalInput(input);
  if (ctx.noInput) {
    throw new CliError("USAGE", "Missing required --amount (a decimal amount of the source asset).");
  }
  const typed = guardCancel(
    await p.text({
      message: `How much ${sanitize(fromToken.symbol)} do you want to send?`,
      placeholder: "e.g. 100",
      validate: (v) => {
        try {
          parseDecimalInput(v ?? "");
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid amount";
        }
      }
    })
  );
  return parseDecimalInput(typed);
}

export async function loadAssetsWithSpinner(
  ctx: OutputContext,
  api: LeoKitApi,
  opts: { forceRefresh?: boolean } = {}
): Promise<AssetToken[]> {
  if (ctx.noInput || ctx.mode !== "human") {
    return loadAssets(api, opts);
  }
  const s = p.spinner();
  s.start("Loading supported assets");
  try {
    const tokens = await loadAssets(api, opts);
    s.stop(`${tokens.length.toLocaleString("en-US")} assets available`);
    return tokens;
  } catch (err) {
    s.stop("Could not load assets", 1);
    throw err;
  }
}

export { popularAssets };

// ── satisfaction pulse (minimal, Claude Code-style) ─────────────────────────
// One keypress to ignore: "Skip" is the initial selection, Enter dismisses.
export async function maybeAskPulse(ctx: OutputContext): Promise<void> {
  if (ctx.mode !== "human" || ctx.noInput || !process.stdout.isTTY) return;
  const { isTestMode } = await import("../core/paths.js");
  if (isTestMode()) return; // simulated sessions never count toward the pulse
  const { recordSuccess, optOut, pulseMessage } = await import("../core/pulse.js");
  if (!recordSuccess()) return;
  try {
    type PulseChoice = "skip" | "never" | 1 | 2 | 3;
    const rating = guardCancel(
      await p.select<PulseChoice>({
        message: dim("How's OpenSwap doing?"),
        options: [
          { value: "skip", label: dim("Skip") },
          { value: 3, label: "3 · great" },
          { value: 2, label: "2 · fine" },
          { value: 1, label: "1 · rough" },
          { value: "never", label: dim("Don't ask again") }
        ]
      })
    );
    if (rating === "skip") return;
    if (rating === "never") {
      optOut();
      return;
    }
    const comment = guardCancel(
      await p.text({ message: dim("Anything to add? (Enter to send as-is)"), defaultValue: "", placeholder: "optional" })
    );
    const { buildFeedbackReport, submitFeedback, saveToOutbox } = await import("../core/feedback.js");
    const report = buildFeedbackReport({
      kind: rating <= 1 ? "bug" : "feature",
      message: pulseMessage(rating as 1 | 2 | 3, comment ?? ""),
      includeDiagnostics: false
    });
    try {
      await submitFeedback(report);
      p.log.message(dim("Thanks — sent."));
    } catch {
      saveToOutbox(report);
      p.log.message(dim("Saved — sends with your next feedback."));
    }
  } catch {
    // the pulse must never break a command
  }
}
