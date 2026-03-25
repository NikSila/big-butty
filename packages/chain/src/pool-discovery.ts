import {
  type Address,
  type Pool,
  type Token,
  type ChainId,
  DexId,
} from '@flash-trader/domain';
import { getClient } from './clients.js';
import {
  uniswapV3PoolAbi,
  erc20MetadataAbi,
} from './abis.js';
import { parseAbiItem, getAddress } from 'viem';

// ── Factory ABI for getPool ──────────────────────────────────────────

const factoryGetPoolAbi = [
  {
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    name: 'getPool',
    outputs: [{ name: 'pool', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Known factory addresses per chain ────────────────────────────────

interface DexFactory {
  dex: DexId;
  factory: Address;
}

const FACTORIES: Record<number, DexFactory[]> = {
  42161: [
    { dex: DexId.UniswapV3, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    { dex: DexId.SushiSwap, factory: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e' },
  ],
  10: [
    { dex: DexId.UniswapV3, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
  ],
  8453: [
    { dex: DexId.UniswapV3, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' },
  ],
};

const FEE_TIERS = [100, 500, 3000, 10000];

// ── Token metadata cache ─────────────────────────────────────────────

const tokenCache = new Map<string, Token | null>();

async function resolveToken(
  address: Address,
  chainId: ChainId,
): Promise<Token | null> {
  const key = `${chainId}:${address.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key)!;

  const client = getClient(chainId);
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20MetadataAbi, functionName: 'symbol' }),
      client.readContract({ address, abi: erc20MetadataAbi, functionName: 'decimals' }),
    ]);

    const token: Token = {
      address,
      chainId,
      symbol: symbol as string,
      decimals: Number(decimals),
    };
    tokenCache.set(key, token);
    return token;
  } catch {
    tokenCache.set(key, null);
    return null;
  }
}

// ── Discovery config ─────────────────────────────────────────────────

export interface DiscoveryConfig {
  chainId: ChainId;
  /** How many recent blocks to scan for new PoolCreated events */
  lookbackBlocks: number;
  /** Minimum liquidity to include a pool */
  minLiquidity: bigint;
  /** Max pools to return */
  maxPools: number;
  /** Base tokens — we enumerate ALL pair combos of these across all fee tiers */
  baseTokens?: Address[];
}

interface CandidatePool {
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  dex: DexId;
}

// ── Pool discovery ───────────────────────────────────────────────────

export class PoolDiscovery {
  /**
   * Two-pronged discovery:
   *
   * 1) EXHAUSTIVE: For all base tokens × base tokens × fee tiers, call
   *    factory.getPool() to find every pool that exists. This is O(n²×f)
   *    calls but uses multicall so it's ~20 RPC calls total for 7 base tokens.
   *
   * 2) RECENT: Scan recent PoolCreated events to catch new pools with
   *    non-base tokens that have significant liquidity.
   *
   * Then filter all candidates by on-chain liquidity.
   */
  async discover(config: DiscoveryConfig): Promise<Pool[]> {
    const candidates: CandidatePool[] = [];

    // ── Strategy 1: Enumerate base token pairs across factories ─────
    const basePools = await this.enumerateBaseTokenPools(config);
    candidates.push(...basePools);
    console.log(
      `[Discovery] Strategy 1 (base-token enumeration): ${basePools.length} pools found`,
    );

    // ── Strategy 2: Scan recent events for new pools ────────────────
    const recentPools = await this.scanRecentEvents(config);
    // Deduplicate
    const seen = new Set(candidates.map((c) => c.address.toLowerCase()));
    for (const rp of recentPools) {
      if (!seen.has(rp.address.toLowerCase())) {
        candidates.push(rp);
        seen.add(rp.address.toLowerCase());
      }
    }
    console.log(
      `[Discovery] Strategy 2 (recent events): ${recentPools.length} raw, ` +
      `${candidates.length} total after dedup`,
    );

    // ── Filter by liquidity ─────────────────────────────────────────
    return this.filterByLiquidity(candidates, config);
  }

  // ── Strategy 1: Base token enumeration ─────────────────────────────

  private async enumerateBaseTokenPools(
    config: DiscoveryConfig,
  ): Promise<CandidatePool[]> {
    const client = getClient(config.chainId);
    const baseTokens = config.baseTokens ?? [];
    const factories = FACTORIES[config.chainId] ?? [];
    const candidates: CandidatePool[] = [];

    // Generate all unique pairs
    const pairs: { a: Address; b: Address }[] = [];
    for (let i = 0; i < baseTokens.length; i++) {
      for (let j = i + 1; j < baseTokens.length; j++) {
        pairs.push({ a: getAddress(baseTokens[i]), b: getAddress(baseTokens[j]) });
      }
    }

    for (const fac of factories) {
      // Build multicall: every pair × every fee tier
      const calls = pairs.flatMap((pair) =>
        FEE_TIERS.map((fee) => ({
          address: fac.factory,
          abi: factoryGetPoolAbi,
          functionName: 'getPool' as const,
          args: [pair.a, pair.b, fee] as const,
        })),
      );

      console.log(
        `[Discovery] Querying ${fac.dex} factory for ${pairs.length} pairs × ${FEE_TIERS.length} fees = ${calls.length} pools...`,
      );

      // Multicall in batches
      const BATCH = 200;
      for (let i = 0; i < calls.length; i += BATCH) {
        const batch = calls.slice(i, i + BATCH);
        try {
          const results = await client.multicall({
            contracts: batch,
            allowFailure: true,
          });

          for (let j = 0; j < batch.length; j++) {
            const r = results[j];
            if (r.status !== 'success') continue;

            const poolAddr = r.result as Address;
            if (!poolAddr || poolAddr === '0x0000000000000000000000000000000000000000') continue;

            const callIdx = i + j;
            const pairIdx = Math.floor(callIdx / FEE_TIERS.length);
            const feeIdx = callIdx % FEE_TIERS.length;
            const pair = pairs[pairIdx];

            candidates.push({
              address: poolAddr,
              token0: pair.a,
              token1: pair.b,
              fee: FEE_TIERS[feeIdx],
              dex: fac.dex,
            });
          }
        } catch (err) {
          console.warn(`[Discovery] Multicall batch failed: ${err}`);
        }
      }
    }

    return candidates;
  }

  // ── Strategy 2: Recent event scanning ──────────────────────────────

  private async scanRecentEvents(
    config: DiscoveryConfig,
  ): Promise<CandidatePool[]> {
    const client = getClient(config.chainId);
    const factories = FACTORIES[config.chainId] ?? [];
    const currentBlock = await client.getBlockNumber();
    const fromBlock = currentBlock - BigInt(config.lookbackBlocks);
    const candidates: CandidatePool[] = [];

    const baseSet = new Set(
      (config.baseTokens ?? []).map((a) => a.toLowerCase()),
    );

    for (const fac of factories) {
      const effectiveFrom = fromBlock > 0n ? fromBlock : 1n;

      // Arbitrum public RPC handles ~50k block ranges for indexed events
      const CHUNK = 50_000n;
      let from = effectiveFrom;
      let eventCount = 0;

      console.log(
        `[Discovery] Scanning ${fac.dex} events: blocks ${effectiveFrom}→${currentBlock} ` +
        `(${currentBlock - effectiveFrom} blocks in ${Number((currentBlock - effectiveFrom) / CHUNK) + 1} chunks)`,
      );

      while (from <= currentBlock) {
        const to = from + CHUNK > currentBlock ? currentBlock : from + CHUNK;

        try {
          const logs = await client.getLogs({
            address: fac.factory,
            event: parseAbiItem(
              'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
            ),
            fromBlock: from,
            toBlock: to,
          });

          for (const log of logs) {
            const t0 = (log.args.token0 as string).toLowerCase();
            const t1 = (log.args.token1 as string).toLowerCase();

            // Keep if at least one token is a base token (or no filter)
            if (baseSet.size === 0 || baseSet.has(t0) || baseSet.has(t1)) {
              candidates.push({
                token0: log.args.token0 as Address,
                token1: log.args.token1 as Address,
                fee: Number(log.args.fee),
                dex: fac.dex,
                address: log.args.pool as Address,
              });
              eventCount++;
            }
          }
        } catch {
          // Public RPCs sometimes reject large ranges — skip and continue
        }

        from = to + 1n;
      }

      console.log(`[Discovery] ${fac.dex}: ${eventCount} pools from recent events`);
    }

    return candidates;
  }

  // ── Liquidity filter ───────────────────────────────────────────────

  private async filterByLiquidity(
    candidates: CandidatePool[],
    config: DiscoveryConfig,
  ): Promise<Pool[]> {
    const client = getClient(config.chainId);
    console.log(
      `[Discovery] Checking liquidity for ${candidates.length} candidate pools...`,
    );

    const withLiquidity: { pool: CandidatePool; liquidity: bigint }[] = [];

    const BATCH = 250;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const contracts = batch.map((c) => ({
        address: c.address,
        abi: uniswapV3PoolAbi,
        functionName: 'liquidity' as const,
      }));

      try {
        const results = await client.multicall({
          contracts,
          allowFailure: true,
        });

        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (r.status === 'success') {
            const liq = r.result as bigint;
            if (liq >= config.minLiquidity) {
              withLiquidity.push({ pool: batch[j], liquidity: liq });
            }
          }
        }
      } catch {
        // Fallback: individual reads
        for (const c of batch) {
          try {
            const liq = await client.readContract({
              address: c.address,
              abi: uniswapV3PoolAbi,
              functionName: 'liquidity',
            }) as bigint;
            if (liq >= config.minLiquidity) {
              withLiquidity.push({ pool: c, liquidity: liq });
            }
          } catch { /* dead pool */ }
        }
      }

      if (i > 0 && i % 500 === 0) {
        console.log(
          `[Discovery] Checked ${i}/${candidates.length} pools, ` +
          `${withLiquidity.length} pass liquidity filter so far`,
        );
      }
    }

    console.log(
      `[Discovery] ${withLiquidity.length}/${candidates.length} pools pass liquidity ` +
      `filter (min ${config.minLiquidity})`,
    );

    // Sort by liquidity, take top N
    withLiquidity.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
    const top = withLiquidity.slice(0, config.maxPools);

    // Resolve token metadata (parallel, batched)
    const pools: Pool[] = [];
    const TOKEN_BATCH = 10;
    for (let i = 0; i < top.length; i += TOKEN_BATCH) {
      const batch = top.slice(i, i + TOKEN_BATCH);
      const resolved = await Promise.all(
        batch.map(async ({ pool: c }) => {
          const [token0, token1] = await Promise.all([
            resolveToken(c.token0, config.chainId),
            resolveToken(c.token1, config.chainId),
          ]);
          if (!token0 || !token1) return null;
          return {
            address: c.address,
            chainId: config.chainId,
            dex: c.dex,
            token0,
            token1,
            feeTier: c.fee,
          } satisfies Pool;
        }),
      );
      pools.push(...resolved.filter((p): p is Pool => p !== null));
    }

    console.log(`[Discovery] Resolved ${pools.length} pools with full metadata`);
    return pools;
  }
}
