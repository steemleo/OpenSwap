import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { buildApi } from "../cli-context.js";
import { latestOpenReceipt, listReceipts, readReceipt, updateReceipt } from "../core/receipts.js";
import { isTestMode } from "../core/paths.js";
import { normalizeStatus, pollStatus } from "../core/status.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header, keyValueRows } from "../render/components.js";
import { accent, bold, dim } from "../render/theme.js";
import { formatCountdown, sanitize, assetSymbol } from "../render/money.js";
import { finalStateBlock, renderSwapTimeline, stateSteps } from "./status-render.js";
import type { ReceiptV1 } from "../core/types.js";

function looksLikeQuoteId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function resolveReceipt(idArg: string | undefined): { receipt: ReceiptV1 | null; quoteId: string } {
  if (!idArg) {
    const latest = latestOpenReceipt();
    if (!latest) {
      const all = listReceipts();
      if (all.length === 0) {
        throw new CliError("RECEIPT_NOT_FOUND", "No swaps have been started from this machine yet.", {
          actions: [{ label: "Start one", command: "openswap swap" }]
        });
      }
      return { receipt: all[0]!, quoteId: all[0]!.quote_id };
    }
    return { receipt: latest, quoteId: latest.quote_id };
  }
  const id = idArg.trim();
  // A simulated receipt presented outside test mode must fail LOUDLY — the
  // Stripe rule: a test artifact is recognizably test, and modes never blur.
  if (id.startsWith("ost_") && !isTestMode()) {
    throw new CliError("RECEIPT_NOT_FOUND", `"${id}" is a SIMULATED receipt — it only exists in test mode.`, {
      actions: [{ label: "Enter test mode to see it", command: "openswap test on" }]
    });
  }
  if (id.startsWith("os_") || id.startsWith("ost_") || id.startsWith("lk_")) {
    const receipt = readReceipt(id);
    return { receipt, quoteId: receipt.quote_id };
  }
  if (looksLikeQuoteId(id)) {
    const receipt = listReceipts().find((r) => r.quote_id === id) ?? null;
    return { receipt, quoteId: id };
  }
  throw new CliError("USAGE", `"${id}" is not a receipt (os_…) or quote ID.`);
}

export function statusToJson(receipt: ReceiptV1 | null, status: ReturnType<typeof normalizeStatus>): Record<string, unknown> {
  return {
    receipt_id: receipt?.receipt_id ?? null,
    quote_id: receipt?.quote_id ?? null,
    state: status.state,
    protocol: status.protocol ?? receipt?.protocol ?? null,
    in_amount: status.inAmount,
    out_amount: status.outAmount,
    dest_tx_hash: status.destTxHash,
    refund_tx_hash: status.refundTxHash,
    error: status.error,
    scanner_url: status.scannerUrl,
    native_scanner_url: status.nativeScannerUrl,
    deposit: receipt?.deposit ?? null,
    destination_address: receipt?.destination_address ?? null
  };
}

export default defineCommand({
  meta: { name: "status", description: "Check or watch a swap by receipt or quote ID" },
  args: {
    id: { type: "positional", description: "Receipt (os_…) or quote ID — defaults to your latest swap", required: false },
    watch: { type: "boolean", alias: "w", description: "Keep watching until the swap reaches a final state" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("status", args);
    try {
      const { api, apiUrl } = buildApi(args);
      const { receipt, quoteId } = resolveReceipt(args.id ? String(args.id) : undefined);

      if (ctx.mode === "human") {
        p.intro(header("swap status"));
        if (receipt) {
          const rows = keyValueRows([
            ["Receipt", accent(receipt.receipt_id)],
            ["Swap", `${receipt.amount_display} ${assetSymbol(receipt.from_asset)} ${dim("→")} ${assetSymbol(receipt.to_asset)} ${dim(`via ${sanitize(receipt.protocol)}`)}`],
            receipt.deposit?.expires_at && receipt.last_state === "awaiting_payment"
              ? ["Deposit expires", formatCountdown(receipt.deposit.expires_at - Date.now())]
              : null,
            ["Destination", receipt.destination_address]
          ]);
          process.stdout.write(rows.join("\n") + "\n\n");
        }
      }

      const raw = await api.getStatus({ quote_id: quoteId });
      let status = normalizeStatus(raw);

      // Deposit not yet paid: the backend reports "pending" both before and
      // after payment. If the receipt still says awaiting_payment and the
      // deposit window expired, surface that honestly.
      // "expired" belongs in this set. Without it, the branch below wrote
      // last_state="expired", the NEXT poll failed this guard, fell through to
      // the normal path and reported "pending" again — so the state flapped
      // pending/deposit_expired on every other poll and an agent waiting for a
      // terminal state never finished. Once expired and still unpaid, stay
      // expired. A late payment sets tx_hashes.source or moves status off
      // pending, so the "paid late" recovery still works.
      const unpaid =
        receipt !== null &&
        (receipt.last_state === "awaiting_payment" ||
          receipt.last_state === "pending" ||
          receipt.last_state === "expired") &&
        receipt.tx_hashes.source === null;
      if (
        receipt &&
        unpaid &&
        status.state === "pending" &&
        receipt.deposit?.expires_at &&
        receipt.deposit.expires_at < Date.now()
      ) {
        updateReceipt(receipt.receipt_id, { last_state: "expired" });
        if (ctx.mode === "json") {
          emitData(ctx, { ...statusToJson(receipt, status), state: "deposit_expired" }, { apiUrl });
          return;
        }
        const redoArgs = [
          "--from", receipt.from_asset,
          "--to", receipt.to_asset,
          "--amount", receipt.amount_display,
          "--to-address", receipt.destination_address,
          ...(receipt.refund_address ? ["--refund-address", receipt.refund_address] : [])
        ];
        process.stdout.write(
          `${bold("This deposit window has expired.")}\n${dim("If you did NOT pay it: nothing happened. Late payments are often still honored — the protocol can detect them after the window.")}\n`
        );
        let keepWatching = false;
        if (process.stdout.isTTY && !ctx.noInput) {
          const next = await p.select({
            message: "What now?",
            options: [
              { value: "fresh", label: "Run the same swap with a fresh deposit address", hint: "current rate" },
              { value: "track", label: "I paid (maybe late) — keep watching this deposit" },
              { value: "done", label: "Done for now" }
            ]
          });
          if (next === "fresh") {
            const swapCmd = (await import("./swap.js")).default;
            const { runCommand } = await import("citty");
            await runCommand(swapCmd, { rawArgs: redoArgs });
            return;
          }
          keepWatching = next === "track";
        }
        if (!keepWatching) {
          // declined, cancelled, or non-interactive — leave the command in hand
          process.stdout.write(`\nWhenever you're ready:\n  ${accent(`openswap swap ${redoArgs.join(" ")}`)}\n`);
          return;
        }
        // fall through: force live watching — "keep watching" means watch
        args.watch = true;
      }

      if (receipt) {
        // a server "pending" before any payment is meaningless — keep the
        // more precise awaiting_payment state on the receipt
        const keepAwaiting = receipt.last_state === "awaiting_payment" && status.state === "pending";
        updateReceipt(receipt.receipt_id, {
          ...(keepAwaiting ? {} : { last_state: status.state }),
          last_checked_at: new Date().toISOString(),
          last_error: status.error
        });
      }

      if (!args.watch || ["success", "failed", "refunded"].includes(status.state)) {
        if (ctx.mode === "json") {
          emitData(ctx, statusToJson(receipt, status), { apiUrl });
          return;
        }
        process.stdout.write(renderSwapTimeline(stateSteps(status.state)) + "\n\n");
        process.stdout.write(finalStateBlock(status, receipt?.receipt_id ?? quoteId, receipt ? assetSymbol(receipt.to_asset) : "", receipt?.refund_address) + "\n");
        if (ctx.mode === "human") {
          const { maybeAskPulse } = await import("./shared.js");
          await maybeAskPulse(ctx);
        }
        return;
      }

      // watch mode
      const abort = new AbortController();
      const receiptId = receipt?.receipt_id ?? quoteId;
      const onSigint = (): void => {
        abort.abort();
        process.stdout.write(`\nStill running. Resume: ${accent(`openswap status ${receiptId} --watch`)}\n`);
        process.exit(130);
      };
      process.on("SIGINT", onSigint);
      if (ctx.mode === "human") process.stdout.write(dim("Watching — Ctrl-C to stop (the swap continues on-chain).") + "\n\n");

      // TTY: redraw the same timeline in place on each state change
      let timelineHeight = 0;
      const final = await pollStatus(api, {
        quoteId,
        signal: abort.signal,
        timeoutMs: null,
        onUpdate: (s) => {
          status = s;
          if (receipt) {
            updateReceipt(receipt.receipt_id, {
              last_state: s.state,
              last_checked_at: new Date().toISOString(),
              last_error: s.error
            });
          }
          if (ctx.mode === "json") {
            process.stderr.write(JSON.stringify({ state: s.state }) + "\n");
            return;
          }
          const block = renderSwapTimeline(stateSteps(s.state));
          if (process.stdout.isTTY && timelineHeight > 0) {
            process.stdout.write(`\x1b[${timelineHeight}A\x1b[0J`);
          }
          process.stdout.write(block + "\n\n");
          timelineHeight = block.split("\n").length + 1;
        }
      });
      process.removeListener("SIGINT", onSigint);
      if (ctx.mode === "json") {
        emitData(ctx, statusToJson(receipt, final), { apiUrl });
        return;
      }
      process.stdout.write(finalStateBlock(final, receiptId, receipt ? assetSymbol(receipt.to_asset) : "", receipt?.refund_address) + "\n");
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
