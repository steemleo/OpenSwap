import { defineCommand } from "citty";
import { buildApi } from "../cli-context.js";
import { assetCacheAgeMs, popularAssets, searchAssets } from "../core/assets.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, dim, bold } from "../render/theme.js";
import { sanitize } from "../render/money.js";
import { loadAssetsWithSpinner } from "./shared.js";
import type { AssetToken } from "../core/types.js";

function tokenRow(t: AssetToken): string {
  const price = t.price_usd ? `≈ $${t.price_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
  return `${bold(sanitize(t.symbol).padEnd(10))} ${sanitize(t.blockchain).padEnd(10)} ${price.padStart(12)}  ${dim(sanitize(t.identifier))}`;
}

function tokenJson(t: AssetToken): Record<string, unknown> {
  return {
    identifier: t.identifier,
    chain: t.blockchain,
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    price_usd: t.price_usd,
    is_popular: t.is_popular,
    supports_deposit_address: t.supports_deposit_address
  };
}

const list = defineCommand({
  meta: { name: "list", description: "List supported assets (popular by default)" },
  args: {
    chain: { type: "string", description: "Filter by chain (e.g. BTC, ETH, BASE)" },
    all: { type: "boolean", description: "Include non-popular assets" },
    limit: { type: "string", description: "Maximum rows (default 30)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-input": { type: "boolean" },
    "no-color": { type: "boolean" }, "api-url": { type: "string" }, refresh: { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("assets list", args);
    try {
      const { api, apiUrl } = buildApi(args);
      const tokens = await loadAssetsWithSpinner(ctx, api, { forceRefresh: args.refresh === true });
      const limit = args.limit ? Math.max(1, Number(args.limit)) : 30;
      let filtered = tokens;
      if (args.chain) {
        const chain = args.chain.toUpperCase();
        filtered = filtered.filter((t) => t.blockchain.toUpperCase() === chain);
        if (filtered.length === 0) {
          throw new CliError("NO_ROUTE", `No supported assets on chain "${args.chain}".`, {
            actions: [{ label: "See every chain", command: "openswap assets list --all --limit 500" }]
          });
        }
      }
      const rows = args.all ? filtered.slice(0, limit) : popularAssets(filtered, limit);
      const chosen = rows.length > 0 ? rows : filtered.slice(0, limit);
      if (ctx.mode === "json") {
        emitData(ctx, { count: chosen.length, total_supported: tokens.length, assets: chosen.map(tokenJson) }, { apiUrl });
        return;
      }
      if (ctx.mode === "human") process.stdout.write(header("assets") + "\n\n");
      for (const t of chosen) {
        process.stdout.write((ctx.mode === "human" ? tokenRow(t) : `${t.identifier}\t${t.symbol}\t${t.blockchain}\t${t.price_usd ?? ""}`) + "\n");
      }
      if (ctx.mode === "human") {
        const age = assetCacheAgeMs();
        process.stdout.write(
          "\n" + dim(`${chosen.length} of ${tokens.length.toLocaleString("en-US")} supported assets${age !== null ? ` · cache ${Math.round(age / 60000)}m old` : ""} · search: openswap assets search <query>`) + "\n"
        );
        const { maybeAskPulse } = await import("./shared.js");
        await maybeAskPulse(ctx);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const search = defineCommand({
  meta: { name: "search", description: "Search supported assets" },
  args: {
    query: { type: "positional", description: "Search text (symbol or identifier)", required: true },
    limit: { type: "string", description: "Maximum rows (default 25)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-input": { type: "boolean" },
    "no-color": { type: "boolean" }, "api-url": { type: "string" }, refresh: { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("assets search", args);
    try {
      const { api, apiUrl } = buildApi(args);
      const tokens = await loadAssetsWithSpinner(ctx, api, { forceRefresh: args.refresh === true });
      const results = searchAssets(tokens, String(args.query), args.limit ? Number(args.limit) : 25);
      if (ctx.mode === "json") {
        emitData(ctx, { query: args.query, count: results.length, assets: results.map(tokenJson) }, { apiUrl });
        return;
      }
      if (results.length === 0) {
        process.stdout.write(`No supported assets match "${sanitize(String(args.query))}".\n`);
        process.stdout.write(
          dim(`Try the symbol alone (usdc), a chain-prefixed form (base:usdc), or browse: `) + accent("openswap assets list") + "\n"
        );
        process.exitCode = 4;
        return;
      }
      if (ctx.mode === "human") process.stdout.write(header("assets") + "\n\n");
      for (const t of results) {
        process.stdout.write((ctx.mode === "human" ? tokenRow(t) : `${t.identifier}\t${t.symbol}\t${t.blockchain}\t${t.price_usd ?? ""}`) + "\n");
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "assets", description: "Explore the assets LeoKit can swap" },
  subCommands: { list, search }
});
