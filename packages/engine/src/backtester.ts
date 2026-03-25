import {
  type PriceTick,
  type BacktestConfig,
  type BacktestResult,
  type IBacktester,
} from '@flash-trader/domain';
import { ArbitrageDetector } from './arbitrage-detector.js';

/**
 * Replays historical price snapshots through the arbitrage detector.
 * Each element in historicalPrices is one "snapshot" — all pool prices at a given block.
 */
export class Backtester implements IBacktester {
  private detector = new ArbitrageDetector();

  run(
    config: BacktestConfig,
    historicalPrices: PriceTick[][],
  ): BacktestResult {
    const allOpportunities = [];

    for (const snapshot of historicalPrices) {
      const opps = this.detector.findOpportunities(
        snapshot,
        config.minProfitBps,
      );
      allOpportunities.push(...opps);
    }

    const profits = allOpportunities.map((o) => o.netProfitUsd);
    const totalProfitUsd = profits.reduce((sum, p) => sum + p, 0);
    const winCount = profits.filter((p) => p > 0).length;

    // Compute max drawdown from cumulative P&L
    let peak = 0;
    let maxDrawdown = 0;
    let cumulative = 0;
    for (const pnl of profits) {
      cumulative += pnl;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      config,
      opportunities: allOpportunities,
      totalProfitUsd,
      winRate: allOpportunities.length > 0 ? winCount / allOpportunities.length : 0,
      avgProfitPerTrade:
        allOpportunities.length > 0 ? totalProfitUsd / allOpportunities.length : 0,
      maxDrawdown,
    };
  }
}
