import { ChainId, type Address, DexId } from '@flash-trader/domain';
import type { DiscoveryConfig } from '@flash-trader/chain';

export interface AppConfig {
  dbPath: string;
  port: number;
  chains: ChainId[];
  rpcUrls: Partial<Record<ChainId, string>>;

  // ── Discovery ────────────────────────────────────────────────────
  discovery: DiscoveryConfig;

  // ── Scanner ──────────────────────────────────────────────────────
  minProfitBps: number;
  flashLoanSizeUsd: number;
  pollIntervalMs: number;
  /** Re-discover pools every N poll cycles */
  rediscoveryInterval: number;
  autoExecute: boolean;
}

// Well-known base tokens on Arbitrum (used to filter pools)
export const ARB_BASE_TOKENS: Address[] = [
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
  '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC.e (bridged)
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
  '0x912CE59144191C1204E64559FE8253a0e49E6548', // ARB
  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
];

export function loadConfig(): AppConfig {
  return {
    dbPath: process.env.DB_PATH ?? './flash-trader.db',
    port: Number(process.env.PORT ?? 3001),
    chains: [ChainId.Arbitrum],
    rpcUrls: {
      [ChainId.Arbitrum]: process.env.ARBITRUM_RPC_URL,
    },

    discovery: {
      chainId: ChainId.Arbitrum,
      // Scan recent PoolCreated events (~3h on Arb at 250ms/block)
      // Strategy 1 already covers all base-token pairs — this is just for new pools
      lookbackBlocks: Number(process.env.LOOKBACK_BLOCKS ?? 50_000),
      // Only pools with meaningful liquidity
      minLiquidity: BigInt(process.env.MIN_LIQUIDITY ?? '1000000000000'),
      // Top N pools by liquidity
      maxPools: Number(process.env.MAX_POOLS ?? 150),
      // Only scan pools that include a major token
      baseTokens: ARB_BASE_TOKENS,
    },

    minProfitBps: Number(process.env.MIN_PROFIT_BPS ?? 5),
    flashLoanSizeUsd: Number(process.env.FLASH_LOAN_SIZE_USD ?? 2_500),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 3000),
    rediscoveryInterval: Number(process.env.REDISCOVERY_INTERVAL ?? 200),
    autoExecute: process.env.AUTO_EXECUTE === 'true',
  };
}
