import {
  type Pool,
  type PriceTick,
  type Opportunity,
  type IArbitrageDetector,
  AAVE_FLASH_LOAN_FEE_BPS,
  BPS_DENOMINATOR,
} from '@flash-trader/domain';
import { randomUUID } from 'node:crypto';

// Stablecoins where 1 token ≈ $1 — safe for flash loan amount calculation
const STABLECOIN_ADDRESSES = new Set([
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase(), // USDC
  '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'.toLowerCase(), // USDC.e
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'.toLowerCase(), // USDT
  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'.toLowerCase(), // DAI
]);

function isStablecoin(addr: string): boolean {
  return STABLECOIN_ADDRESSES.has(addr.toLowerCase());
}

function calcFlashAmount(usdAmount: number, decimals: number): bigint {
  // For stablecoins: $2500 = 2500 tokens
  return BigInt(Math.floor(usdAmount)) * 10n ** BigInt(decimals);
}

// ── Gas estimation ───────────────────────────────────────────────────

const GAS_PER_2HOP = 200_000n;
const GAS_PER_3HOP = 350_000n;
const DEFAULT_GAS_PRICE_GWEI = 0.1;
const DEFAULT_ETH_PRICE = 2000;

export interface DetectorConfig {
  minProfitBps: number;
  flashLoanSizeUsd: number;
  gasPriceGwei?: number;
  ethPriceUsd?: number;
  enable3Hop?: boolean;
}

function gasCostUsd(gasUnits: bigint, cfg: DetectorConfig): number {
  const gwei = cfg.gasPriceGwei ?? DEFAULT_GAS_PRICE_GWEI;
  const ethPrice = cfg.ethPriceUsd ?? DEFAULT_ETH_PRICE;
  return Number(gasUnits) * gwei * 1e-9 * ethPrice;
}

// ── Key helpers ──────────────────────────────────────────────────────

function pairKey(pool: Pool): string {
  const [a, b] = [pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].sort();
  return `${pool.chainId}:${a}:${b}`;
}

function addrKey(addr: string, chainId: number): string {
  return `${chainId}:${addr.toLowerCase()}`;
}

/**
 * PriceTick.price = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 - decimals1)
 * This gives us: how many token1 per 1 token0 (decimal-adjusted).
 *
 * So for WETH/USDC with price=2500 → 1 WETH = 2500 USDC.
 *
 * For a swap token0→token1 (zeroForOne), rate = price
 * For a swap token1→token0 (!zeroForOne), rate = 1/price
 */

// ── Detector ─────────────────────────────────────────────────────────

export class ArbitrageDetector implements IArbitrageDetector {
  findOpportunities(prices: PriceTick[], minProfitBps: number): Opportunity[] {
    return this.scan(prices, {
      minProfitBps,
      flashLoanSizeUsd: 2_500,
      enable3Hop: true,
    });
  }

  scan(prices: PriceTick[], cfg: DetectorConfig): Opportunity[] {
    // Filter out obviously broken prices
    const validPrices = prices.filter(
      (t) => t.price > 0 && isFinite(t.price) && t.liquidity > 0n,
    );

    const opportunities: Opportunity[] = [];

    // ── 2-hop: same pair, different pool ────────────────────────────
    const byPair = new Map<string, PriceTick[]>();
    for (const tick of validPrices) {
      const key = pairKey(tick.pool);
      const group = byPair.get(key) ?? [];
      group.push(tick);
      byPair.set(key, group);
    }

    for (const [, ticks] of byPair) {
      if (ticks.length < 2) continue;
      for (let i = 0; i < ticks.length; i++) {
        for (let j = i + 1; j < ticks.length; j++) {
          const opp = this.check2Hop(ticks[i], ticks[j], cfg);
          if (opp) opportunities.push(opp);
        }
      }
    }

    // ── 3-hop triangular ────────────────────────────────────────────
    if (cfg.enable3Hop) {
      const triOpps = this.scan3Hop(validPrices, cfg);
      opportunities.push(...triOpps);
    }

    return opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  }

  // ── 2-hop ──────────────────────────────────────────────────────────

  private check2Hop(
    a: PriceTick,
    b: PriceTick,
    cfg: DetectorConfig,
  ): Opportunity | null {
    const [buy, sell] = a.price < b.price ? [a, b] : [b, a];
    if (buy.price <= 0 || sell.price <= 0) return null;

    const spreadBps = ((sell.price - buy.price) / buy.price) * BPS_DENOMINATOR;
    const buyFeeBps = buy.pool.feeTier / 100;
    const sellFeeBps = sell.pool.feeTier / 100;
    const costBps = buyFeeBps + sellFeeBps + AAVE_FLASH_LOAN_FEE_BPS;

    const profitBps = spreadBps - costBps;
    if (profitBps < cfg.minProfitBps) return null;

    const grossUsd = (profitBps / BPS_DENOMINATOR) * cfg.flashLoanSizeUsd;
    const gas = gasCostUsd(GAS_PER_2HOP, cfg);
    const netUsd = grossUsd - gas;
    if (netUsd <= 0) return null;

    // Sanity: max 500bps profit on a 2-hop (anything higher is likely bad data)
    if (profitBps > 500) return null;

    // Only flash-loan stablecoins (safe USD→token conversion)
    if (!isStablecoin(buy.pool.token0.address)) return null;

    const flashAmount = calcFlashAmount(cfg.flashLoanSizeUsd, buy.pool.token0.decimals);

    return {
      id: randomUUID(),
      timestamp: Math.max(buy.timestamp, sell.timestamp),
      path: [buy.pool, sell.pool],
      inputToken: buy.pool.token0,
      estimatedProfitBps: profitBps,
      estimatedProfitUsd: grossUsd,
      flashLoanAmount: flashAmount,
      gasEstimate: GAS_PER_2HOP,
      netProfitUsd: netUsd,
      status: 'detected',
    };
  }

  // ── 3-hop triangular ──────────────────────────────────────────────
  //
  // For each triplet of tokens (A, B, C) reachable through pools:
  //   Start with 1 unit of A
  //   Swap A→B on pool1: get rate1 units of B (after fee)
  //   Swap B→C on pool2: get rate2 units of C (after fee)
  //   Swap C→A on pool3: get rate3 units of A (after fee)
  //   If result > 1 + flash_fee → profit
  //

  private scan3Hop(prices: PriceTick[], cfg: DetectorConfig): Opportunity[] {
    const opps: Opportunity[] = [];

    // Build adjacency: tokenAddr → [{ otherTokenAddr, tick, zeroForOne }]
    type Edge = {
      other: string;   // addrKey of the other token
      tick: PriceTick;
      zeroForOne: boolean; // true = swapping token0→token1
    };
    const adj = new Map<string, Edge[]>();

    for (const tick of prices) {
      const t0 = addrKey(tick.pool.token0.address, tick.pool.chainId);
      const t1 = addrKey(tick.pool.token1.address, tick.pool.chainId);

      if (!adj.has(t0)) adj.set(t0, []);
      if (!adj.has(t1)) adj.set(t1, []);

      adj.get(t0)!.push({ other: t1, tick, zeroForOne: true });
      adj.get(t1)!.push({ other: t0, tick, zeroForOne: false });
    }

    const seen = new Set<string>();

    for (const [tokenA, edgesA] of adj) {
      for (const e1 of edgesA) {
        const tokenB = e1.other;
        if (tokenB === tokenA) continue;

        const edgesB = adj.get(tokenB);
        if (!edgesB) continue;

        for (const e2 of edgesB) {
          const tokenC = e2.other;
          if (tokenC === tokenA || tokenC === tokenB) continue;

          const edgesC = adj.get(tokenC);
          if (!edgesC) continue;

          for (const e3 of edgesC) {
            if (e3.other !== tokenA) continue;

            // No same pool twice
            const p1 = e1.tick.pool.address;
            const p2 = e2.tick.pool.address;
            const p3 = e3.tick.pool.address;
            if (p1 === p2 || p2 === p3 || p1 === p3) continue;

            // Deduplicate: same 3 pools = same opportunity
            const dedup = [p1, p2, p3].map((a) => a.toLowerCase()).sort().join(':');
            if (seen.has(dedup)) continue;

            // Calculate rates
            const r1 = e1.zeroForOne ? e1.tick.price : 1 / e1.tick.price;
            const r2 = e2.zeroForOne ? e2.tick.price : 1 / e2.tick.price;
            const r3 = e3.zeroForOne ? e3.tick.price : 1 / e3.tick.price;

            // Sanity: rates should be reasonable
            if (!isFinite(r1) || !isFinite(r2) || !isFinite(r3)) continue;
            if (r1 <= 0 || r2 <= 0 || r3 <= 0) continue;

            // Apply fees at each hop
            const f1 = 1 - e1.tick.pool.feeTier / 1_000_000;
            const f2 = 1 - e2.tick.pool.feeTier / 1_000_000;
            const f3 = 1 - e3.tick.pool.feeTier / 1_000_000;
            const flashFee = 1 - AAVE_FLASH_LOAN_FEE_BPS / BPS_DENOMINATOR;

            const roundTrip = r1 * f1 * r2 * f2 * r3 * f3 * flashFee;

            if (roundTrip <= 1) continue;

            const profitBps = (roundTrip - 1) * BPS_DENOMINATOR;
            if (profitBps < cfg.minProfitBps) continue;

            // Sanity cap: >1000bps on a triangle is almost certainly bad data
            if (profitBps > 1000) continue;

            seen.add(dedup);

            const grossUsd = (profitBps / BPS_DENOMINATOR) * cfg.flashLoanSizeUsd;
            const gas = gasCostUsd(GAS_PER_3HOP, cfg);
            const netUsd = grossUsd - gas;
            if (netUsd <= 0) continue;

            // Only flash-loan stablecoins
            const inputToken3 = e1.zeroForOne ? e1.tick.pool.token0 : e1.tick.pool.token1;
            if (!isStablecoin(inputToken3.address)) continue;

            const flashAmount = calcFlashAmount(cfg.flashLoanSizeUsd, inputToken3.decimals);

            opps.push({
              id: randomUUID(),
              timestamp: Math.max(
                e1.tick.timestamp,
                e2.tick.timestamp,
                e3.tick.timestamp,
              ),
              path: [e1.tick.pool, e2.tick.pool, e3.tick.pool],
              inputToken: inputToken3,
              estimatedProfitBps: profitBps,
              estimatedProfitUsd: grossUsd,
              flashLoanAmount: flashAmount,
              gasEstimate: GAS_PER_3HOP,
              netProfitUsd: netUsd,
              status: 'detected',
            });
          }
        }
      }
    }

    return opps;
  }
}
