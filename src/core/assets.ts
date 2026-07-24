import { readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { cacheDir, ensureDir } from "./paths.js";
import { CliError } from "./errors.js";
import type { AssetToken } from "./types.js";
import type { LeoKitApi } from "./api.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "assets-v1.json.gz";

// Chain aliases people actually type. Canonical chain codes come from the live
// asset list — this map only translates human shorthand.
const CHAIN_ALIASES: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  arbitrum: "ARB",
  avalanche: "AVAX",
  polygon: "POL",
  matic: "POL",
  optimism: "OP",
  binance: "BSC",
  bnb: "BSC",
  solana: "SOL",
  litecoin: "LTC",
  dogecoin: "DOGE",
  cosmos: "GAIA",
  atom: "GAIA",
  thorchain: "THOR",
  mayachain: "MAYA",
  zcash: "ZEC",
  base: "BASE",
  near: "NEAR",
  tron: "TRON"
};

// Curated chain prominence for sorting choices. The asset feed carries no
// volume data, so this is the product's opinion of "top chains" — edit the
// order here to change every picker/search ranking at once.
const CHAIN_RANK_ORDER = [
  "ETH", "BTC", "SOL", "BASE", "ARB", "BSC", "OP", "POL", "AVAX",
  "THOR", "MAYA", "NEAR", "LTC", "DOGE", "BCH", "ZEC", "GAIA", "TRON",
  "TON", "XRP", "DASH", "KUJI", "APTOS", "HYPEREVM", "HYPERCORE"
];
const CHAIN_RANK = new Map(CHAIN_RANK_ORDER.map((c, i) => [c, i]));

export function chainRank(chain: string): number {
  return CHAIN_RANK.get(chain.toUpperCase()) ?? CHAIN_RANK_ORDER.length;
}

function cachePath(): string {
  return join(cacheDir(), CACHE_FILE);
}

function pruneToken(raw: Record<string, unknown>): AssetToken | null {
  const identifier = typeof raw.identifier === "string" ? raw.identifier : null;
  const blockchain = typeof raw.blockchain === "string" ? raw.blockchain : null;
  const symbol = typeof raw.symbol === "string" ? raw.symbol : null;
  if (!identifier || !blockchain || !symbol) return null;
  return {
    identifier,
    blockchain,
    symbol,
    address: typeof raw.address === "string" ? raw.address : null,
    decimals: typeof raw.decimals === "number" ? raw.decimals : null,
    price_usd: typeof raw.price_usd === "number" ? raw.price_usd : null,
    is_popular: raw.is_popular === true,
    supports_deposit_address: raw.supports_deposit_address === true
  };
}

export function readAssetCache(): { tokens: AssetToken[]; fetchedAt: number } | null {
  try {
    const buf = readFileSync(cachePath());
    const parsed = JSON.parse(gunzipSync(buf).toString("utf8")) as {
      fetched_at: number;
      tokens: AssetToken[];
    };
    if (!Array.isArray(parsed.tokens)) return null;
    return { tokens: parsed.tokens, fetchedAt: parsed.fetched_at };
  } catch {
    return null;
  }
}

export function assetCacheAgeMs(): number | null {
  try {
    return Date.now() - statSync(cachePath()).mtimeMs;
  } catch {
    return null;
  }
}

export async function loadAssets(api: LeoKitApi, opts: { forceRefresh?: boolean } = {}): Promise<AssetToken[]> {
  const cached = readAssetCache();
  if (!opts.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tokens;
  }
  try {
    const raw = await api.getAssetsRaw();
    // the live list contains duplicate identifier rows — dedupe, merging flags
    const byId = new Map<string, AssetToken>();
    for (const t of raw.tokens) {
      const pruned = pruneToken(t as Record<string, unknown>);
      if (!pruned) continue;
      const existing = byId.get(pruned.identifier);
      if (existing) {
        existing.is_popular = existing.is_popular || pruned.is_popular;
        existing.supports_deposit_address = existing.supports_deposit_address || pruned.supports_deposit_address;
        existing.decimals = existing.decimals ?? pruned.decimals;
        existing.price_usd = existing.price_usd ?? pruned.price_usd;
      } else {
        byId.set(pruned.identifier, pruned);
      }
    }
    const tokens = [...byId.values()];
    if (tokens.length === 0) throw new CliError("UPSTREAM", "LeoKit /assets returned no tokens.");
    ensureDir(cacheDir());
    const payload = gzipSync(Buffer.from(JSON.stringify({ fetched_at: Date.now(), tokens }), "utf8"));
    const tmp = cachePath() + ".tmp";
    writeFileSync(tmp, payload);
    renameSync(tmp, cachePath());
    return tokens;
  } catch (err) {
    // Stale cache beats a hard failure for read-only asset resolution.
    if (cached) return cached.tokens;
    throw err;
  }
}

export interface ResolvedAsset {
  token: AssetToken;
  exact: boolean;
}

export interface AmbiguousAsset {
  ambiguous: true;
  candidates: AssetToken[];
}

function normalizeChain(chain: string): string {
  const c = chain.trim();
  return (CHAIN_ALIASES[c.toLowerCase()] ?? c).toUpperCase();
}

// Accepted grammars:
//   CHAIN.SYMBOL-ADDRESS   canonical, exact
//   CHAIN.SYMBOL           canonical native/token without address
//   chain:symbol           friendly (base:USDC, bitcoin:btc)
//   SYMBOL                 bare symbol — ambiguity resolved by caller
export function resolveAsset(tokens: AssetToken[], input: string): ResolvedAsset | AmbiguousAsset {
  const raw = input.trim();
  if (!raw) throw new CliError("VALIDATION", "Asset is required.");

  // natural speech: "usdc on base" / "USDC ON ETH"
  const onMatch = raw.match(/^(\S+)\s+on\s+(\S+)$/i);
  if (onMatch) {
    return resolveChainSymbol(tokens, onMatch[2]!, onMatch[1]!);
  }

  // two words without "on": "base usdc" (chain first) or "usdc base" (symbol first)
  const words = raw.split(/\s+/);
  if (words.length === 2) {
    const knownChains = new Set(tokens.map((t) => t.blockchain.toUpperCase()));
    const orderings: Array<[string, string]> = [
      [words[0]!, words[1]!],
      [words[1]!, words[0]!]
    ];
    for (const [chainPart, symbolPart] of orderings) {
      if (!knownChains.has(normalizeChain(chainPart))) continue;
      try {
        return resolveChainSymbol(tokens, chainPart, symbolPart);
      } catch (err) {
        if (!(err instanceof CliError && err.code === "NO_ROUTE")) throw err;
        // that ordering had no such asset — try the other one
      }
    }
  }

  // canonical identifier (case-sensitive address part)
  if (raw.includes(".")) {
    const exact = tokens.find((t) => t.identifier.toLowerCase() === raw.toLowerCase());
    if (exact) return { token: exact, exact: true };
    const [chainPart, rest] = raw.split(".", 2);
    if (chainPart && rest) {
      return resolveChainSymbol(tokens, chainPart, rest.split("-")[0] ?? rest);
    }
  }

  if (raw.includes(":")) {
    const [chainPart, symbolPart] = raw.split(":", 2);
    if (!chainPart || !symbolPart) {
      throw new CliError("VALIDATION", `Could not parse asset "${input}". Use chain:symbol, e.g. base:USDC.`);
    }
    return resolveChainSymbol(tokens, chainPart, symbolPart);
  }

  // bare symbol
  const symbol = raw.toUpperCase();
  const matches = tokens.filter((t) => t.symbol.toUpperCase() === symbol);
  if (matches.length === 0) {
    throw new CliError("NO_ROUTE", `No supported asset matches "${input}".`, {
      actions: [{ label: "Search supported assets", command: `openswap assets search ${raw}` }]
    });
  }
  if (matches.length === 1) return { token: matches[0]!, exact: false };
  return { ambiguous: true, candidates: rankCandidates(matches) };
}

function resolveChainSymbol(tokens: AssetToken[], chainInput: string, symbolInput: string): ResolvedAsset | AmbiguousAsset {
  const chain = normalizeChain(chainInput);
  const symbol = symbolInput.trim().toUpperCase();
  const matches = tokens.filter(
    (t) => t.blockchain.toUpperCase() === chain && t.symbol.toUpperCase() === symbol
  );
  if (matches.length === 0) {
    throw new CliError("NO_ROUTE", `No supported asset "${symbol}" on ${chain}.`, {
      actions: [{ label: "Search supported assets", command: `openswap assets search ${symbolInput}` }]
    });
  }
  if (matches.length === 1) return { token: matches[0]!, exact: false };
  // the chain's native asset wins over wrapped/token variants of the same symbol
  const native = matches.find((t) => t.address === null && t.identifier === `${chain}.${symbol}`);
  if (native) return { token: native, exact: false };
  // same symbol twice on one chain (different contracts) — prefer popular,
  // then the deposit-capable contract (the canonical listing), else ambiguous
  const popular = matches.filter((t) => t.is_popular);
  if (popular.length === 1) return { token: popular[0]!, exact: false };
  const pool = popular.length > 0 ? popular : matches;
  const depositCapable = pool.filter((t) => t.supports_deposit_address);
  if (depositCapable.length === 1) return { token: depositCapable[0]!, exact: false };
  return { ambiguous: true, candidates: rankCandidates(matches) };
}

// Ambiguity lists lead with what users most likely mean: popular assets on
// top chains, deposit-capable contracts first, then priced, then alphabetical.
function rankCandidates(matches: AssetToken[]): AssetToken[] {
  return [...matches].sort((a, b) => {
    if (a.is_popular !== b.is_popular) return a.is_popular ? -1 : 1;
    const rank = chainRank(a.blockchain) - chainRank(b.blockchain);
    if (rank !== 0) return rank;
    if (a.supports_deposit_address !== b.supports_deposit_address) {
      return a.supports_deposit_address ? -1 : 1;
    }
    const priced = (b.price_usd ? 1 : 0) - (a.price_usd ? 1 : 0);
    if (priced !== 0) return priced;
    return a.identifier.localeCompare(b.identifier);
  });
}

export function searchAssets(tokens: AssetToken[], query: string, limit = 25): AssetToken[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ t: AssetToken; score: number }> = [];
  for (const t of tokens) {
    const sym = t.symbol.toLowerCase();
    const id = t.identifier.toLowerCase();
    let score = -1;
    if (sym === q) score = 100;
    else if (sym.startsWith(q)) score = 80;
    else if (id.startsWith(q)) score = 60;
    else if (sym.includes(q)) score = 40;
    else if (id.includes(q)) score = 20;
    if (score < 0) continue;
    if (t.is_popular) score += 15;
    if (t.price_usd) score += 5;
    scored.push({ t, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      chainRank(a.t.blockchain) - chainRank(b.t.blockchain) ||
      a.t.identifier.localeCompare(b.t.identifier)
  );
  return scored.slice(0, limit).map((s) => s.t);
}

// The backend's is_popular flag includes junk tokens whose punctuation/emoji
// identifiers sort to the top — the "what can I swap?" screen must lead with
// majors, not scam-looking symbols.
const MAJOR_RANK = new Map(
  [
    "BTC", "ETH", "USDC", "USDT", "SOL", "BNB", "XRP", "DOGE", "LTC", "AVAX",
    "POL", "ARB", "OP", "NEAR", "ATOM", "DOT", "LINK", "UNI", "AAVE", "WBTC",
    "WETH", "DAI", "TON", "TRX", "BCH", "RUNE", "CACAO", "FLIP", "ZEC", "LEO"
  ].map((s, i) => [s, i] as const)
);
const CLEAN_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/;

export function popularAssets(tokens: AssetToken[], limit = 30): AssetToken[] {
  const rank = (t: AssetToken): number => MAJOR_RANK.get(t.symbol.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  return tokens
    .filter((t) => t.is_popular && CLEAN_SYMBOL.test(t.symbol))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        chainRank(a.blockchain) - chainRank(b.blockchain) ||
        a.symbol.localeCompare(b.symbol) ||
        a.identifier.localeCompare(b.identifier)
    )
    .slice(0, limit);
}
