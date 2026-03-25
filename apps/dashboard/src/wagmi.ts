import { createConfig, http, fallback } from 'wagmi';
import { arbitrum } from 'wagmi/chains';
import { metaMask } from 'wagmi/connectors';

export const wagmiConfig = createConfig({
  chains: [arbitrum],
  connectors: [metaMask()],
  transports: {
    [arbitrum.id]: fallback([
      http('https://arb1.arbitrum.io/rpc'),
      http('https://arbitrum.drpc.org'),
      http(), // wagmi default
    ]),
  },
});
