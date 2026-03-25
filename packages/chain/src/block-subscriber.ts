import { type ChainId } from '@flash-trader/domain';
import { getClient } from './clients.js';

export class BlockSubscriber {
  private unsubscribers = new Map<ChainId, () => void>();

  onNewBlock(
    chainId: ChainId,
    callback: (blockNumber: bigint) => void,
  ): () => void {
    const client = getClient(chainId);

    const unwatch = client.watchBlockNumber({
      onBlockNumber: callback,
      emitOnBegin: true,
    });

    this.unsubscribers.set(chainId, unwatch);
    return unwatch;
  }

  stopAll() {
    for (const unsub of this.unsubscribers.values()) {
      unsub();
    }
    this.unsubscribers.clear();
  }
}
