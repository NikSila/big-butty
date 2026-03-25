import type { Pool, PriceTick, IPriceFetcher } from '@flash-trader/domain';
import { getClient } from './clients.js';
import { uniswapV3PoolAbi } from './abis.js';

/**
 * Converts sqrtPriceX96 to a human-readable price (token0 per token1).
 */
function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const num = Number(sqrtPriceX96) / 2 ** 96;
  const price = num * num;
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  return price * decimalAdjustment;
}

export class PriceFetcher implements IPriceFetcher {
  async getPoolPrice(pool: Pool): Promise<PriceTick> {
    const client = getClient(pool.chainId);

    const [slot0, liquidity, block] = await Promise.all([
      client.readContract({
        address: pool.address,
        abi: uniswapV3PoolAbi,
        functionName: 'slot0',
      }),
      client.readContract({
        address: pool.address,
        abi: uniswapV3PoolAbi,
        functionName: 'liquidity',
      }),
      client.getBlock({ blockTag: 'latest' }),
    ]);

    const sqrtPriceX96 = slot0[0];

    return {
      pool,
      sqrtPriceX96,
      price: sqrtPriceX96ToPrice(
        sqrtPriceX96,
        pool.token0.decimals,
        pool.token1.decimals,
      ),
      liquidity: liquidity as bigint,
      timestamp: Number(block.timestamp),
      blockNumber: Number(block.number),
    };
  }

  async getPoolPricesBatch(pools: Pool[]): Promise<PriceTick[]> {
    // Group pools by chain for batched multicall
    const byChain = new Map<number, Pool[]>();
    for (const pool of pools) {
      const group = byChain.get(pool.chainId) ?? [];
      group.push(pool);
      byChain.set(pool.chainId, group);
    }

    const results: PriceTick[] = [];

    await Promise.all(
      [...byChain.entries()].map(async ([chainId, chainPools]) => {
        const client = getClient(chainId as any);

        // Try multicall first, fall back to individual reads
        try {
          const block = await client.getBlock({ blockTag: 'latest' });

          const calls = chainPools.flatMap((pool) => [
            {
              address: pool.address,
              abi: uniswapV3PoolAbi,
              functionName: 'slot0' as const,
            },
            {
              address: pool.address,
              abi: uniswapV3PoolAbi,
              functionName: 'liquidity' as const,
            },
          ]);

          const multicallResults = await client.multicall({
            contracts: calls,
            allowFailure: true,
          });

          for (let i = 0; i < chainPools.length; i++) {
            const pool = chainPools[i];
            const slot0Result = multicallResults[i * 2];
            const liquidityResult = multicallResults[i * 2 + 1];

            if (slot0Result.status !== 'success' || liquidityResult.status !== 'success') {
              console.warn(
                `[PriceFetcher] Multicall failed for pool ${pool.address.slice(0, 10)} — skipping`,
              );
              continue;
            }

            const slot0 = slot0Result.result as readonly [bigint, number, number, number, number, number, boolean];
            const sqrtPriceX96 = slot0[0];

            results.push({
              pool,
              sqrtPriceX96,
              price: sqrtPriceX96ToPrice(
                sqrtPriceX96,
                pool.token0.decimals,
                pool.token1.decimals,
              ),
              liquidity: liquidityResult.result as bigint,
              timestamp: Number(block.timestamp),
              blockNumber: Number(block.number),
            });
          }
        } catch (err) {
          // Fallback: fetch individually if multicall fails entirely
          console.warn(`[PriceFetcher] Multicall failed, falling back to individual reads`);
          for (const pool of chainPools) {
            try {
              const tick = await this.getPoolPrice(pool);
              results.push(tick);
            } catch (e) {
              console.warn(`[PriceFetcher] Pool ${pool.address.slice(0, 10)} failed — skipping`);
            }
          }
        }
      }),
    );

    return results;
  }
}
