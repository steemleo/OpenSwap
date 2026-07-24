import { defineCommand } from "citty";
import { listReceipts, readReceipt } from "../core/receipts.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, ok, warn } from "../render/theme.js";
import { assetSymbol, sanitize } from "../render/money.js";

function chainOf(identifier: string): string {
  return identifier.split(".")[0] ?? "";
}

function stateBadge(state: string): string {
  if (state === "success") return ok("success");
  if (state === "failed") return warn("failed");
  if (state === "refunded") return warn("refunded");
  if (state === "expired") return dim("expired");
  return accent(state);
}

const list = defineCommand({
  meta: { name: "list", description: "List swap receipts saved on this machine" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("receipts list", args);
    try {
      const receipts = listReceipts();
      if (ctx.mode === "json") {
        emitData(ctx, { count: receipts.length, receipts });
        return;
      }
      if (ctx.mode === "human") process.stdout.write(header("receipts") + "\n\n");
      if (receipts.length === 0) {
        process.stdout.write(dim("No swaps started from this machine yet. Receipts appear here the moment a deposit address is created.\n"));
        return;
      }
      for (const r of receipts) {
        const date = r.created_at.slice(0, 16).replace("T", " ");
        process.stdout.write(
          `${accent(r.receipt_id.padEnd(22))} ${dim(date)}  ${bold(`${r.amount_display} ${assetSymbol(r.from_asset)}·${chainOf(r.from_asset)}`)} ${dim("→")} ${assetSymbol(r.to_asset)}·${chainOf(r.to_asset)}  ${dim(`via ${sanitize(r.protocol)}`)}  ${stateBadge(r.last_state)}\n`
        );
      }
      process.stdout.write("\n" + dim(`Details: openswap receipts show <id> · Track: openswap status <id> --watch`) + "\n");
      if (ctx.mode === "human") {
        const { maybeAskPulse } = await import("./shared.js");
        await maybeAskPulse(ctx);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const show = defineCommand({
  meta: { name: "show", description: "Show one receipt in full" },
  args: {
    id: { type: "positional", required: true },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("receipts show", args);
    try {
      const receipt = readReceipt(String(args.id));
      if (ctx.mode === "json") {
        emitData(ctx, receipt);
        return;
      }
      const { keyValueRows } = await import("../render/components.js");
      process.stdout.write(header("receipt") + "\n\n");
      process.stdout.write(
        keyValueRows([
          ["Receipt", accent(receipt.receipt_id)],
          ["Created", receipt.created_at],
          ["Swap", `${receipt.amount_display} ${assetSymbol(receipt.from_asset)}·${chainOf(receipt.from_asset)} → ${assetSymbol(receipt.to_asset)}·${chainOf(receipt.to_asset)}`],
          ["Protocol", sanitize(receipt.protocol)],
          ["State", receipt.last_state],
          ["Expected receive", receipt.expected_out_display],
          ["Destination", receipt.destination_address],
          receipt.refund_address ? ["Refund address", receipt.refund_address] : null,
          receipt.deposit ? ["Deposit address", receipt.deposit.deposit_address] : null,
          receipt.tx_hashes.source ? ["Source tx", receipt.tx_hashes.source] : null,
          receipt.tx_hashes.destination ? ["Destination tx", receipt.tx_hashes.destination] : null,
          receipt.last_error ? ["Last error", sanitize(receipt.last_error)] : null
        ]).join("\n") + "\n\n"
      );
      process.stdout.write(dim("Track: ") + accent(`openswap status ${receipt.receipt_id} --watch`) + "\n");
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const exportCmd = defineCommand({
  meta: { name: "export", description: "Print a receipt as JSON (pipe to a file to share with support)" },
  args: { id: { type: "positional", required: true }, json: { type: "boolean" }, "no-color": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("receipts export", args);
    try {
      const receipt = readReceipt(String(args.id));
      process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "receipts", description: "Durable records of every swap you started" },
  subCommands: { list, show, export: exportCmd }
});
