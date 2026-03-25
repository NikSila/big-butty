// ── Chain & DEX identifiers ──────────────────────────────────────────

export enum ChainId {
  Arbitrum = 42161,
  Optimism = 10,
  Base = 8453,
}

export enum DexId {
  UniswapV3 = 'uniswap_v3',
  SushiSwap = 'sushiswap',
}

// ── Core domain types ────────────────────────────────────────────────

export type Address = `0x${string}`;

export interface Token {
  address: Address;
  chainId: ChainId;
  symbol: string;
  decimals: number;
}

export interface Pool {
  address: Address;
  chainId: ChainId;
  dex: DexId;
  token0: Token;
  token1: Token;
  feeTier: number;
}

export interface PriceTick {
  pool: Pool;
  sqrtPriceX96: bigint;
  price: number;
  liquidity: bigint;
  timestamp: number;
  blockNumber: number;
}

// ── Opportunity & Trade ──────────────────────────────────────────────

export type OpportunityStatus =
  | 'detected'
  | 'simulated'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'expired';

export interface Opportunity {
  id: string;
  timestamp: number;
  path: Pool[];
  inputToken: Token;
  estimatedProfitBps: number;
  estimatedProfitUsd: number;
  flashLoanAmount: bigint;
  gasEstimate: bigint;
  netProfitUsd: number;
  status: OpportunityStatus;
}

export type TradeStatus = 'pending' | 'submitted' | 'confirmed' | 'reverted';

export interface Trade {
  id: string;
  opportunity: Opportunity;
  txHash: string | null;
  chainId: ChainId;
  executedAt: number | null;
  actualProfitUsd: number | null;
  gasUsed: bigint | null;
  status: TradeStatus;
}

// ── Backtest ─────────────────────────────────────────────────────────

export interface BacktestConfig {
  id: string;
  startBlock: number;
  endBlock: number;
  chainId: ChainId;
  pools: Pool[];
  minProfitBps: number;
  flashLoanToken: Token;
  flashLoanAmount: bigint;
}

export interface BacktestResult {
  config: BacktestConfig;
  opportunities: Opportunity[];
  totalProfitUsd: number;
  winRate: number;
  avgProfitPerTrade: number;
  maxDrawdown: number;
}

// ── Interfaces (contracts between modules) ───────────────────────────

export interface IPriceFetcher {
  getPoolPrice(pool: Pool): Promise<PriceTick>;
  getPoolPricesBatch(pools: Pool[]): Promise<PriceTick[]>;
}

export interface IQuoter {
  quoteExactInput(
    path: { pool: Pool; zeroForOne: boolean }[],
    amountIn: bigint,
  ): Promise<{ amountOut: bigint; gasEstimate: bigint }>;
}

export interface IArbitrageDetector {
  findOpportunities(
    prices: PriceTick[],
    minProfitBps: number,
  ): Opportunity[];
}

export interface IBacktester {
  run(
    config: BacktestConfig,
    historicalPrices: PriceTick[][],
  ): BacktestResult;
}

// ── Chain config ─────────────────────────────────────────────────────

export interface ChainConfig {
  chainId: ChainId;
  name: string;
  rpcUrl: string;
  blockTimeMs: number;
  aavePoolAddress: Address;
  dexRouters: Record<DexId, Address>;
}

export const CHAIN_CONFIGS: Record<ChainId, Omit<ChainConfig, 'rpcUrl'>> = {
  [ChainId.Arbitrum]: {
    chainId: ChainId.Arbitrum,
    name: 'Arbitrum One',
    blockTimeMs: 250,
    aavePoolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    dexRouters: {
      [DexId.UniswapV3]: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      [DexId.SushiSwap]: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    },
  },
  [ChainId.Optimism]: {
    chainId: ChainId.Optimism,
    name: 'Optimism',
    blockTimeMs: 2000,
    aavePoolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    dexRouters: {
      [DexId.UniswapV3]: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      [DexId.SushiSwap]: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    },
  },
  [ChainId.Base]: {
    chainId: ChainId.Base,
    name: 'Base',
    blockTimeMs: 2000,
    aavePoolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    dexRouters: {
      [DexId.UniswapV3]: '0x2626664c2603336E57B271c5C0b26F421741e481',
      [DexId.SushiSwap]: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
    },
  },
};

// ── Constants ────────────────────────────────────────────────────────

export const AAVE_FLASH_LOAN_FEE_BPS = 5; // 0.05%
export const BPS_DENOMINATOR = 10_000;
