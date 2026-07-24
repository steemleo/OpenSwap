import type { CliError } from "../core/errors.js";
import type { RouteOffer } from "../core/types.js";
import { isTestMode } from "../core/paths.js";
import { formatUsd } from "../core/amount.js";
import { formatAmountForDisplay } from "../core/amount.js";
import {
  accent,
  accentBold,
  bad,
  bold,
  dim,
  glyph,
  ok,
  termCaps,
  visibleWidth,
  warn
} from "./theme.js";
import { amountWithAsset, formatCountdown, formatDuration, sanitize } from "./money.js";

export function header(subtitle?: string): string {
  // The TEST badge is the load-bearing signal that nothing here is real —
  // it rides EVERY header, warn-colored so it can't be mistaken for brand.
  const badge = isTestMode() ? ` ${warn(bold("TEST"))}` : "";
  const mark = `${accent(glyph("diamond"))}  ${accentBold("OpenSwap")}${badge}`;
  return subtitle ? `${mark}  ${dim(`${glyph("middot")} ${subtitle}`)}` : mark;
}

export function rail(line = ""): string {
  return line ? `${dim(glyph("rail"))}  ${line}` : dim(glyph("rail"));
}

export function railAll(lines: string[]): string[] {
  return lines.map((l) => rail(l));
}

function padTo(line: string, width: number): string {
  const pad = width - visibleWidth(line);
  return pad > 0 ? line + " ".repeat(pad) : line;
}

export function box(lines: string[], opts: { width?: number; accented?: boolean } = {}): string[] {
  const caps = termCaps();
  const width = Math.min(opts.width ?? caps.columns - 4, caps.columns - 4);
  const inner = width - 2;
  const color = opts.accented ? accent : dim;
  const top = color(`${glyph("boxTL")}${glyph("boxH").repeat(width)}${glyph("boxTR")}`);
  const bottom = color(`${glyph("boxBL")}${glyph("boxH").repeat(width)}${glyph("boxBR")}`);
  const out: string[] = [top];
  for (const line of lines) {
    out.push(`${color(glyph("boxV"))} ${padTo(line, inner)} ${color(glyph("boxV"))}`);
  }
  out.push(bottom);
  return out;
}

export function keyValueRows(
  rows: Array<[string, string] | null>,
  opts: { labelWidth?: number } = {}
): string[] {
  const present = rows.filter((r): r is [string, string] => r !== null);
  const labelWidth = opts.labelWidth ?? Math.max(...present.map(([l]) => l.length)) + 2;
  return present.map(([label, value]) => `${dim(label.padEnd(labelWidth))}${value}`);
}

export interface RouteCardContext {
  index: number;
  selected: boolean;
  toSymbol: string;
  now?: number;
}

export function routeCard(offer: RouteOffer, ctx: RouteCardContext): string[] {
  const now = ctx.now ?? Date.now();
  const name = sanitize(offer.protocol);
  const variant = offer.variant && offer.variant.toUpperCase() !== "REGULAR" ? ` ${dim(sanitize(offer.variant))}` : "";
  const tags: string[] = [];
  if (offer.flags.bestOutput) tags.push("best receive");
  if (offer.flags.fastest) tags.push("fastest");
  if (offer.flags.cheapest) tags.push("lowest fees");
  const expiresMs = offer.expiresAt - now;
  const eta = formatDuration(offer.etaSeconds);
  const pointer = ctx.selected ? accent(glyph("pointer")) : " ";
  const title = ctx.selected ? bold(name) : name;
  const tagStr = tags.length > 0 ? ok(tags.join(` ${glyph("middot")} `)) : "";

  const line1 = `${pointer} ${ctx.index}. ${title}${variant}${tagStr ? `   ${tagStr}` : ""}`;
  const receive = `${formatAmountForDisplay(offer.expectedOutDisplay)} ${sanitize(ctx.toSymbol)}`;
  const usd = formatUsd(offer.expectedOutUsd);
  const line2 = `   Expected receive   ${bold(ok(receive))}${usd ? `  ${dim(`≈ ${usd}`)}` : ""}`;
  const feeStr =
    offer.feesTotalUsd !== null
      ? `fees ${formatUsd(offer.feesTotalUsd)}`
      : offer.fees.length > 0
        ? "fees partly unpriced"
        : "fees not provided";
  const line3 = `   ${dim(`${feeStr} ${glyph("middot")} ${eta} ${glyph("middot")} expires ${formatCountdown(expiresMs)}`)}`;
  return [line1, line2, line3];
}

export type TimelineState = "done" | "active" | "todo" | "failed";

export function timeline(steps: Array<{ label: string; state: TimelineState }>): string[] {
  return steps.map(({ label, state }) => {
    switch (state) {
      case "done":
        return `${ok(glyph("check"))} ${label}`;
      case "active":
        return `${accent(glyph("dotFilled"))} ${bold(label)}`;
      case "failed":
        return `${bad(glyph("cross"))} ${bad(label)}`;
      default:
        return `${dim(glyph("dotOpen"))} ${dim(label)}`;
    }
  });
}

export function errorBlock(err: CliError): string[] {
  const lines: string[] = [];
  lines.push(`${bad(glyph("caution"))} ${bold(sanitize(err.message))}`);
  if (err.fundsMayHaveMoved) {
    lines.push(warn("Funds may have moved. Do not retry until status is confirmed."));
  }
  if (err.actions.length > 0) {
    lines.push("");
    lines.push(dim("Next:"));
    err.actions.forEach((a, i) => {
      lines.push(`  ${i + 1}. ${a.label}${a.command ? `  ${accent(a.command)}` : ""}`);
    });
  }
  lines.push("");
  lines.push(dim(`Code: ${err.code}${err.retryable ? " (retryable)" : ""}`));
  return lines;
}

export function hr(width?: number): string {
  const caps = termCaps();
  return dim(glyph("rule").repeat(Math.min(width ?? caps.columns - 2, caps.columns - 2)));
}

export { amountWithAsset };
