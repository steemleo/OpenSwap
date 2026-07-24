// Test-mode fixtures: a curated snapshot of major assets with their REAL
// identifiers and decimals, so resolution grammar ("base usdc", chain:symbol)
// behaves exactly like production. Prices are a static snapshot — test mode
// never claims live prices — with seeded jitter applied per world.

export interface FixtureAsset {
  identifier: string;
  blockchain: string;
  symbol: string;
  address: string | null;
  decimals: number;
  price_usd: number;
  is_popular: boolean;
  supports_deposit_address: boolean;
}

const A = (
  identifier: string,
  blockchain: string,
  symbol: string,
  address: string | null,
  decimals: number,
  price_usd: number,
  supports_deposit_address = true
): FixtureAsset => ({ identifier, blockchain, symbol, address, decimals, price_usd, is_popular: true, supports_deposit_address });

export const FIXTURE_ASSETS: FixtureAsset[] = [
  A("BTC.BTC", "BTC", "BTC", null, 8, 66000),
  A("ETH.ETH", "ETH", "ETH", null, 18, 1840),
  A("ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "ETH", "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, 1),
  A("ETH.USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7", "ETH", "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, 1),
  A("ETH.WBTC-0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "ETH", "WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, 65900),
  A("ETH.DAI-0x6B175474E89094C44Da98b954EedeAC495271d0F", "ETH", "DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, 1),
  A("ETH.LINK-0x514910771AF9Ca656af840dff83E8264EcF986CA", "ETH", "LINK", "0x514910771AF9Ca656af840dff83E8264EcF986CA", 18, 11.4),
  A("ETH.UNI-0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "ETH", "UNI", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18, 6.2),
  A("ETH.AAVE-0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", "ETH", "AAVE", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", 18, 132),
  A("BASE.ETH", "BASE", "ETH", null, 18, 1840),
  A("BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "BASE", "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, 1),
  A("BASE.CBBTC-0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "BASE", "CBBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, 65950),
  A("ARB.ETH", "ARB", "ETH", null, 18, 1840),
  A("ARB.USDC-0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "ARB", "USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, 1),
  A("ARB.USDT-0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "ARB", "USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, 1),
  A("ARB.ARB-0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB", "ARB", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18, 0.62),
  A("OP.ETH", "OP", "ETH", null, 18, 1840),
  A("OP.USDC-0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "OP", "USDC", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6, 1),
  A("OP.OP-0x4200000000000000000000000000000000000042", "OP", "OP", "0x4200000000000000000000000000000000000042", 18, 1.1),
  A("POL.POL", "POL", "POL", null, 18, 0.31),
  A("POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "POL", "USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6, 1),
  A("BSC.BNB", "BSC", "BNB", null, 18, 560),
  A("BSC.USDT-0x55d398326f99059fF775485246999027B3197955", "BSC", "USDT", "0x55d398326f99059fF775485246999027B3197955", 18, 1),
  A("AVAX.AVAX", "AVAX", "AVAX", null, 18, 22),
  A("AVAX.USDC-0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "AVAX", "USDC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6, 1),
  A("SOL.SOL", "SOL", "SOL", null, 9, 152),
  A("SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "SOL", "USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6, 1),
  A("NEAR.NEAR", "NEAR", "NEAR", null, 24, 3.1),
  A("NEAR.USDC-usdc.near", "NEAR", "USDC", "usdc.near", 6, 1),
  A("LTC.LTC", "LTC", "LTC", null, 8, 78),
  A("DOGE.DOGE", "DOGE", "DOGE", null, 8, 0.12),
  A("BCH.BCH", "BCH", "BCH", null, 8, 340),
  A("ZEC.ZEC", "ZEC", "ZEC", null, 8, 38),
  A("XRP.XRP", "XRP", "XRP", null, 6, 1.9),
  A("TRX.TRX", "TRX", "TRX", null, 6, 0.16),
  A("ATOM.ATOM", "ATOM", "ATOM", null, 6, 4.4),
  A("DOT.DOT", "DOT", "DOT", null, 10, 3.6),
  A("THOR.RUNE", "THOR", "RUNE", null, 8, 1.2)
];

export interface SimProvider {
  protocol: string;
  supportsDepositAddress: boolean;
  feeRate: number; // taken off the output
  flatFeeUsd: number;
  etaSeconds: number;
  sseDelayMs: [number, number]; // arrival window in the stream
}

// Three deposit-payable providers + one wallet-signed — mirrors the live
// partition so both execution lanes exercise end to end. REAL protocol names
// on purpose: the deposit gauntlet's protocol allowlist, the lane partition,
// and the relay→relay-deposit mapping must run exactly as in production
// (the TEST badge and ost_ receipts carry the "simulated" signal instead).
export const SIM_PROVIDERS: SimProvider[] = [
  { protocol: "relay", supportsDepositAddress: true, feeRate: 0.0032, flatFeeUsd: 0.21, etaSeconds: 8, sseDelayMs: [150, 400] },
  { protocol: "chainflip", supportsDepositAddress: true, feeRate: 0.0045, flatFeeUsd: 0.35, etaSeconds: 90, sseDelayMs: [300, 700] },
  { protocol: "near", supportsDepositAddress: true, feeRate: 0.005, flatFeeUsd: 0.28, etaSeconds: 45, sseDelayMs: [450, 900] },
  { protocol: "rango", supportsDepositAddress: false, feeRate: 0.0028, flatFeeUsd: 0.19, etaSeconds: 30, sseDelayMs: [200, 600] }
];

export function findFixtureAsset(identifier: string): FixtureAsset | undefined {
  return FIXTURE_ASSETS.find((a) => a.identifier.toLowerCase() === identifier.toLowerCase());
}
