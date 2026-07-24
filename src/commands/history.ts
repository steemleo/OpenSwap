import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { listReceipts } from "../core/receipts.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, ok, warn } from "../render/theme.js";
import { assetSymbol, sanitize } from "../render/money.js";
import { guardCancel } from "./shared.js";

// `openswap history` is the human-first ledger: every swap started from this
// machine, newest first, with an interactive pick into details or live
// tracking — never a dead-end list of IDs. (`receipts` remains the low-level
// store view; both read the same durable records.)

function chainOf(identifier: string): string {
  return identifier.split(".")[0] ?? "";
}

function stateBadge(state: string): string {
  if (state === "success") return ok("success");
  if (state === "failed" || state === "refunded") return warn(state);
  if (state === "expired") return dim("expired");
  return accent(state);
}

export default defineCommand({
  meta: { name: "history", description: "Every swap started from this machine — browse, inspect, track" },
  args: {
    limit: { type: "string", description: "Max entries to show (default 20)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("history", args);
    try {
      const limit = args.limit ? Math.max(1, Number(args.limit)) : 20;
      const receipts = listReceipts().slice(0, limit);
      if (ctx.mode !== "human") {
        emitData(ctx, { count: receipts.length, swaps: receipts });
        return;
      }
      p.intro(header("history"));
      if (receipts.length === 0) {
        p.outro(`No swaps from this machine yet — they appear here the moment a deposit address is created. Start one: ${accent("openswap swap")}`);
        return;
      }
      const picked = guardCancel(
        await p.select({
          message: `${receipts.length} swap${receipts.length === 1 ? "" : "s"} on this machine — pick one to inspect`,
          options: [
            ...receipts.map((r) => ({
              value: r.receipt_id,
              label: `${r.created_at.slice(0, 16).replace("T", " ")}  ${r.amount_display} ${assetSymbol(r.from_asset)}·${chainOf(r.from_asset)} → ${assetSymbol(r.to_asset)}·${chainOf(r.to_asset)}`,
              hint: `${sanitize(r.protocol)} · ${r.last_state}`
            })),
            { value: "__done__", label: "Done" }
          ]
        })
      );
      if (picked === "__done__") {
        p.outro(`Full records: ${accent("openswap receipts show <id>")}`);
        return;
      }
      const receipt = receipts.find((r) => r.receipt_id === picked)!;
      process.stdout.write("\n");
      await runCommand((await import("./receipts.js")).default, { rawArgs: ["show", String(picked)] });
      const terminal = ["success", "failed", "refunded", "expired"].includes(receipt.last_state);
      if (!terminal) {
        const track = guardCancel(
          await p.confirm({ message: "This swap is still open — watch it live now?", initialValue: true })
        );
        if (track === true) {
          await runCommand((await import("./status.js")).default, { rawArgs: [String(picked), "--watch"] });
          return;
        }
      }
      p.outro(`${bold(stateBadge(receipt.last_state))} ${dim(`· track any time: openswap status ${picked} --watch`)}`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
