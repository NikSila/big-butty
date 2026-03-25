import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const pools = sqliteTable('pools', {
  address: text('address').primaryKey(),
  chainId: integer('chain_id').notNull(),
  dex: text('dex').notNull(),
  token0Address: text('token0_address').notNull(),
  token0Symbol: text('token0_symbol').notNull(),
  token0Decimals: integer('token0_decimals').notNull(),
  token1Address: text('token1_address').notNull(),
  token1Symbol: text('token1_symbol').notNull(),
  token1Decimals: integer('token1_decimals').notNull(),
  feeTier: integer('fee_tier').notNull(),
});

export const priceTicks = sqliteTable('price_ticks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  poolAddress: text('pool_address')
    .notNull()
    .references(() => pools.address),
  blockNumber: integer('block_number').notNull(),
  timestamp: integer('timestamp').notNull(),
  sqrtPriceX96: text('sqrt_price_x96').notNull(),
  price: real('price').notNull(),
  liquidity: text('liquidity').notNull(),
});

export const opportunities = sqliteTable('opportunities', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp').notNull(),
  pathJson: text('path_json').notNull(),
  inputToken: text('input_token').notNull(),
  estimatedProfitBps: real('estimated_profit_bps').notNull(),
  estimatedProfitUsd: real('estimated_profit_usd').notNull(),
  flashLoanAmount: text('flash_loan_amount').notNull(),
  gasEstimate: text('gas_estimate').notNull(),
  netProfitUsd: real('net_profit_usd').notNull(),
  status: text('status').notNull().default('detected'),
});

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  opportunityId: text('opportunity_id')
    .notNull()
    .references(() => opportunities.id),
  txHash: text('tx_hash'),
  chainId: integer('chain_id').notNull(),
  executedAt: integer('executed_at'),
  actualProfitUsd: real('actual_profit_usd'),
  gasUsed: text('gas_used'),
  status: text('status').notNull().default('pending'),
});

export const backtestRuns = sqliteTable('backtest_runs', {
  id: text('id').primaryKey(),
  configJson: text('config_json').notNull(),
  resultJson: text('result_json'),
  createdAt: integer('created_at').notNull(),
});
