import { createPublicClient, http, type PublicClient, type Chain } from 'viem';
import { arbitrum, optimism, base } from 'viem/chains';
import { ChainId, type ChainConfig, type Address } from '@flash-trader/domain';

const viemChains: Record<ChainId, Chain> = {
  [ChainId.Arbitrum]: arbitrum,
  [ChainId.Optimism]: optimism,
  [ChainId.Base]: base,
};

const clients = new Map<ChainId, PublicClient>();

export function getClient(chainId: ChainId, rpcUrl?: string): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const chain = viemChains[chainId];
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
    batch: { multicall: true },
  });

  clients.set(chainId, client as PublicClient);
  return client as PublicClient;
}

export function clearClients() {
  clients.clear();
}
