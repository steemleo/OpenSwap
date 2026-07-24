import { defineCommand } from "citty";
import { buildApi } from "../cli-context.js";
import { loadAssets, resolveAsset } from "../core/assets.js";
import { parseDecimalInput, fromBaseUnits } from "../core/amount.js";
import { CliError } from "../core/errors.js";
import { failWith, resolveOutput } from "../render/output.js";
import { jsonlEvent } from "../render/json.js";
import { header } from "../render/components.js";
import { bold, dim, ok } from "../render/theme.js";
import { sanitize, assetSymbol } from "../render/money.js";

// Streaming quotes over SSE — the bot-facing price feed. Each upstream event
// becomes one JSONL line on stdout; humans get a readable ticker.
export default defineCommand({
  meta: { name: "watch", description: "Stream live quotes for a pair (SSE) — built for bots and agents" },
  args: {
    amount: { type: "string", alias: "a", required: false },
    from: { type: "string", alias: "f", required: false },
    to: { type: "string", alias: "t", required: false },
    jsonl: { type: "boolean", description: "One JSON object per quote event (recommended for bots)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" },
    once: { type: "boolean", description: "Exit after the stream's first full round of quotes" }
  },
  async run({ args }) {
    const ctx = resolveOutput("watch", args);
    try {
      if (!args.amount || !args.from || !args.to) {
        throw new CliError("USAGE", "watch requires --amount, --from, and --to (it is a non-interactive stream).");
      }
      const { api } = buildApi(args);
      const tokens = await loadAssets(api);
      const fromRes = resolveAsset(tokens, String(args.from));
      const toRes = resolveAsset(tokens, String(args.to));
      if (!("token" in fromRes) || !("token" in toRes)) {
        throw new CliError("VALIDATION", "Ambiguous asset — use chain:symbol or the full identifier for watch.");
      }
      const amount = parseDecimalInput(String(args.amount));

      const abort = new AbortController();
      process.on("SIGINT", () => {
        abort.abort();
        process.exit(130);
      });

      if (ctx.mode === "human") {
        process.stdout.write(header("live quotes") + "\n");
        process.stdout.write(
          dim(`${amount} ${assetSymbol(fromRes.token.identifier)} → ${assetSymbol(toRes.token.identifier)} · Ctrl-C to stop\n\n`)
        );
      }

      const seenProtocols = new Set<string>();
      let rounds = 0;
      for await (const event of api.streamQuotes(
        { from_asset: fromRes.token.identifier, to_asset: toRes.token.identifier, amount },
        abort.signal
      )) {
        const data = (event.data ?? event) as Record<string, unknown>;
        if (data.type === "init" || data.type === "done") {
          if (ctx.mode !== "human") {
            process.stdout.write(jsonlEvent(`stream_${data.type}`, { quote_id: data.quote_id ?? null, total: data.total ?? null }) + "\n");
          }
          continue;
        }
        const protocol = String(data.protocol ?? event.protocol ?? "unknown");
        const outDec = typeof data.out_asset_decimal === "number" ? data.out_asset_decimal : null;
        const rawOut = data.expected_amount_out;
        let display: string | null = null;
        if (outDec !== null && (typeof rawOut === "string" || typeof rawOut === "number")) {
          try {
            display = fromBaseUnits(typeof rawOut === "string" ? rawOut : String(Math.round(rawOut)), outDec);
          } catch {
            display = null;
          }
        }
        if (ctx.mode === "human") {
          const usd = typeof data.expected_amount_out_usd === "number" ? ` ${dim(`≈ $${(data.expected_amount_out_usd as number).toFixed(2)}`)}` : "";
          process.stdout.write(
            `${bold(sanitize(protocol).padEnd(12))} ${display ? ok(display) : dim("–")} ${assetSymbol(toRes.token.identifier)}${usd}  ${dim(new Date().toLocaleTimeString())}\n`
          );
        } else {
          process.stdout.write(
            jsonlEvent("quote", {
              protocol,
              expected_amount_out_base: typeof rawOut === "string" ? rawOut : rawOut != null ? String(rawOut) : null,
              expected_amount_out_display: display,
              expected_amount_out_usd: data.expected_amount_out_usd ?? null,
              expires_at: data.expires_at ?? null,
              quote: data
            }) + "\n"
          );
        }
        if (args.once) {
          if (seenProtocols.has(protocol)) rounds += 1;
          seenProtocols.add(protocol);
          if (rounds > 0) break;
        }
      }
      // Always terminate the stream, however the loop exited. --once breaks
      // before the upstream "done" event arrives, so without this a consumer
      // cannot tell a completed round from a process that died mid-feed.
      if (ctx.mode !== "human") {
        process.stdout.write(jsonlEvent("stream_done", { protocols: seenProtocols.size }) + "\n");
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
