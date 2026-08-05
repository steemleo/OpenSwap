import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { buildApi } from "../cli-context.js";
import { quoteSetToJson, recommendationReason, streamQuoteSet } from "../core/quotes.js";
import { enrichNoRoute } from "../core/alternatives.js";
import { formatAmountForDisplay } from "../core/amount.js";
import { resolveOutput, emitData, failWith } from "../render/output.js";
import { header, routeCard, hr } from "../render/components.js";
import { accent, dim, bold } from "../render/theme.js";
import { assetSymbol, sanitize } from "../render/money.js";
import { amountOrPrompt, guardCancel, loadAssetsWithSpinner, resolveAssetOrPrompt } from "./shared.js";
import type { QuoteSet } from "../core/types.js";

export const sharedQuoteArgs = {
  amount: { type: "string" as const, alias: "a", description: "Amount to send (decimal, e.g. 100)" },
  from: { type: "string" as const, alias: "f", description: "Source asset (USDC, base:USDC, or CHAIN.SYMBOL-ADDRESS)" },
  to: { type: "string" as const, alias: "t", description: "Destination asset" },
  "slippage-bps": { type: "string" as const, description: "Slippage tolerance in basis points (route-dependent)" },
  json: { type: "boolean" as const, description: "Versioned JSON result on stdout (implies --no-input)" },
  plain: { type: "boolean" as const, description: "Deterministic plain text without ANSI" },
  "no-input": { type: "boolean" as const, description: "Never prompt; missing input is an error" },
  "no-color": { type: "boolean" as const, description: "Disable color output" },
  "api-url": { type: "string" as const, description: "Override API endpoint (localhost only, for development)" },
  refresh: { type: "boolean" as const, description: "Refresh the local asset cache" },
  deposit: { type: "boolean" as const, description: "Only routes executable by deposit address (what `swap` can run)" }
};

export function renderQuoteSetHuman(set: QuoteSet, opts: { depositOnly?: boolean } = {}): string[] {
  const lines: string[] = [];
  const toSym = assetSymbol(set.toAsset);
  const fromSym = assetSymbol(set.fromAsset);
  lines.push("");
  lines.push(
    `${bold(`${set.amountDisplay} ${fromSym}`)} ${dim("on")} ${sanitize(set.fromAsset.split(".")[0] ?? "")} ${accent("→")} ${bold(toSym)} ${dim("on")} ${sanitize(set.toAsset.split(".")[0] ?? "")}`
  );
  lines.push(dim(`${set.offers.length} route${set.offers.length === 1 ? "" : "s"} ${opts.depositOnly ? "with deposit-address support " : ""}· sorted by amount received`));
  lines.push("");
  set.offers.forEach((offer, i) => {
    lines.push(...routeCard(offer, { index: i + 1, selected: i === 0, toSymbol: toSym }));
    lines.push("");
  });
  return lines;
}

export function renderQuoteSetPlain(set: QuoteSet): string[] {
  const lines: string[] = [];
  lines.push(`quote_id\t${set.quoteId}`);
  lines.push(`pair\t${set.amountDisplay} ${set.fromAsset} -> ${set.toAsset}`);
  lines.push("protocol\texpected_receive\tusd\tfees_usd\teta_seconds\texpires_at\tdeposit_address_support\tflags");
  for (const o of set.offers) {
    const flags = [o.flags.bestOutput && "best-output", o.flags.fastest && "fastest", o.flags.cheapest && "cheapest"]
      .filter(Boolean)
      .join(",");
    lines.push(
      [
        o.protocol,
        o.expectedOutDisplay,
        o.expectedOutUsd ?? "",
        o.feesTotalUsd ?? "incomplete",
        o.etaSeconds ?? "",
        o.expiresAt,
        o.supportsDepositAddress === null ? "unknown" : o.supportsDepositAddress ? "yes" : "no",
        flags
      ].join("\t")
    );
  }
  return lines;
}

export default defineCommand({
  meta: {
    name: "quote",
    description: "Compare crosschain routes for a pair — read-only, no wallet needed"
  },
  args: sharedQuoteArgs,
  async run({ args }) {
    const ctx = resolveOutput("quote", args);
    try {
      const { api, apiUrl } = buildApi(args);
      if (ctx.mode === "human") {
        p.intro(header("routes"));
      }
      const tokens = await loadAssetsWithSpinner(ctx, api, { forceRefresh: args.refresh === true });
      const fromToken = await resolveAssetOrPrompt(ctx, tokens, args.from, "What do you want to send?", {
        side: "from", amount: args.amount, other: args.to
      });
      const toToken = await resolveAssetOrPrompt(ctx, tokens, args.to, "What do you want to receive?", {
        side: "to", amount: args.amount, other: fromToken.identifier
      });
      const amount = await amountOrPrompt(ctx, args.amount, fromToken);

      const slippage = args["slippage-bps"] ? Number(args["slippage-bps"]) : undefined;
      // Streamed like leodex.io: every provider gets its window, offers appear
      // as they settle, and the full round is stable + reusable downstream.
      const spin = ctx.mode === "human" ? p.spinner() : null;
      spin?.start("Streaming routes from every provider");
      let set;
      try {
        set = await streamQuoteSet(
          api,
          { from_asset: fromToken.identifier, to_asset: toToken.identifier, amount, slippage_bps: slippage },
          {
            depositOnly: args.deposit === true,
            onOffer: (o, n) => spin?.message(`Streaming routes — ${n} found (${sanitize(o.protocol)} just arrived)`),
            onRetry: () => spin?.message("Connection hiccup — retrying")
          }
        );
        spin?.stop(`${set.offers.length} route${set.offers.length === 1 ? "" : "s"} found`);
      } catch (err) {
        // "No routes" on a connection failure blames the pair for a network
        // problem and sends the user hunting for a different asset.
        const noRoute = err instanceof Error && "code" in err && err.code === "NO_ROUTE";
        spin?.stop(noRoute ? "No routes" : "Could not fetch routes", 1);
        throw await enrichNoRoute(err, {
          api,
          tokens,
          from: fromToken,
          to: toToken,
          amount,
          command: "quote",
          depositOnly: args.deposit === true,
          onStart: () => spin?.start("Looking for a pair that does route"),
          onDone: (n) => spin?.stop(n > 0 ? `${n} alternative${n === 1 ? "" : "s"} found` : "No alternative found", n > 0 ? 0 : 1)
        });
      }

      if (ctx.mode === "json") {
        emitData(ctx, quoteSetToJson(set), { apiUrl });
        return;
      }
      if (ctx.mode === "plain") {
        process.stdout.write(renderQuoteSetPlain(set).join("\n") + "\n");
        return;
      }

      process.stdout.write(renderQuoteSetHuman(set, { depositOnly: args.deposit === true }).join("\n") + "\n");
      const best = set.offers[0]!;
      process.stdout.write(
        `${dim("Top route:")} ${sanitize(best.protocol)} ${dim(`— ${recommendationReason(best, set.offers.length)}`)}\n`
      );
      process.stdout.write(hr() + "\n");
      {
        const { executionLane, signerConfigured, signerLaneEnabled } = await import("../core/quotes.js");
        const locked = set.offers.filter((o) => executionLane(o, fromToken.identifier) === "wallet_signed");
        const lockedNames = locked.map((o) => sanitize(o.protocol)).join(", ");
        const has = locked.length === 1 ? "has" : "have";
        // Never advertise the wallet wizard as an unlock while the lane is off.
        if (locked.length > 0 && !signerLaneEnabled()) {
          process.stdout.write(
            dim(`🔒 ${lockedNames} ${has} no deposit-address support, and wallet signing is off in this release — quote only.`) + "\n"
          );
        } else if (locked.length > 0 && !signerConfigured()) {
          process.stdout.write(
            dim(`🔒 ${lockedNames} ${has} no deposit-address support — executable with a signing wallet: `) +
              accent("openswap wallet setup") + "\n"
          );
        }
      }

      if (ctx.noInput) {
        p.outro(
          `Ready to trade it? ${accent(`openswap swap --amount ${amount} --from ${fromToken.identifier} --to ${toToken.identifier}`)}`
        );
        return;
      }

      // Enter on a route continues straight into the swap — no command to copy.
      const toSym = assetSymbol(toToken.identifier);
      const choice = guardCancel(
        await p.select({
          message: "Trade one of these routes?",
          options: [
            ...set.offers.map((o, i) => ({
              value: i as number | "exit",
              label: `Swap via ${sanitize(o.protocol)}${o.variant && o.variant !== "REGULAR" ? ` (${sanitize(o.variant)})` : ""} — ${formatAmountForDisplay(o.expectedOutDisplay)} ${toSym}`,
              hint: recommendationReason(o, set.offers.length)
            })),
            { value: "exit" as const, label: "Just the quote, thanks", hint: "exit" }
          ]
        })
      );
      if (choice === "exit") {
        p.outro(
          `Any time: ${accent(`openswap swap --amount ${amount} --from ${fromToken.identifier} --to ${toToken.identifier}`)}`
        );
        const { maybeAskPulse } = await import("./shared.js");
        await maybeAskPulse(ctx);
        return;
      }
      const picked = set.offers[choice as number]!;
      const swapCmd = (await import("./swap.js")).default;
      await runCommand(swapCmd, {
        rawArgs: [
          "--amount", amount,
          "--from", fromToken.identifier,
          "--to", toToken.identifier,
          "--protocol", picked.protocol
        ]
      });
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
