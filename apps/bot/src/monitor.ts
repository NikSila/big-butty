import { PriceFetcher, PoolDiscovery } from '@flash-trader/chain';
import { ArbitrageDetector } from '@flash-trader/engine';
import type { FlashTraderDb } from '@flash-trader/db';
import type { Pool, PriceTick, Opportunity } from '@flash-trader/domain';
import type { AppConfig } from './config.js';
import type { Executor } from './executor.js';

export type MonitorEvent =
  | { type: 'prices'; data: PriceTick[] }
  | { type: 'opportunity'; data: Opportunity }
  | { type: 'discovery'; data: { poolCount: number } }
  | { type: 'scan_stats'; data: ScanStats };

export interface ScanStats {
  poolCount: number;
  pricesRead: number;
  pairsScanned: number;
  opportunitiesFound: number;
  scanDurationMs: number;
  timestamp: number;
}

/** Dedup cooldown: don't re-execute the same route within this window (ms) */
const ROUTE_DEDUP_WINDOW_MS = 30_000;

export class Monitor {
  private fetcher = new PriceFetcher();
  private discovery = new PoolDiscovery();
  private detector = new ArbitrageDetector();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: ((event: MonitorEvent) => void)[] = [];
  private pools: Pool[] = [];
  private tickCount = 0;
  private _lastStats: ScanStats | null = null;

  private executor: Executor | null = null;

  /** Maps route key -> timestamp of last execution attempt */
  private recentRoutes = new Map<string, number>();

  constructor(
    private config: AppConfig,
    private db: FlashTraderDb,
  ) {}

  setExecutor(executor: Executor) {
    this.executor = executor;
  }

  /**
   * Build a stable key for a route so we can dedup repeated opportunities
   * for the same token path + DEX combination.
   */
  private routeKey(opp: Opportunity): string {
    return opp.path
      .map((p) => `${p.token0.address}:${p.token1.address}@${p.dex}`)
      .join('|');
  }

  /**
   * Returns true if this route was already attempted within the dedup window.
   */
  private isDuplicateRoute(opp: Opportunity): boolean {
    const key = this.routeKey(opp);
    const lastSeen = this.recentRoutes.get(key);
    const now = Date.now();

    if (lastSeen && now - lastSeen < ROUTE_DEDUP_WINDOW_MS) {
      return true;
    }

    // Mark this route as attempted
    this.recentRoutes.set(key, now);

    // Prune stale entries to avoid memory leak
    if (this.recentRoutes.size > 500) {
      for (const [k, ts] of this.recentRoutes) {
        if (now - ts > ROUTE_DEDUP_WINDOW_MS) {
          this.recentRoutes.delete(k);
        }
      }
    }

    return false;
  }

  get lastStats(): ScanStats | null {
    return this._lastStats;
  }

  get activePoolCount(): number {
    return this.pools.length;
  }

  onEvent(listener: (event: MonitorEvent) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: MonitorEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let listener errors kill the monitor */ }
    }
  }

  async start() {
    console.log('[Monitor] Starting pool discovery...');
    await this.discoverPools();

    if (this.pools.length === 0) {
      console.error('[Monitor] No pools discovered — cannot start scanning');
      return;
    }

    console.log(
      `[Monitor] Scanning ${this.pools.length} pools every ${this.config.pollIntervalMs}ms`,
    );

    // First tick immediately
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[Monitor] Stopped');
  }

  private async discoverPools() {
    try {
      const pools = await this.discovery.discover(this.config.discovery);
      this.pools = pools;

      // Register all discovered pools in DB
      for (const pool of pools) {
        this.db.upsertPool(pool);
      }

      this.emit({ type: 'discovery', data: { poolCount: pools.length } });

      // Log summary
      const byDex = new Map<string, number>();
      const tokens = new Set<string>();
      for (const p of pools) {
        byDex.set(p.dex, (byDex.get(p.dex) ?? 0) + 1);
        tokens.add(p.token0.symbol);
        tokens.add(p.token1.symbol);
      }
      console.log(
        `[Discovery] ${pools.length} pools across ${byDex.size} DEX(es): ` +
        [...byDex.entries()].map(([d, c]) => `${d}=${c}`).join(', '),
      );
      console.log(
        `[Discovery] ${tokens.size} unique tokens: ${[...tokens].slice(0, 20).join(', ')}${tokens.size > 20 ? '...' : ''}`,
      );
    } catch (err) {
      console.error('[Discovery] Failed:', err);
    }
  }

  private async tick() {
    this.tickCount++;

    // Periodic re-discovery
    if (
      this.tickCount % this.config.rediscoveryInterval === 0 &&
      this.tickCount > 0
    ) {
      console.log('[Monitor] Re-discovering pools...');
      await this.discoverPools();
    }

    const scanStart = Date.now();

    try {
      // Fetch prices for all pools via multicall
      const prices = await this.fetcher.getPoolPricesBatch(this.pools);

      // Persist price ticks
      this.db.insertPriceTicks(prices);
      this.emit({ type: 'prices', data: prices });

      // Scan for arbitrage across ALL pool combinations
      const opportunities = this.detector.scan(prices, {
        minProfitBps: this.config.minProfitBps,
        flashLoanSizeUsd: this.config.flashLoanSizeUsd,
        enable3Hop: true,
      });

      // Count unique pairs scanned
      const pairSet = new Set<string>();
      for (const p of prices) {
        const [a, b] = [p.pool.token0.address, p.pool.token1.address].sort();
        pairSet.add(`${a}:${b}`);
      }

      const stats: ScanStats = {
        poolCount: this.pools.length,
        pricesRead: prices.length,
        pairsScanned: pairSet.size,
        opportunitiesFound: opportunities.length,
        scanDurationMs: Date.now() - scanStart,
        timestamp: Math.floor(Date.now() / 1000),
      };
      this._lastStats = stats;
      this.emit({ type: 'scan_stats', data: stats });

      // Log scan summary (not every individual price — too noisy at 150+ pools)
      if (this.tickCount % 10 === 1 || opportunities.length > 0) {
        console.log(
          `[Scan #${this.tickCount}] ${prices.length} prices from ${this.pools.length} pools, ` +
          `${pairSet.size} pairs, ${opportunities.length} opps, ${stats.scanDurationMs}ms`,
        );
      }

      for (const opp of opportunities) {
        this.db.insertOpportunity(opp);
        this.emit({ type: 'opportunity', data: opp });

        const route = opp.path
          .map((p) => `${p.token0.symbol}/${p.token1.symbol}@${p.dex}`)
          .join(' → ');
        console.log(
          `[OPP] ${opp.path.length}-hop | ${route} | ` +
          `+${opp.estimatedProfitBps.toFixed(1)}bps | ` +
          `gross $${opp.estimatedProfitUsd.toFixed(2)} | ` +
          `net $${opp.netProfitUsd.toFixed(2)}`,
        );

        // Auto-execute if enabled, with dedup to avoid hammering the same route
        if (this.config.autoExecute && this.executor) {
          if (this.isDuplicateRoute(opp)) {
            console.log(`[AutoExec] Skipping duplicate route (seen within ${ROUTE_DEDUP_WINDOW_MS / 1000}s)`);
          } else {
            this.executor.execute(opp).catch((err) => {
              console.error('[AutoExec] Error:', err);
            });
          }
        }
      }
    } catch (err) {
      console.error(`[Scan #${this.tickCount}] Error:`, err);
    }
  }
}
