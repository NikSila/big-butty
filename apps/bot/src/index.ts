import { loadConfig } from './config.js';
import { createDb } from '@flash-trader/db';
import { getClient } from '@flash-trader/chain';
import { Monitor } from './monitor.js';
import { createApi } from './api.js';
import { Executor } from './executor.js';

async function main() {
  const config = loadConfig();

  console.log('Flash Trader Bot starting...');
  console.log(`Chains: ${config.chains.join(', ')}`);
  console.log(`Min profit: ${config.minProfitBps} bps | Flash loan: $${config.flashLoanSizeUsd}`);
  console.log(`Max pools: ${config.discovery.maxPools} | Lookback: ${config.discovery.lookbackBlocks} blocks`);

  // Initialize chain clients with RPC URLs
  for (const chainId of config.chains) {
    const rpcUrl = config.rpcUrls[chainId];
    if (rpcUrl) {
      getClient(chainId, rpcUrl);
      console.log(`Chain ${chainId}: custom RPC configured`);
    } else {
      getClient(chainId);
      console.log(`Chain ${chainId}: using default public RPC`);
    }
  }

  // Initialize database
  const db = createDb(config.dbPath);
  console.log(`Database: ${config.dbPath}`);

  // Start API server FIRST so dashboard can connect immediately
  const monitor = new Monitor(config, db);
  const api = await createApi(config, db, monitor);
  await api.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`API server: http://localhost:${config.port}`);
  console.log(`WebSocket: ws://localhost:${config.port}/ws`);

  // Set up auto-execution if enabled
  if (config.autoExecute) {
    try {
      const executor = new Executor(config, db);
      monitor.setExecutor(executor);
      console.log('Auto-execute: ENABLED');
    } catch (err: any) {
      console.error(`Auto-execute disabled: ${err.message}`);
    }
  } else {
    console.log('Auto-execute: disabled (set AUTO_EXECUTE=true to enable)');
  }

  // Then start discovery + scanning (non-blocking for API)
  monitor.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    monitor.stop();
    await api.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
