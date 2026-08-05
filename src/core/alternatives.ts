import { fetchQuotes } from "./quotes.js";
import { CliError } from "./errors.js";
import { formatAmountForDisplay } from "./amount.js";
import type { LeoKitApi } from "./api.js";
import type { AssetToken } from "./types.js";

// "No route" is where users give up, and it is usually not the whole truth:
// the same coin frequently exists on several chains and only some of them
// route. Zcash is the case that surfaced this — native ZEC.ZEC returns
// nothing while SOL.ZEC quotes instantly, and nobody would guess that.
//
// So when a pair fails, try to hand back a working near-miss rather than a
// dead end. Candidates keep ONE side exactly as the user asked and vary the
// other, because the closer the suggestion is to their intent the more likely
// it is to be useful.

export interface Alternative {
  side: "from" | "to";
  token: AssetToken;
  routes: number;
  receiveDisplay: string | null;
}

// Six, not four: a coin typically lists on three or four chains, and the
// budget is split across both sides. Four left one side with two slots, which
// silently skipped the only listing that routed. They run in parallel, so the
// extra probes cost no measurable wall-clock.
const MAX_PROBES = 6;
const PROBE_TIMEOUT_MS = 9000;

// Prefer suggestions a user can actually act on. Deposit-address support only
// counts when the caller needs it: `swap` can execute nothing else, but for a
// read-only quote it is irrelevant, and ranking on it buried BSC.ZEC — the one
// listing that quotes ZEC into USDC — below two that do not.
function rank(a: AssetToken, b: AssetToken, depositOnly: boolean): number {
  if (a.is_popular !== b.is_popular) return a.is_popular ? -1 : 1;
  if (depositOnly && a.supports_deposit_address !== b.supports_deposit_address) {
    return a.supports_deposit_address ? -1 : 1;
  }
  const priced = (b.price_usd ? 1 : 0) - (a.price_usd ? 1 : 0);
  if (priced !== 0) return priced;
  return a.identifier.localeCompare(b.identifier);
}

function sameSymbolElsewhere(tokens: AssetToken[], token: AssetToken, depositOnly: boolean): AssetToken[] {
  const symbol = token.symbol.toUpperCase();
  return tokens
    .filter((t) => t.symbol.toUpperCase() === symbol && t.identifier !== token.identifier)
    .sort((a, b) => rank(a, b, depositOnly));
}

async function probe(
  api: LeoKitApi,
  params: { from_asset: string; to_asset: string; amount: string },
  depositOnly: boolean
): Promise<{ routes: number; receiveDisplay: string | null } | null> {
  try {
    const set = await Promise.race([
      fetchQuotes(api, params, { depositOnly }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS))
    ]);
    if (!set.offers.length) return null;
    const best = set.offers[0]!;
    return { routes: set.offers.length, receiveDisplay: best.expectedOutDisplay };
  } catch {
    // A failing probe is just "no suggestion here" — it must never turn the
    // user's original no-route error into something noisier.
    return null;
  }
}

// Returns only alternatives PROVEN to quote. Suggesting a route that also
// fails would be worse than saying nothing.
export async function findAlternatives(
  api: LeoKitApi,
  tokens: AssetToken[],
  from: AssetToken,
  to: AssetToken,
  amount: string,
  opts: { depositOnly?: boolean; max?: number } = {}
): Promise<Alternative[]> {
  const depositOnly = opts.depositOnly ?? false;
  const budget = opts.max ?? MAX_PROBES;

  // Alternate sides rather than queueing one behind the other. A common asset
  // carries dozens of listings — USDC has 25 — so taking them in order spends
  // the entire budget on one side and never tests the other, which is fatal
  // when the untested side is the broken one. Destination goes first on each
  // turn: the ask is usually "I want X", so it is the likelier intent.
  const toSide = sameSymbolElsewhere(tokens, to, depositOnly).map((t) => ({ side: "to" as const, token: t }));
  const fromSide = sameSymbolElsewhere(tokens, from, depositOnly).map((t) => ({ side: "from" as const, token: t }));
  const candidates: Array<{ side: "from" | "to"; token: AssetToken }> = [];
  for (let i = 0; candidates.length < budget && (i < toSide.length || i < fromSide.length); i++) {
    if (i < toSide.length) candidates.push(toSide[i]!);
    if (candidates.length < budget && i < fromSide.length) candidates.push(fromSide[i]!);
  }

  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async (c) => {
      const params =
        c.side === "to"
          ? { from_asset: from.identifier, to_asset: c.token.identifier, amount }
          : { from_asset: c.token.identifier, to_asset: to.identifier, amount };
      const hit = await probe(api, params, depositOnly);
      return hit ? { side: c.side, token: c.token, routes: hit.routes, receiveDisplay: hit.receiveDisplay } : null;
    })
  );

  return results.filter((r): r is Alternative => r !== null);
}

// A runnable command for the suggestion, so the user can copy it rather than
// work out an identifier they had no way to know existed.
export function alternativeCommand(
  command: "quote" | "swap",
  alt: Alternative,
  from: AssetToken,
  to: AssetToken,
  amount: string
): string {
  const f = alt.side === "from" ? alt.token.identifier : from.identifier;
  const t = alt.side === "to" ? alt.token.identifier : to.identifier;
  return `openswap ${command} -a ${amount} -f ${f} -t ${t}`;
}

// Always name the unit. On a funding-side suggestion the quoted number is in
// the DESTINATION's asset, so a bare figure next to "USDC on BASE" would read
// as the wrong currency entirely.
export function alternativeLabel(alt: Alternative, to: AssetToken): string {
  const where = alt.token.blockchain || alt.token.identifier.split(".")[0];
  const what =
    alt.side === "to" ? `${alt.token.symbol} on ${where}` : `pay with ${alt.token.symbol} on ${where}`;
  if (!alt.receiveDisplay) return what;
  const receiveSymbol = alt.side === "to" ? alt.token.symbol : to.symbol;
  return `${what} — get ${formatAmountForDisplay(alt.receiveDisplay)} ${receiveSymbol}`;
}

// Turns a bare NO_ROUTE into one that names a way forward. Enriching the error
// object (rather than printing) means human output, --json and agents all pick
// the suggestions up from the same place: actions render in the error block and
// details ride the JSON envelope.
export async function enrichNoRoute(
  err: unknown,
  ctx: {
    api: LeoKitApi;
    tokens: AssetToken[];
    from: AssetToken;
    to: AssetToken;
    amount: string;
    command: "quote" | "swap";
    depositOnly?: boolean;
    // Paired so the caller's spinner is always stopped, including when the
    // search finds nothing or throws — a stuck spinner would eat the error.
    onStart?: () => void;
    onDone?: (found: number) => void;
  }
): Promise<unknown> {
  if (!(err instanceof CliError) || err.code !== "NO_ROUTE") return err;

  let alts: Alternative[];
  ctx.onStart?.();
  try {
    alts = await findAlternatives(ctx.api, ctx.tokens, ctx.from, ctx.to, ctx.amount, {
      depositOnly: ctx.depositOnly
    });
  } catch {
    ctx.onDone?.(0);
    return err; // never let the search itself replace the user's real error
  }
  ctx.onDone?.(alts.length);
  if (alts.length === 0) return err;

  return new CliError(
    "NO_ROUTE",
    `${err.message} These do route right now:`,
    {
      retryable: err.retryable,
      actions: [
        ...alts.map((a) => ({
          label: alternativeLabel(a, ctx.to),
          command: alternativeCommand(ctx.command, a, ctx.from, ctx.to, ctx.amount)
        })),
        ...err.actions
      ],
      details: {
        ...err.details,
        alternatives: alts.map((a) => ({
          side: a.side,
          asset: a.token.identifier,
          symbol: a.token.symbol,
          blockchain: a.token.blockchain,
          routes: a.routes,
          expected_out_display: a.receiveDisplay
        }))
      }
    }
  );
}
