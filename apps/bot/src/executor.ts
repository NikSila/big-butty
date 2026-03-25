import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import type { Opportunity } from '@flash-trader/domain';
import type { FlashTraderDb } from '@flash-trader/db';
import type { AppConfig } from './config.js';

const FLASH_TRADER_ADDRESS = '0xE9E1Ec004D1726692199f51b220E70317481fb53' as const;

const FLASH_TRADER_ABI = [
  {
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes' },
    ],
    name: 'requestFlashLoan',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const UNI_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
const SUSHI_ROUTER = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' as const;

/**
 * Manual gas limit to bypass eth_estimateGas (which acts as simulation
 * and reverts before the TX ever reaches the chain). Flash loan arb TXs
 * on Arbitrum rarely need more than 1M gas; 2M gives comfortable headroom.
 */
const MANUAL_GAS_LIMIT = 2_000_000n;

export class Executor {
  private wallet;
  private publicClient;
  private pendingCount = 0;
  private maxPending = 3; // max concurrent TXs
  private nonceLock: Promise<void> = Promise.resolve();
  private managedNonce: number | null = null;

  constructor(private config: AppConfig, private db: FlashTraderDb) {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY env var required for auto-execute');
    }

    const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    const account = privateKeyToAccount(key);

    const rpcUrl = config.rpcUrls[42161 as any] ?? 'https://arb1.arbitrum.io/rpc';

    this.wallet = createWalletClient({
      account,
      chain: arbitrum,
      transport: http(rpcUrl),
    });

    this.publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    });

    console.log(`[Executor] Wallet: ${account.address}`);
  }

  /**
   * Acquire the next nonce in a serialized manner so parallel execute()
   * calls don't race on the same nonce.
   */
  private acquireNonce(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.nonceLock = this.nonceLock.then(async () => {
        try {
          if (this.managedNonce === null) {
            // First call — fetch from chain
            const onChain = await this.publicClient.getTransactionCount({
              address: this.wallet.account!.address,
              blockTag: 'pending',
            });
            this.managedNonce = onChain;
          }
          const nonce = this.managedNonce;
          this.managedNonce++;
          resolve(nonce);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * If a TX fails before being broadcast (e.g. sendRawTransaction RPC error),
   * roll back the nonce so the next attempt reuses it.
   */
  private rollbackNonce() {
    if (this.managedNonce !== null && this.managedNonce > 0) {
      this.managedNonce--;
    }
  }

  async execute(opp: Opportunity): Promise<string | null> {
    if (this.pendingCount >= this.maxPending) {
      console.log(`[Executor] ${this.pendingCount} TXs pending, skipping`);
      return null;
    }

    const route = opp.path
      .map((p) => `${p.token0.symbol}/${p.token1.symbol}@${p.dex}`)
      .join(' → ');

    try {
      const steps = opp.path.map((pool) => {
        const isUniV3 = pool.dex === 'uniswap_v3';
        return {
          dexType: isUniV3 ? 1 : 2,
          router: isUniV3 ? UNI_V3_ROUTER : SUSHI_ROUTER,
          tokenIn: pool.token0.address as Hex,
          tokenOut: pool.token1.address as Hex,
          fee: pool.feeTier ?? 3000,
          amountIn: 0n,
        };
      });

      const params = encodeAbiParameters(
        parseAbiParameters(
          '(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)[]',
        ),
        [steps.map((s) => [s.dexType, s.router, s.tokenIn, s.tokenOut, s.fee, s.amountIn])],
      );

      const asset = opp.inputToken.address as Hex;
      const amount = opp.flashLoanAmount;
      console.log(`[Executor] Checking: asset=${asset} amount=${amount}`);

      // Step 1: FREE simulation (eth_call, no gas cost)
      // Only send real TX if simulation passes
      try {
        await this.publicClient.simulateContract({
          address: FLASH_TRADER_ADDRESS,
          abi: FLASH_TRADER_ABI,
          functionName: 'requestFlashLoan',
          args: [asset, amount, params as Hex],
          account: this.wallet.account,
        });
      } catch (simErr: any) {
        const msg = simErr.shortMessage ?? simErr.message;
        if (msg.includes('flash loan failed')) {
          // Expected — arb not profitable on-chain, skip silently
        } else {
          console.log(`[Executor] Sim fail: ${msg}`);
        }
        return null;
      }

      // Step 2: Simulation PASSED — this is a REAL profitable opportunity!
      console.log(`[Executor] ✅ SIMULATION PASSED! ${route} | +${opp.estimatedProfitBps.toFixed(1)}bps | net $${opp.netProfitUsd.toFixed(2)}`);
      this.pendingCount++;

      const nonce = await this.acquireNonce();
      const data = encodeFunctionData({
        abi: FLASH_TRADER_ABI,
        functionName: 'requestFlashLoan',
        args: [asset, amount, params as Hex],
      });

      let txHash: Hex;
      try {
        txHash = await this.wallet.sendTransaction({
          to: FLASH_TRADER_ADDRESS,
          data,
          gas: MANUAL_GAS_LIMIT,
          nonce,
          chain: arbitrum,
        });
      } catch (sendErr: any) {
        this.rollbackNonce();
        throw sendErr;
      }

      console.log(`[Executor] TX sent: ${txHash}`);

      // Wait for receipt (don't block other TXs — this is already in its own async path)
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      const status = receipt.status === 'success' ? 'confirmed' : 'reverted';
      console.log(`[Executor] TX ${status}: ${txHash} (gas: ${receipt.gasUsed})`);

      // Record trade
      this.db.updateOpportunityStatus(opp.id, status);
      this.db.insertTrade({
        id: crypto.randomUUID(),
        opportunity: opp,
        txHash,
        chainId: 42161 as any,
        executedAt: Math.floor(Date.now() / 1000),
        actualProfitUsd: status === 'confirmed' ? opp.netProfitUsd : 0,
        gasUsed: receipt.gasUsed,
        status: status as any,
      });

      return txHash;
    } catch (err: any) {
      console.error(`[Executor] Failed:`, err.shortMessage ?? err.message);
      return null;
    } finally {
      this.pendingCount--;
    }
  }
}
