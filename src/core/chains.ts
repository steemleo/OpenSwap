// EVM chain registry — viem-free so quote/classification paths can import it
// without pulling the signer stack into every command's cold start.
export interface EvmChainInfo {
  chainId: number;
  rpcUrl: string;
}

// Public default RPCs — override with OPENSWAP_EVM_RPC_URL for serious use.
export const EVM_CHAINS: Record<string, EvmChainInfo> = {
  ETH: { chainId: 1, rpcUrl: "https://ethereum-rpc.publicnode.com" },
  ARB: { chainId: 42161, rpcUrl: "https://arb1.arbitrum.io/rpc" },
  BASE: { chainId: 8453, rpcUrl: "https://mainnet.base.org" },
  OP: { chainId: 10, rpcUrl: "https://mainnet.optimism.io" },
  POL: { chainId: 137, rpcUrl: "https://polygon-rpc.com" },
  POLYGON: { chainId: 137, rpcUrl: "https://polygon-rpc.com" },
  BSC: { chainId: 56, rpcUrl: "https://bsc-dataseed.binance.org" },
  AVAX: { chainId: 43114, rpcUrl: "https://api.avax.network/ext/bc/C/rpc" }
};

export function isEvmChain(chain: string): boolean {
  return chain.toUpperCase() in EVM_CHAINS;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir, isTestMode } from "./paths.js";

// The wallet wizard writes here; loadEvmSigner falls back to it automatically.
export function defaultKeystorePath(): string {
  return join(configDir(), "signer.keystore.json");
}

// True when a signer is configured (env OR the default keystore exists) —
// never reads or validates key material.
export function signerConfigured(): boolean {
  if (isTestMode()) return true; // burned test signer is always available
  return Boolean(
    process.env.OPENSWAP_EVM_PRIVATE_KEY || process.env.LEOKIT_EVM_PRIVATE_KEY ||
    process.env.OPENSWAP_EVM_KEYSTORE || process.env.LEOKIT_EVM_KEYSTORE ||
    existsSync(defaultKeystorePath())
  );
}

// Whether wallet-signed execution may run at all — independent of whether a
// key is configured.
//
// Withheld from the default build: validateEvmPlan accepts arbitrary
// backend-authored calldata (an ERC-20 transfer of the whole balance carries no
// native value and is not an approve, so it clears every current check), the
// receipt is written after broadcast, and this lane takes no idempotency
// reservation. Until those are fixed a hostile or compromised backend could
// drain a signing wallet, so the lane ships off.
//
// The default noncustodial deposit lane — user pays from their own wallet, CLI
// never holds a key — is unaffected.
//
// Test mode keeps it on: a burned key against an in-process simulated RPC, so
// no real funds can move and the lane stays covered by tests until it returns.
export function signerLaneEnabled(): boolean {
  if (isTestMode()) return true;
  return process.env.OPENSWAP_ENABLE_SIGNER === "1";
}

export const SIGNER_LANE_DISABLED_REASON =
  "Wallet-signed execution is turned off in this release while its transaction validation is hardened. Deposit-address routes are unaffected.";

// Protocols that need the signing lane (no deposit-address support) — used
// for user education when routes are locked.
export const SIGNER_ONLY_EXAMPLES = "bob, rango, deBridge, 1inch, Across";

export type ExecutionLane = "deposit_address" | "wallet_signed" | "unsupported";
