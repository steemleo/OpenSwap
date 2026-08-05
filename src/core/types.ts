// Wire types for the LeoKit API, verified against live responses.

export interface AssetToken {
  identifier: string; // CHAIN.SYMBOL or CHAIN.SYMBOL-ADDRESS
  blockchain: string;
  symbol: string;
  address: string | null;
  decimals: number | null; // null for natives — resolved via NATIVE_ASSET_DECIMALS parity map
  price_usd: number | null;
  is_popular: boolean;
  supports_deposit_address: boolean;
}

export interface WireFee {
  type: string;
  asset: string;
  amount: number | string | null;
  usd: number | null;
  // Set locally (never by the wire) when this line is a component of another
  // fee that already covers it — e.g. relay's `relayerGas`/`relayerService`
  // inside `relayer Fee`. Such lines stay visible but are excluded from the
  // total, so the list stays complete without being double-counted.
  component_of?: string;
}

// data payload inside each quote offer. expected_amount_out arrives as a JSON
// number in BASE units — parsed into a string by the bigint-preserving pass.
export interface WireOfferData {
  protocol: string;
  expected_amount_out: string | number;
  expected_amount_out_usd: number | null;
  input_amount_usd: number | null;
  expires_at: number; // epoch ms
  ttl_seconds: number;
  total_swap_seconds: number | null;
  out_asset_decimal: number;
  in_asset_decimal: number;
  out_asset_price?: string | number;
  from_asset_price?: string | number;
  fees: WireFee[];
  route: string[];
  supports_deposit_address?: boolean;
  min_swap_amount?: number | string; // minimum INPUT (Maya/Thor), not min-receive
  recommended_slippage?: number | string;
  type?: string; // chainflip REGULAR/DCA
  is_boostable?: boolean;
  confidentiality?: unknown; // NEAR
  [key: string]: unknown;
}

export interface WireQuoteOffer {
  protocol: string;
  data: WireOfferData;
  expectedAmountOutNum?: number; // lossy server-side float — never used for math
  totalFeesUsd?: number; // can be NaN upstream (null fee usd) — recomputed locally
  totalSwapSeconds?: number;
  flags?: string[]; // FASTEST | CHEAPEST | OPTIMAL — recomputed locally
}

export interface WireQuoteResponse {
  quotes: WireQuoteOffer[];
  timestamp: string;
  quote_id: string;
}

export interface WireDepositAddressResponse {
  deposit_address: string;
  amount: string | number; // display units
  amount_raw: string; // upstream float-derived — CLI recomputes, see deposit.ts
  decimals: number;
  from_asset: string;
  to_asset: string;
  network: string;
  protocol: string; // must match the requested protocol — validated
  chainflip_channel_id: number | string | null;
  payment_uri: string | null;
  qr_url: string | null; // public CDN — the CLI never fetches this
  expires_at: number | string | null;
  [key: string]: unknown;
}

// /status returns two shapes: live (scanner_url) and DB-cached terminal
// (scanner/hash/network). NormalizedStatus is the CLI's single canonical form.
export interface WireStatusLive {
  status: string;
  type?: string;
  protocol?: string;
  in_amount?: number | string;
  out_amount?: number | string;
  from_token?: string;
  to_token?: string;
  from_address?: string;
  to_address?: string;
  dest_tx_hash?: string | null;
  refund_tx_hash?: string | null;
  error?: string | null;
  date?: string | number;
  status_url?: string | null;
  scanner_url?: string | null;
  native_scanner_url?: string | null;
  [key: string]: unknown;
}

export interface WireStatusCached {
  status: string;
  protocol?: string;
  scanner?: string | null;
  native_scanner?: string | null;
  hash?: string | null;
  network?: string;
  req_id?: string;
  [key: string]: unknown;
}

export type SwapState =
  | "pending"
  | "confirming"
  | "swapping"
  | "sending"
  | "success"
  | "failed"
  | "refunded";

export const TERMINAL_STATES: ReadonlySet<SwapState> = new Set(["success", "failed", "refunded"]);

// Why a reported status cannot be taken at face value. Codes are stable —
// machine consumers may branch on them.
export interface StatusImplausibility {
  code:
    | "SUCCESS_WITHOUT_DEST_TX"
    | "OUT_AMOUNT_LOOKS_LIKE_BASE_UNITS"
    | "OUT_AMOUNT_FAR_FROM_QUOTE"
    | "SUCCESS_TOO_SOON";
  message: string;
}

export interface NormalizedStatus {
  state: SwapState;
  protocol: string | null;
  inAmount: string | null;
  outAmount: string | null;
  fromToken: string | null;
  toToken: string | null;
  destTxHash: string | null;
  refundTxHash: string | null;
  error: string | null;
  scannerUrl: string | null;
  nativeScannerUrl: string | null;
  // Present when the wire state fails corroboration (see statusImplausibilities).
  // Optional so plain normalizeStatus construction sites stay valid.
  implausible?: StatusImplausibility[];
  raw: Record<string, unknown>;
}

// Normalized quote offer — everything the renderers and policy engine consume.
export interface RouteOffer {
  protocol: string;
  variant: string | null; // e.g. chainflip DCA
  expectedOutBase: string; // exact base-unit integer string
  expectedOutDisplay: string; // exact display conversion
  expectedOutUsd: number | null;
  inputUsd: number | null;
  outDecimals: number;
  inDecimals: number;
  feesTotalUsd: number | null; // null when any component is unpriced — never 0
  feesComplete: boolean;
  fees: WireFee[];
  etaSeconds: number | null;
  expiresAt: number; // epoch ms
  ttlSeconds: number;
  route: string[];
  supportsDepositAddress: boolean | null; // null = not stated (plain /quote) — determined at swap time
  minInputDisplay: string | null;
  recommendedSlippageBps: number | null;
  flags: { bestOutput: boolean; fastest: boolean; cheapest: boolean };
  raw: WireOfferData;
}

export interface QuoteSet {
  quoteId: string;
  timestamp: string;
  fromAsset: string;
  toAsset: string;
  amountDisplay: string;
  offers: RouteOffer[];
}

export interface ReceiptV1 {
  schema_version: "1";
  receipt_id: string; // lk_...
  created_at: string;
  updated_at: string;
  environment: "mainnet" | "simulated";
  api_url: string;
  quote_id: string;
  protocol: string;
  from_asset: string;
  to_asset: string;
  amount_display: string;
  amount_base_units: string;
  expected_out_display: string;
  expected_out_usd: number | null;
  destination_address: string;
  refund_address: string | null;
  deposit: {
    deposit_address: string;
    payment_uri: string | null;
    memo: string | null;
    network: string;
    expires_at: number | null;
    chainflip_channel_id: number | string | null;
  } | null;
  tx_hashes: { source: string | null; destination: string | null; refund: string | null };
  last_state: SwapState | "created" | "awaiting_payment" | "expired" | "unknown";
  last_checked_at: string | null;
  last_error: string | null;
  notes: string | null;
}
