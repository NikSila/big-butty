# Flash Trader

Automated flash loan arbitrage bot for Arbitrum L2. Borrows from Aave V3, executes multi-hop swaps across DEXs, and repays in a single atomic transaction.

## Architecture

```
Flash Trader/
├── packages/
│   ├── domain/       # Core types — Token, Pool, Opportunity, Trade
│   ├── chain/        # Blockchain interaction — price fetching, pool discovery (viem)
│   ├── engine/       # Arbitrage detection — 2-hop & 3-hop triangular scanner
│   └── db/           # Persistence — SQLite + Drizzle ORM
├── apps/
│   ├── bot/          # Trading bot — monitor, executor, REST API + WebSocket
│   └── dashboard/    # React UI — live opportunities, trade history, wallet connect
└── contracts/        # Solidity — FlashTrader.sol (Aave V3 flash loans + DEX swaps)
```

## Tech Stack

| Layer | Stack |
|-------|-------|
| Smart Contracts | Solidity 0.8.24, Foundry |
| Backend | Node.js, Fastify 5, viem 2 |
| Frontend | React 19, Vite 6, Wagmi 2, TanStack Query 5 |
| Database | SQLite, Drizzle ORM |
| Monorepo | pnpm 9.15, Turborepo |

## How It Works

1. **Pool Discovery** — scans Uniswap V3 & SushiSwap factories for liquid pools on Arbitrum
2. **Price Monitoring** — fetches on-chain prices via multicall every N seconds
3. **Arbitrage Detection** — compares prices across DEXs, finds 2-hop and 3-hop profitable routes
4. **Simulation** — free `eth_call` to verify profitability on-chain before spending gas
5. **Execution** — sends `requestFlashLoan` to the FlashTrader contract:
   - Aave V3 lends the asset (e.g. $2,500 USDC)
   - Contract swaps through the route (Uniswap V3 / SushiSwap)
   - Repays loan + 0.05% fee
   - Profit sent to owner

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9.15+
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)

### Setup

```bash
pnpm install

cp .env.example .env
# Edit .env — set ARBITRUM_RPC_URL and PRIVATE_KEY
```

### Deploy Contract

```bash
cd contracts
forge build
forge script script/Deploy.s.sol \
  --rpc-url $ARBITRUM_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Update the deployed contract address in `apps/bot/src/executor.ts`.

### Run

```bash
# Bot (required) — scans, detects, executes
pnpm -F @flash-trader/bot dev

# Dashboard (optional) — visual monitoring
pnpm -F @flash-trader/dashboard dev
```

- Bot API: `http://localhost:3001`
- WebSocket: `ws://localhost:3001/ws`
- Dashboard: `http://localhost:5173`

## Configuration

All settings via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ARBITRUM_RPC_URL` | public RPC | Arbitrum RPC endpoint |
| `PRIVATE_KEY` | — | Wallet private key for TX signing |
| `FLASH_LOAN_SIZE_USD` | `2500` | Flash loan amount in USD |
| `MIN_PROFIT_BPS` | `5` | Minimum profit threshold (basis points) |
| `POLL_INTERVAL_MS` | `5000` | Price scan interval |
| `AUTO_EXECUTE` | `false` | Auto-send TXs when opportunity found |
| `DB_PATH` | `./flash-trader.db` | SQLite database path |
| `PORT` | `3001` | API server port |

## Smart Contract

**FlashTrader.sol** — deployed on Arbitrum

- `requestFlashLoan(asset, amount, params)` — initiates Aave V3 flash loan
- `executeOperation(...)` — Aave callback, executes swap route, repays
- Supports: **Uniswap V3** (exactInputSingle) and **SushiSwap** (swapExactTokensForTokens)
- Swap route encoded as `SwapStep[]` — arbitrary multi-hop paths

## Supported DEXs & Tokens

**DEXs:** Uniswap V3, SushiSwap

**Base tokens:** WETH, USDC, USDC.e, USDT, DAI, ARB, WBTC

**Flash loan assets:** USDC, USDT, DAI (stablecoins only)

## Project Scripts

```bash
pnpm dev        # Start all apps in dev mode
pnpm build      # Build all packages
pnpm lint       # Lint everything
pnpm clean      # Remove dist/ folders
```

## License

MIT
