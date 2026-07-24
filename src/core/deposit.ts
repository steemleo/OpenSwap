import { CliError } from "./errors.js";
import { EVM_CHAINS as SIGNER_EVM_CHAINS } from "./chains.js";
import { fromBaseUnits, parseDecimalInput, toBaseUnits } from "./amount.js";
import type { LeoKitApi } from "./api.js";
import type { RouteOffer, WireDepositAddressResponse } from "./types.js";

// Deposit-address handoff is the noncustodial first execution slice: LeoKit
// mints a deposit address, the user pays it from any wallet they already trust.
// BOB requires OP_RETURN data a plain address cannot carry — the backend
// hard-rejects it on this path and the CLI never offers it.
export const DEPOSIT_QR_SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["chainflip", "near", "relay", "relay-deposit"]);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BTC_ADDRESS_RE = /^(bc1[a-zA-HJ-NP-Z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
const LTC_ADDRESS_RE = /^(ltc1[a-zA-HJ-NP-Z0-9]{20,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
const DOGE_ADDRESS_RE = /^[DA9][a-km-zA-HJ-NP-Z1-9]{25,39}$/;
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Chains whose addresses are 0x + 40 hex. Deliberately a SUPERSET of the
// signer registry in chains.ts: an address can be format-checked on a chain we
// cannot sign for. Derived from that registry so this set can never drift
// BELOW it — the only direction that would silently lose validation.
const EVM_CHAINS = new Set([
  ...Object.keys(SIGNER_EVM_CHAINS),
  "HYPEREVM", "BERA", "LINEA", "SCROLL", "ZKSYNC", "MANTLE", "BLAST",
  "UNICHAIN", "GNOSIS", "CELO", "SONIC"
]);

// Chains we know are NOT 0x-addressed. Used only to reject an obviously
// cross-family paste (an EVM address in an XRP payout field) — the realistic
// user error, and unrecoverable once paid. Kept as an explicit allowlist of
// "known non-EVM" rather than "anything not in EVM_CHAINS" so that a new EVM
// chain appearing upstream degrades to the old length check instead of
// rejecting valid addresses.
const KNOWN_NON_EVM_CHAINS = new Set([
  "BTC", "LTC", "DOGE", "BCH", "SOL", "XRP", "TRX", "ATOM", "DOT", "THOR",
  "MAYA", "ZEC", "NEAR", "TON", "SUI", "APT", "ADA", "XLM", "ALGO", "KUJI",
  "OSMO", "KAVA", "RUNE", "DASH", "XMR"
]);

// Obvious placeholder / burn addresses must never appear in an executable flow.
const PLACEHOLDER_PATTERNS = [
  /^0x0{40}$/i,
  /^0x[dD][eE][aA][dD]/,
  /placeholder/i,
  /^bc1qexample/i,
  /^example/i
];

export function looksLikePlaceholder(address: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(address.trim()));
}

export interface AddressCheck {
  ok: boolean;
  reason?: string;
}

// Format-level validation only — the user's wallet remains the final authority.
export function validateAddressForChain(chain: string, address: string): AddressCheck {
  const a = address.trim();
  if (!a) return { ok: false, reason: "Address is empty." };
  if (looksLikePlaceholder(a)) return { ok: false, reason: "This looks like a placeholder address." };
  const c = chain.toUpperCase();
  if (EVM_CHAINS.has(c)) {
    return EVM_ADDRESS_RE.test(a)
      ? { ok: true }
      : { ok: false, reason: `"${a.slice(0, 12)}…" is not a valid EVM address (0x + 40 hex chars).` };
  }
  if (c === "BTC") {
    return BTC_ADDRESS_RE.test(a) ? { ok: true } : { ok: false, reason: "Not a recognizable Bitcoin address." };
  }
  if (c === "BCH") {
    // legacy base58 or CashAddr (with or without the bitcoincash: prefix)
    return BTC_ADDRESS_RE.test(a) || /^(bitcoincash:)?[qp][a-z0-9]{40,}$/i.test(a)
      ? { ok: true }
      : { ok: false, reason: "Not a recognizable Bitcoin Cash address." };
  }
  if (c === "LTC") {
    return LTC_ADDRESS_RE.test(a) ? { ok: true } : { ok: false, reason: "Not a recognizable Litecoin address." };
  }
  if (c === "DOGE") {
    return DOGE_ADDRESS_RE.test(a) ? { ok: true } : { ok: false, reason: "Not a recognizable Dogecoin address." };
  }
  if (c === "SOL") {
    return SOL_ADDRESS_RE.test(a) ? { ok: true } : { ok: false, reason: "Not a recognizable Solana address." };
  }
  // Other chain families have no format rule here yet. Catch the one mistake
  // that is both common and unrecoverable — pasting an EVM address into a
  // non-EVM payout field — and otherwise fall back to a length check.
  if (KNOWN_NON_EVM_CHAINS.has(c) && EVM_ADDRESS_RE.test(a)) {
    return { ok: false, reason: `That is an EVM (0x…) address, but ${c} does not use them. Funds sent there are unrecoverable.` };
  }
  if (c !== "BTC" && KNOWN_NON_EVM_CHAINS.has(c) && /^bc1[a-zA-HJ-NP-Z0-9]{20,}$/.test(a)) {
    return { ok: false, reason: `That is a Bitcoin address, but this payout is on ${c}.` };
  }
  return a.length >= 8 ? { ok: true } : { ok: false, reason: "Address is too short." };
}

export interface PreparedDeposit {
  depositAddress: string;
  network: string;
  protocol: string;
  amountDisplay: string;
  amountBaseUnits: string; // recomputed exactly by the CLI
  decimals: number;
  paymentUri: string | null;
  memo: string | null;
  expiresAt: number | null; // epoch ms
  chainflipChannelId: number | string | null;
  warnings: string[];
  raw: WireDepositAddressResponse;
}

function parseExpiry(v: WireDepositAddressResponse["expires_at"]): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // ms vs s heuristic
  const parsed = Date.parse(String(v));
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(v);
  if (Number.isFinite(asNum)) return asNum > 1e12 ? asNum : asNum * 1000;
  return null;
}

// BIP-21 style schemes we construct ourselves. A chain that is absent falls
// back to a bare address, which every wallet handles and no wallet misparses.
// EVM is deliberately absent: wallets have been observed mangling EIP-681
// token URIs, so that lane already shows the address alone.
const PAYMENT_URI_SCHEMES: Record<string, string> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  DOGE: "dogecoin",
  BCH: "bitcoincash"
};

// Build the payment URI from values we validated ourselves.
//
// The server's payment_uri is never used. It used to be accepted on a
// substring test — "does the URI contain our address?" — and containment is
// not authority: `bitcoin:<attacker>?label=<our address>` satisfies it while
// paying the attacker, and for every non-EVM chain that URI became the QR
// payload verbatim. We already hold the validated address and the exact
// amount, so the server's version can add nothing except risk.
function buildPaymentUri(chain: string, address: string, amountDisplay: string): string | null {
  const scheme = PAYMENT_URI_SCHEMES[chain.trim().toUpperCase()];
  if (!scheme) return null;
  return `${scheme}:${address}?amount=${amountDisplay}`;
}

export async function prepareDepositAddress(
  api: LeoKitApi,
  opts: {
    quoteId: string;
    offer: RouteOffer;
    amountDisplay: string;
    toAddress: string;
    fromAddress?: string;
    sourceChain?: string; // fallback for address-format validation when the response omits network
  }
): Promise<PreparedDeposit> {
  if (!opts.quoteId || !opts.quoteId.trim()) {
    throw new CliError("INTERNAL", "Missing quote id for deposit preparation — refusing to send the request.");
  }
  if (!DEPOSIT_QR_SAFE_PROTOCOLS.has(opts.offer.protocol)) {
    throw new CliError(
      "DEPOSIT_UNSUPPORTED",
      `Route "${opts.offer.protocol}" cannot be paid safely by plain deposit address from this CLI.`,
      { actions: [{ label: "Choose a deposit-capable route", command: "openswap swap" }] }
    );
  }
  const requestProtocol = opts.offer.protocol === "relay" ? "relay-deposit" : opts.offer.protocol;

  const res = await api.createDepositAddress({
    quote_id: opts.quoteId,
    protocol: requestProtocol,
    to_address: opts.toAddress,
    ...(opts.fromAddress ? { from_address: opts.fromAddress } : {})
  });

  const warnings: string[] = [];

  // 1. The prepared protocol must match the plan the user approved.
  const gotProtocol = String(res.protocol ?? "");
  if (gotProtocol && gotProtocol !== requestProtocol && gotProtocol !== opts.offer.protocol) {
    throw new CliError(
      "VALIDATION",
      `LeoKit prepared protocol "${gotProtocol}" but you approved "${opts.offer.protocol}". Nothing was paid — request a fresh quote.`,
      { details: { requested: requestProtocol, received: gotProtocol } }
    );
  }

  // 2. A real, non-placeholder deposit address — clean and format-valid, so
  //    what's displayed, copied to the clipboard, and QR-encoded is guaranteed
  //    to be the same well-formed string.
  const depositAddress = String(res.deposit_address ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (!depositAddress || looksLikePlaceholder(depositAddress) || /[\x00-\x1f\x7f]/.test(depositAddress)) {
    throw new CliError("UPSTREAM", "LeoKit returned an unusable deposit address. Nothing was paid.", {
      details: { deposit_address_head: depositAddress.slice(0, 12) }
    });
  }
  // The deposit address lives on the SOURCE chain by definition — the chain
  // the CLI already knows outranks the backend's label for validation.
  const depositNetwork = opts.sourceChain || String(res.network ?? "");
  if (depositNetwork) {
    const addrCheck = validateAddressForChain(depositNetwork, depositAddress);
    if (!addrCheck.ok) {
      throw new CliError(
        "UPSTREAM",
        `LeoKit returned a deposit address that doesn't match ${depositNetwork}'s format (${addrCheck.reason ?? "unrecognized"}). Nothing was paid.`,
        { details: { deposit_address_head: depositAddress.slice(0, 12), network: depositNetwork } }
      );
    }
  }

  // 3. Exact amount: recompute base units ourselves with integer math — a
  //    server-derived value is never trusted for payment amounts.
  const amountDisplay = parseDecimalInput(String(res.amount ?? opts.amountDisplay));
  if (amountDisplay !== parseDecimalInput(opts.amountDisplay)) {
    throw new CliError(
      "VALIDATION",
      `LeoKit's deposit amount (${amountDisplay}) differs from your approved amount (${opts.amountDisplay}). Nothing was paid — request a fresh quote.`
    );
  }
  const decimals = Number(res.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new CliError("UPSTREAM", "LeoKit returned invalid decimals for the deposit amount.");
  }
  const amountBaseUnits = toBaseUnits(amountDisplay, decimals).toString();
  if (typeof res.amount_raw === "string" && /^\d+$/.test(res.amount_raw) && res.amount_raw !== amountBaseUnits) {
    warnings.push(
      `Server base-unit amount (${res.amount_raw}) differs from the exact conversion (${amountBaseUnits}); the exact value is used. Verify the amount in your wallet.`
    );
  }

  // 4. Payment URI is CONSTRUCTED from the address and amount validated above.
  //    res.payment_uri is intentionally never read — see buildPaymentUri.
  const paymentUri = buildPaymentUri(depositNetwork, depositAddress, amountDisplay);

  return {
    depositAddress,
    network: String(res.network ?? ""),
    protocol: gotProtocol || requestProtocol,
    amountDisplay,
    amountBaseUnits,
    decimals,
    paymentUri,
    memo: null, // deposit-address protocols route by address; BOB (memo-required) is excluded
    expiresAt: parseExpiry(res.expires_at),
    chainflipChannelId: (res.chainflip_channel_id as number | string | null) ?? null,
    warnings,
    raw: res
  };
}

export function depositAmountForDisplay(prepared: PreparedDeposit): string {
  return fromBaseUnits(prepared.amountBaseUnits, prepared.decimals);
}
