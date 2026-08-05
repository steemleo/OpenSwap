import type { NormalizedStatus, SwapState } from "../core/types.js";
import { timeline, type TimelineState } from "../render/components.js";
import { accent, bad, bold, dim, glyph, ok, warn } from "../render/theme.js";
import { sanitize } from "../render/money.js";

const ORDER = ["pending", "confirming", "swapping", "sending", "success"] as const;

export function stateSteps(
  state: SwapState,
  opts: { unverified?: boolean } = {}
): Array<{ label: string; state: TimelineState }> {
  // An unverified "success" proves nothing about the intermediate steps —
  // inferring them from a final state we do not trust would paint progress
  // that may never have happened. Show only what is actually known.
  if (opts.unverified && state === "success") return stateSteps("pending");
  const labels: Record<(typeof ORDER)[number], string> = {
    // "pending" is what the backend reports BOTH before and after payment, and
    // it is also the value the watch view is seeded with the moment a deposit
    // address is shown. Labelling it "Deposit detected" claimed we had seen
    // money before the user had opened a wallet. The label below is true in
    // both readings; it flips to "Deposit received" only once a later state
    // proves the deposit actually landed.
    pending: "Waiting for your deposit",
    confirming: "Source network confirmations",
    swapping: "Crosschain swap in progress",
    sending: "Destination delivery",
    success: "Complete"
  };
  const paidLabel = "Deposit received";
  if (state === "failed" || state === "refunded") {
    return [
      { label: paidLabel, state: "done" },
      { label: state === "refunded" ? "Swap could not complete — refund issued" : "Swap failed", state: "failed" }
    ];
  }
  const idx = ORDER.indexOf(state);
  return ORDER.map((s, i) => ({
    label: s === "pending" && i < idx ? paidLabel : labels[s],
    state: i < idx ? "done" : i === idx ? (s === "success" ? "done" : "active") : "todo"
  }));
}

export function renderSwapTimeline(steps: Array<{ label: string; state: TimelineState }>): string {
  return timeline(steps).join("\n");
}

export function finalStateBlock(
  status: NormalizedStatus,
  receiptId: string,
  toSymbol: string,
  refundAddress?: string | null
): string {
  const lines: string[] = [];
  switch (status.state) {
    case "success": {
      if (status.implausible && status.implausible.length > 0) {
        // The reported state failed corroboration. State the claim, say why
        // it cannot be trusted, and never present the amount as money
        // received — an unverified figure rendered green reads as fact.
        lines.push(`${warn(glyph("caution"))} ${bold("The backend reports this swap complete — the CLI could not verify that.")}`);
        for (const i of status.implausible) lines.push(dim(`  ${glyph("middot")} ${sanitize(i.message)}`));
        if (status.outAmount) lines.push(dim(`Claimed received ${sanitize(status.outAmount)} ${sanitize(toSymbol)} — unverified`));
        lines.push("");
        lines.push(bold("Treat this swap as unconfirmed."));
        lines.push(dim("Next:"));
        lines.push(`  1. Keep watching  ${accent(`openswap status ${receiptId} --watch`)}`);
        lines.push(`  2. Check the destination address on its own block explorer`);
        lines.push(`  3. Tell the team  ${accent(`openswap feedback -m "swap ${receiptId} unverified success"`)}`);
        break;
      }
      lines.push(`${ok(glyph("check"))} ${bold("Swap complete.")}`);
      if (status.outAmount) lines.push(`Received         ${bold(ok(`${sanitize(status.outAmount)} ${sanitize(toSymbol)}`))}`);
      if (status.destTxHash) lines.push(`Destination tx   ${sanitize(status.destTxHash)}`);
      break;
    }
    case "refunded": {
      lines.push(`${warn(glyph("caution"))} ${bold("The swap could not complete and was refunded by the protocol.")}`);
      if (status.refundTxHash) lines.push(`Refund tx        ${sanitize(status.refundTxHash)}`);
      lines.push(dim("Refunds return to the source-chain sender or your refund address, minus network costs."));
      break;
    }
    case "failed": {
      lines.push(`${bad(glyph("cross"))} ${bold("The swap failed.")}`);
      if (status.error) lines.push(`Reason           ${sanitize(status.error)}`);
      // The only two questions that matter after paying into a failed swap are
      // "do I get it back" and "when". The refunded branch above answers both;
      // this one used to answer neither, and led with "post in Discord".
      lines.push("");
      if (refundAddress) {
        lines.push(`${bold("Your funds:")} failed swaps are normally refunded by the protocol to`);
        lines.push(`  ${bold(sanitize(refundAddress))}`);
        lines.push(dim("  minus network costs. This can take a while — keep watching below."));
      } else {
        lines.push(`${bold("Your funds:")} failed swaps are normally refunded by the protocol to the`);
        lines.push(dim("  wallet you paid from, minus network costs. Keep watching below."));
      }
      lines.push("");
      lines.push(dim("Next:"));
      lines.push(`  1. Keep watching  ${accent(`openswap status ${receiptId} --watch`)}`);
      lines.push(`  2. Full record    ${accent(`openswap receipts show ${receiptId}`)}`);
      lines.push(`  3. Tell the team  ${accent(`openswap feedback -m "swap ${receiptId} failed"`)}`);
      break;
    }
    default: {
      lines.push(`${accent(glyph("dotFilled"))} ${bold("Still in progress.")}`);
      lines.push(dim(`Resume: openswap status ${receiptId} --watch`));
    }
  }
  if (status.scannerUrl) lines.push(`Protocol view    ${dim(sanitize(status.scannerUrl))}`);
  if (status.nativeScannerUrl) lines.push(`Source explorer  ${dim(sanitize(status.nativeScannerUrl))}`);
  return lines.join("\n");
}
