import { formatAmountForDisplay, formatUsd } from "../core/amount.js";
import { dim } from "./theme.js";

// Upstream strings (protocol names, error text, asset symbols) are untrusted
// data — strip control characters and ANSI so they cannot inject terminal
// escapes or misleading output.
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\x1b/g, "");
}

// Full addresses are payment targets: wrapped in 4-char groups, NEVER truncated.
export function wrapAddress(address: string, groupSize = 4, groupsPerLine = 8): string[] {
  const clean = sanitize(address);
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += groupSize) {
    groups.push(clean.slice(i, i + groupSize));
  }
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += groupsPerLine) {
    lines.push(groups.slice(i, i + groupsPerLine).join(" "));
  }
  return lines;
}

// Review-screen address treatment: the FULL address on one unbroken line with
// the first and last four characters emphasized — never truncated, never split.
export function emphasizeAddress(address: string, boldFn: (s: string) => string): string {
  const clean = sanitize(address);
  if (clean.length <= 10) return boldFn(clean);
  return `${boldFn(clean.slice(0, 4))}${clean.slice(4, -4)}${boldFn(clean.slice(-4))}`;
}

export function amountWithAsset(display: string, symbol: string, usd?: number | string | null): string {
  const amt = `${formatAmountForDisplay(display)} ${sanitize(symbol)}`;
  const usdStr = formatUsd(usd ?? null);
  return usdStr ? `${amt} ${dim(`≈ ${usdStr}`)}` : amt;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  const s = Math.round(seconds);
  if (s < 60) return `~${s} sec`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `~${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `~${h}h ${m}m`;
}

export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "expired";
  const total = Math.floor(msRemaining / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// symbol out of a CHAIN.SYMBOL-ADDRESS identifier
export function assetSymbol(identifier: string): string {
  const afterDot = identifier.split(".")[1] ?? identifier;
  return sanitize(afterDot.split("-")[0] ?? afterDot);
}

export function assetChain(identifier: string): string {
  return sanitize(identifier.split(".")[0] ?? identifier);
}
