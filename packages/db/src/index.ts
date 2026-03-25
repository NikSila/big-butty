import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import type {
  Pool,
  PriceTick,
  Opportunity,
  Trade,
  ChainId,
  DexId,
  Address,
} from '@flash-trader/domain';

export { schema };

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      dex TEXT NOT NULL,
      token0_address TEXT NOT NULL,
      token0_symbol TEXT NOT NULL,
      token0_decimals INTEGER NOT NULL,
      token1_address TEXT NOT NULL,
      token1_symbol TEXT NOT NULL,
      token1_decimals INTEGER NOT NULL,
      fee_tier INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL REFERENCES pools(address),
      block_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      sqrt_price_x96 TEXT NOT NULL,
      price REAL NOT NULL,
      liquidity TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_ticks_pool_ts
      ON price_ticks(pool_address, timestamp);
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      path_json TEXT NOT NULL,
      input_token TEXT NOT NULL,
      estimated_profit_bps REAL NOT NULL,
      estimated_profit_usd REAL NOT NULL,
      flash_loan_amount TEXT NOT NULL,
      gas_estimate TEXT NOT NULL,
      net_profit_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'detected'
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
      tx_hash TEXT,
      chain_id INTEGER NOT NULL,
      executed_at INTEGER,
      actual_profit_usd REAL,
      gas_used TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  return {
    db,

    // ── Pool operations ──────────────────────────────────────────────
    upsertPool(pool: Pool) {
      db.insert(schema.pools)
        .values({
          address: pool.address,
          chainId: pool.chainId,
          dex: pool.dex,
          token0Address: pool.token0.address,
          token0Symbol: pool.token0.symbol,
          token0Decimals: pool.token0.decimals,
          token1Address: pool.token1.address,
          token1Symbol: pool.token1.symbol,
          token1Decimals: pool.token1.decimals,
          feeTier: pool.feeTier,
        })
        .onConflictDoNothing()
        .run();
    },

    // ── Price tick operations ────────────────────────────────────────
    insertPriceTicks(ticks: PriceTick[]) {
      for (const tick of ticks) {
        db.insert(schema.priceTicks)
          .values({
            poolAddress: tick.pool.address,
            blockNumber: tick.blockNumber,
            timestamp: tick.timestamp,
            sqrtPriceX96: tick.sqrtPriceX96.toString(),
            price: tick.price,
            liquidity: tick.liquidity.toString(),
          })
          .run();
      }
    },

    getHistoricalPrices(
      poolAddress: string,
      from: number,
      to: number,
    ) {
      return db
        .select()
        .from(schema.priceTicks)
        .where(
          and(
            eq(schema.priceTicks.poolAddress, poolAddress),
            gte(schema.priceTicks.timestamp, from),
            lte(schema.priceTicks.timestamp, to),
          ),
        )
        .orderBy(schema.priceTicks.timestamp)
        .all();
    },

    // ── Opportunity operations ───────────────────────────────────────
    insertOpportunity(opp: Opportunity) {
      db.insert(schema.opportunities)
        .values({
          id: opp.id,
          timestamp: opp.timestamp,
          pathJson: JSON.stringify(opp.path),
          inputToken: JSON.stringify(opp.inputToken),
          estimatedProfitBps: opp.estimatedProfitBps,
          estimatedProfitUsd: opp.estimatedProfitUsd,
          flashLoanAmount: opp.flashLoanAmount.toString(),
          gasEstimate: opp.gasEstimate.toString(),
          netProfitUsd: opp.netProfitUsd,
          status: opp.status,
        })
        .run();
    },

    updateOpportunityStatus(id: string, status: string) {
      db.update(schema.opportunities)
        .set({ status })
        .where(eq(schema.opportunities.id, id))
        .run();
    },

    getRecentOpportunities(limit: number) {
      return db
        .select()
        .from(schema.opportunities)
        .orderBy(desc(schema.opportunities.timestamp))
        .limit(limit)
        .all();
    },

    // ── Trade operations ─────────────────────────────────────────────
    insertTrade(trade: Trade) {
      db.insert(schema.trades)
        .values({
          id: trade.id,
          opportunityId: trade.opportunity.id,
          txHash: trade.txHash,
          chainId: trade.chainId,
          executedAt: trade.executedAt,
          actualProfitUsd: trade.actualProfitUsd,
          gasUsed: trade.gasUsed?.toString() ?? null,
          status: trade.status,
        })
        .run();
    },

    getTradeHistory(from: number, to: number) {
      return db
        .select()
        .from(schema.trades)
        .where(
          and(
            gte(schema.trades.executedAt, from),
            lte(schema.trades.executedAt, to),
          ),
        )
        .orderBy(desc(schema.trades.executedAt))
        .all();
    },

    // ── Backtest operations ──────────────────────────────────────────
    insertBacktestRun(id: string, configJson: string) {
      db.insert(schema.backtestRuns)
        .values({
          id,
          configJson,
          createdAt: Math.floor(Date.now() / 1000),
        })
        .run();
    },

    updateBacktestResult(id: string, resultJson: string) {
      db.update(schema.backtestRuns)
        .set({ resultJson })
        .where(eq(schema.backtestRuns.id, id))
        .run();
    },

    getBacktestRun(id: string) {
      return db
        .select()
        .from(schema.backtestRuns)
        .where(eq(schema.backtestRuns.id, id))
        .limit(1)
        .all()[0] ?? null;
    },
  };
}

export type FlashTraderDb = ReturnType<typeof createDb>;
