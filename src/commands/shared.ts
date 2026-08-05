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

// Enough context to turn a "use this asset instead" suggestion into a command
// the user can actually run: which side failed, and whatever we know about the
// rest of the invocation.
export interface AssetSideContext {
  side: "from" | "to";
  amount?: string;
  other?: string;
}

// The wrong-chain error's actions carry bare identifiers — meaningful to a
// human mid-prompt, but machine consumers and error blocks need something
// runnable. Rebuild each suggestion as the user's own command with the failed
// side swapped. Anything unknown is simply omitted; a partial command prompts
// for the rest.
function withRunnableSuggestions(err: unknown, ctx: OutputContext, side?: AssetSideContext): unknown {
  if (!side || !(err instanceof CliError) || err.code !== "NO_ROUTE") return err;
  if (ctx.command !== "quote" && ctx.command !== "swap") return err;
  const ids = Array.isArray(err.details?.available_elsewhere) ? (err.details!.available_elsewhere as string[]) : [];
  if (ids.length === 0) return err;
  const idSet = new Set(ids);
  const amount = side.amount ? ` -a ${side.amount}` : "";
  const actions = err.actions.map((a) => {
    if (!a.command || !idSet.has(a.command)) return a;
    const f = side.side === "from" ? a.command : side.other;
    const t = side.side === "to" ? a.command : side.other;
    return { ...a, command: `openswap ${ctx.command}${amount}${f ? ` -f ${f}` : ""}${t ? ` -t ${t}` : ""}` };
  });
  return new CliError(err.code, err.message, { retryable: err.retryable, actions, details: err.details });
}

// One recovery path for every interactive dead end. Prefer the error's own
// answer (the chains that DO carry the coin) over a text search, which cannot
// know the user's intent as precisely. Returns null when the user wants to
// type something else — the caller loops back to the prompt.
async function pickFromNoRoute(tokens: AssetToken[], typed: string, err: CliError): Promise<AssetToken | null> {
  const ids = Array.isArray(err.details?.available_elsewhere) ? (err.details!.available_elsewhere as string[]) : [];
  const elsewhere = ids
    .map((id) => tokens.find((t) => t.identifier === id))
    .filter((t): t is AssetToken => t !== undefined);
  const query = typeof err.details?.symbol_query === "string" ? err.details.symbol_query : typed;
  const options = elsewhere.length > 0 ? elsewhere : searchAssets(tokens, query, 8);
  if (options.length === 0) {
    p.log.warn(`No supported asset matches "${sanitize(typed)}". Try another symbol.`);
    return null;
  }
  const chosen = guardCancel(
    await p.select({
      message: elsewhere.length > 0 ? sanitize(err.message) : `No exact match for "${sanitize(typed)}". Close matches:`,
      options: [
        ...options.map((c) => ({ value: c.identifier, label: assetLabel(c) })),
        { value: "__again", label: "Type something else" }
      ]
    })
  );
  if (chosen === "__again") return null;
  return options.find((c) => c.identifier === chosen) ?? null;
}

export async function resolveAssetOrPrompt(
  ctx: OutputContext,
  tokens: AssetToken[],
  input: string | undefined,
  promptLabel: string,
  side?: AssetSideContext
): Promise<AssetToken> {
  if (input) {
    try {
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
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== "NO_ROUTE" || ctx.noInput) {
        throw withRunnableSuggestions(err, ctx, side);
      }
      // A --from/--to that dead-ends is not a reason to die in a TTY: the
      // error usually knows where the coin does exist, so offer that instead.
      const picked = await pickFromNoRoute(tokens, input, err);
      if (picked) {
        p.log.step(`${assetSymbol(picked.identifier)} on ${assetChain(picked.identifier)}  ${dim(picked.identifier)}`);
        return picked;
      }
      // the user asked to type something else — fall through to the prompt
    }
  } else if (ctx.noInput) {
    throw new CliError("USAGE", `Missing required asset. Pass --from and --to (e.g. --from arb:USDC --to btc:BTC).`);
  }

  // free-text with live resolution; a recovery select keeps the user moving
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
        const picked = await pickFromNoRoute(tokens, typed, err);
        if (picked) return picked;
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
