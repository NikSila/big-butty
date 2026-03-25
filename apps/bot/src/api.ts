import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { FlashTraderDb } from '@flash-trader/db';
import type { Monitor, MonitorEvent } from './monitor.js';
import type { AppConfig } from './config.js';
import { AAVE_FLASH_LOAN_FEE_BPS, BPS_DENOMINATOR } from '@flash-trader/domain';

export async function createApi(
  config: AppConfig,
  db: FlashTraderDb,
  monitor: Monitor,
) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // ── REST endpoints ───────────────────────────────────────────────

  app.get('/api/health', async () => ({
    status: 'ok',
    pools: monitor.activePoolCount,
    lastScan: monitor.lastStats,
  }));

  app.get('/api/stats', async () => monitor.lastStats);

  /**
   * GET /api/opportunities?limit=100&loanSizeUsd=X
   *
   * Flash loans are self-funding: borrow → arb → repay loan+fee from profit.
   * User only pays gas. Loan size defaults to $2.5k (conservative for pool liquidity).
   * Net profit = (spread_bps/10000 * loanSize) - (0.05% aave fee * loanSize)
   */
  app.get('/api/opportunities', async (req) => {
    const query = req.query as { limit?: string; loanSizeUsd?: string };
    const limit = Number(query.limit ?? 100);
    const loanSizeUsd = Number(query.loanSizeUsd ?? config.flashLoanSizeUsd);

    const raw = db.getRecentOpportunities(limit * 5);

    // Deduplicate by route (same pool set) — keep latest
    const seen = new Set<string>();
    const deduped = [];
    for (const opp of raw) {
      let pathPools: string;
      try {
        const path = JSON.parse(opp.pathJson);
        pathPools = path
          .map((p: any) => p.address.toLowerCase())
          .sort()
          .join(':');
      } catch {
        pathPools = opp.id;
      }
      if (seen.has(pathPools)) continue;
      seen.add(pathPools);
      deduped.push(opp);
    }

    const aaveFeeFraction = AAVE_FLASH_LOAN_FEE_BPS / BPS_DENOMINATOR;

    const enriched = deduped.map((opp) => {
      const profitBps = opp.estimatedProfitBps;
      const maxLoanUsd = loanSizeUsd;
      const feeCostUsd = maxLoanUsd * aaveFeeFraction;
      const grossProfitUsd = (profitBps / BPS_DENOMINATOR) * maxLoanUsd;
      const netProfitUsd = grossProfitUsd - feeCostUsd;

      let path;
      let inputToken;
      try {
        path = JSON.parse(opp.pathJson);
        inputToken = JSON.parse(opp.inputToken);
      } catch {
        path = [];
        inputToken = { symbol: '?' };
      }

      return {
        id: opp.id,
        timestamp: opp.timestamp,
        status: opp.status,
        path,
        inputToken,
        profitBps,
        maxLoanUsd,
        feeCostUsd,
        grossProfitUsd,
        netProfitUsd,
        hops: path.length,
        route: path
          .map((p: any) => `${p.token0?.symbol}/${p.token1?.symbol}@${p.dex}`)
          .join(' -> '),
      };
    });

    // Filter profitable only and sort by net profit
    return enriched
      .filter((o) => o.netProfitUsd > 0)
      .sort((a, b) => b.netProfitUsd - a.netProfitUsd)
      .slice(0, limit);
  });

  app.post<{ Params: { id: string } }>(
    '/api/opportunities/:id/execute',
    async (req) => {
      const { id } = req.params;
      const body = req.body as { txHash?: string; status?: string; actualProfitUsd?: number } | undefined;

      if (body?.txHash) {
        // Record the execution result
        db.updateOpportunityStatus(id, body.status ?? 'executed');
        const trade = {
          id: crypto.randomUUID(),
          opportunity: { id } as any,
          txHash: body.txHash,
          chainId: 42161 as any,
          executedAt: Math.floor(Date.now() / 1000),
          actualProfitUsd: body.actualProfitUsd ?? null,
          gasUsed: null,
          status: (body.status ?? 'confirmed') as any,
        };
        db.insertTrade(trade);
        return { status: 'recorded', tradeId: trade.id, txHash: body.txHash };
      }

      db.updateOpportunityStatus(id, 'executing');
      return { status: 'queued', id };
    },
  );

  app.get('/api/trades', async (req) => {
    const query = req.query as { from?: string; to?: string };
    const from = Number(query.from ?? 0);
    const to = Number(query.to ?? Math.floor(Date.now() / 1000));
    return db.getTradeHistory(from, to);
  });

  // ── WebSocket for real-time streaming ────────────────────────────

  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
      const unsub = monitor.onEvent((event: MonitorEvent) => {
        try {
          socket.send(
            JSON.stringify(event, (_key, value) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          );
        } catch { /* client disconnected */ }
      });

      socket.on('close', () => unsub());
    });
  });

  return app;
}
