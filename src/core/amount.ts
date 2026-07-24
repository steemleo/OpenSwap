import { CliError } from "./errors.js";

const DECIMAL_RE = /^\d+(\.\d+)?$/;

// Validates and normalizes a human-entered decimal amount string.
// Rejects floats-as-strings artifacts (exponents, signs).
export function parseDecimalInput(raw: string): string {
  // A comma is a thousands separator to some people and a decimal point to
  // others: "1,5" is 1.5 across most of Europe. Stripping it turned that into
  // 15 — a silent 10x overspend, invisible to `--yes` and to any agent
  // forwarding a user's words. It is never unambiguous, so never guess.
  if (raw.includes(",")) {
    throw new CliError(
      "VALIDATION",
      `Amounts cannot contain commas — "${raw}" is ambiguous. Use a period for the decimal point (e.g. 1000.50).`
    );
  }
  const cleaned = raw.trim().replace(/_/g, "");
  const noLeadingDot = cleaned.startsWith(".") ? `0${cleaned}` : cleaned;
  if (!DECIMAL_RE.test(noLeadingDot)) {
    throw new CliError("VALIDATION", `"${raw}" is not a valid decimal amount.`);
  }
  // strip leading zeros (keep "0.x") and trailing fraction zeros
  let [int = "0", frac = ""] = noLeadingDot.split(".");
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (int === "" ) int = "0";
  const out = frac ? `${int}.${frac}` : int;
  if (out === "0") {
    throw new CliError("VALIDATION", "Amount must be greater than zero.");
  }
  return out;
}

// Exact display → base-units conversion. No floating point, ever.
export function toBaseUnits(display: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new CliError("INTERNAL", `Unsupported decimals: ${decimals}`);
  }
  const [int = "0", frac = ""] = display.split(".");
  if (frac.length > decimals) {
    throw new CliError(
      "VALIDATION",
      `Amount ${display} has more than ${decimals} decimal places, which this asset cannot represent.`
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(int + padded || "0");
}

// Exact base-units → display conversion. Accepts bigint, integer string, or
// (reluctantly) a JS number that survived JSON parsing — see parseJsonPreservingBigInts.
export function fromBaseUnits(base: bigint | string | number, decimals: number): string {
  let b: bigint;
  if (typeof base === "bigint") b = base;
  else if (typeof base === "string") {
    // "2.38e+25" would otherwise split to "2" and render as 2e-18 tokens — a
    // wrong number shown with full confidence. Refuse it: the caller turns a
    // throw into an honest "unknown", which is always safer than a bad figure.
    if (/[eE]/.test(base)) {
      throw new CliError("INTERNAL", `Base-unit amount "${base}" is not an exact integer.`);
    }
    b = BigInt(base.includes(".") ? base.split(".")[0]! : base);
  } else b = BigInt(Math.round(base));
  const neg = b < 0n;
  if (neg) b = -b;
  const s = b.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

// JSON.stringify switches to exponent notation at |n| >= 1e21, so the largest
// base-unit amounts never appear as a plain digit run — a payout of 1000 units
// of any 18-decimal asset already crosses that line (SHIB, LINK, UNI in
// production). Expand such a literal to its exact digit string.
// Returns null when the value is not a whole number, so something we cannot
// represent exactly is never rewritten into something that looks authoritative.
function expandExponentInteger(literal: string): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(literal);
  if (!m) return null; // includes negative exponents: not a base-unit integer
  const [, sign = "", intPart = "", fracPart = "", expStr = ""] = m;
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp) || exp > 100) return null;
  if (fracPart.length > exp) return null; // would leave a fractional remainder
  const digits = `${intPart}${fracPart}${"0".repeat(exp - fracPart.length)}`;
  return `${sign}${digits.replace(/^0+(?=\d)/, "")}`;
}

// The API serializes base-unit amounts as JSON numbers, which can exceed
// Number.MAX_SAFE_INTEGER (verified live: expected_amount_out=54578044804470400)
// and, above 1e21, arrive in exponent form (2.390638634897e+25).
// Quote both shapes into strings before JSON.parse so precision survives.
export function parseJsonPreservingBigInts(text: string, fields: string[]): unknown {
  let patched = text;
  for (const field of fields) {
    const re = new RegExp(
      `("${field}"\\s*:\\s*)(-?(?:\\d+(?:\\.\\d+)?[eE][+-]?\\d+|\\d{15,}))(?=[,}\\]\\s])`,
      "g"
    );
    patched = patched.replace(re, (match, prefix: string, literal: string) => {
      if (!/[eE]/.test(literal)) return `${prefix}"${literal}"`;
      const expanded = expandExponentInteger(literal);
      // Leave an inexpressible value as-is rather than guessing; the caller's
      // integer guard then rejects it loudly instead of trusting a bad number.
      return expanded === null ? match : `${prefix}"${expanded}"`;
    });
  }
  return JSON.parse(patched);
}

// Human display formatting: thousands separators for the integer part,
// sensible fraction truncation for readability (display only — never math).
export function formatAmountForDisplay(display: string, opts: { maxSignificantFraction?: number } = {}): string {
  const maxFrac = opts.maxSignificantFraction ?? 8;
  const [int = "0", frac = ""] = display.split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!frac) return intFmt;
  // keep leading zeros + maxFrac significant fraction digits
  const leadingZeros = frac.match(/^0*/)?.[0].length ?? 0;
  let cut = frac.slice(0, Math.min(frac.length, leadingZeros + maxFrac));
  cut = cut.replace(/0+$/, "");
  return cut ? `${intFmt}.${cut}` : intFmt;
}

export function formatUsd(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
