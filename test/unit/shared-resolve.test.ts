import { describe, expect, it } from "vitest";
import { resolveAssetOrPrompt } from "../../src/commands/shared.js";
import { CliError } from "../../src/core/errors.js";
import type { OutputContext } from "../../src/render/output.js";
import type { AssetToken } from "../../src/core/types.js";

function tok(overrides: Partial<AssetToken>): AssetToken {
  return {
    identifier: "ETH.ETH",
    blockchain: "ETH",
    symbol: "ETH",
    address: null,
    decimals: 18,
    price_usd: 1,
    is_popular: true,
    supports_deposit_address: true,
    ...overrides
  };
}

const TOKENS: AssetToken[] = [
  tok({}),
  tok({ identifier: "BASE.USDC-0x8335", blockchain: "BASE", symbol: "USDC", address: "0x8335" }),
  tok({ identifier: "ETH.USDC-0xa0b8", blockchain: "ETH", symbol: "USDC", address: "0xa0b8" }),
  tok({ identifier: "BTC.BTC", blockchain: "BTC", symbol: "BTC" })
];

const ctx = (command: string): OutputContext => ({ mode: "json", noInput: true, command });

async function thrownBy(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    return err as CliError;
  }
  throw new Error("expected rejection");
}

// In machine mode nobody can answer a prompt, so the wrong-chain suggestions
// must arrive as commands an agent (or a copy-paste) can run — not as bare
// identifiers, which is what the resolver-level error carries.
describe("resolveAssetOrPrompt in machine mode rewrites suggestions into commands", () => {
  it("swaps the failed side into the user's own invocation", async () => {
    const err = await thrownBy(
      resolveAssetOrPrompt(ctx("quote"), TOKENS, "BTC.USDC", "receive?", {
        side: "to",
        amount: "25",
        other: "ETH.ETH"
      })
    );
    expect(err.code).toBe("NO_ROUTE");
    expect(err.actions[0]!.command).toBe("openswap quote -a 25 -f ETH.ETH -t ETH.USDC-0xa0b8");
    // the generic search escape hatch stays
    expect(err.actions.at(-1)!.command).toContain("openswap assets search");
  });

  it("omits what it does not know instead of inventing it", async () => {
    const err = await thrownBy(
      resolveAssetOrPrompt(ctx("swap"), TOKENS, "BTC.USDC", "receive?", { side: "to" })
    );
    expect(err.actions[0]!.command).toBe("openswap swap -t ETH.USDC-0xa0b8");
  });

  it("keeps the details for JSON consumers", async () => {
    const err = await thrownBy(
      resolveAssetOrPrompt(ctx("quote"), TOKENS, "BTC.USDC", "receive?", { side: "to", other: "ETH.ETH" })
    );
    expect(err.details!.available_elsewhere).toContain("BASE.USDC-0x8335");
  });

  it("leaves errors without suggestions untouched", async () => {
    const err = await thrownBy(
      resolveAssetOrPrompt(ctx("quote"), TOKENS, "ETH.NOTACOIN", "receive?", { side: "to", other: "ETH.ETH" })
    );
    expect(err.code).toBe("NO_ROUTE");
    expect(err.actions.every((a) => (a.command ?? "").startsWith("openswap assets search"))).toBe(true);
  });
});
