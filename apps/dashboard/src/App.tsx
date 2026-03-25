import { useState, useEffect } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWalletClient,
  useSwitchChain,
  useChainId,
} from 'wagmi';
import { createPublicClient, http, formatEther, formatUnits, encodeAbiParameters, parseAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { arbitrum } from 'wagmi/chains';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useOpportunities, useTrades, useHealth, recordTrade } from './hooks/useApi.js';

// ── Known tokens on Arbitrum ─────────────────────────────────────────

const USDT_ARB = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as const;
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
const USDC_E_ARB = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' as const;

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── FlashTrader contract ─────────────────────────────────────────────

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

// TODO: deploy FlashTrader.sol and put real address here
const FLASH_TRADER_ADDRESS = '0xC298A0A18938ABbA54Ae10138956975A9e6805Ba' as const;

// ── Hamster ──────────────────────────────────────────────────────────

const Hamster = ({ size = 32, mood = 'happy' }: { size?: number; mood?: 'happy' | 'rich' | 'thinking' | 'dead' | 'run' }) => {
  const faces: Record<string, string> = {
    happy: '\u{1F439}',
    rich: '\u{1F911}',
    thinking: '\u{1F914}',
    dead: '\u{1F635}',
    run: '\u{1F3C3}',
  };
  return <span style={{ fontSize: size }}>{faces[mood]}</span>;
};

// ── Main App ─────────────────────────────────────────────────────────

type Tab = 'opportunities' | 'history';

export function App() {
  const [tab, setTab] = useState<Tab>('opportunities');
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const health = useHealth();
  const { connected: wsConnected, scanStats } = useWebSocket();

  const onArbitrum = chainId === arbitrum.id;

  // ── Balances ─────────────────────────────────────────────────────

  // ETH (for gas) — direct viem call bypassing wagmi (works regardless of MetaMask chain)
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [ethLoading, setEthLoading] = useState(false);
  const [ethError, setEthError] = useState(false);

  useEffect(() => {
    if (!address) { setEthBalance(null); return; }
    setEthLoading(true);
    setEthError(false);

    const client = createPublicClient({
      chain: arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });

    let cancelled = false;
    const fetchBalance = async () => {
      try {
        const bal = await client.getBalance({ address });
        if (!cancelled) { setEthBalance(bal); setEthLoading(false); }
      } catch {
        if (!cancelled) { setEthError(true); setEthLoading(false); }
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address]);

  // USDT
  const { data: usdtRaw } = useReadContract({
    address: USDT_ARB,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arbitrum.id,
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  // USDC
  const { data: usdcRaw } = useReadContract({
    address: USDC_ARB,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arbitrum.id,
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  // USDC.e (bridged)
  const { data: usdceRaw } = useReadContract({
    address: USDC_E_ARB,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arbitrum.id,
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  const ethBal = ethBalance !== null ? Number(formatEther(ethBalance)) : 0;
  const ethBalUsd = ethBal * 2000;
  const usdtBal = usdtRaw ? Number(formatUnits(usdtRaw as bigint, 6)) : 0;
  const usdcBal = usdcRaw ? Number(formatUnits(usdcRaw as bigint, 6)) : 0;
  const usdceBal = usdceRaw ? Number(formatUnits(usdceRaw as bigint, 6)) : 0;
  const totalStables = usdtBal + usdcBal + usdceBal;

  // Arbitrum gas: ~300k gas * 0.01 gwei = 0.000003 ETH ≈ $0.0075
  const gasPerTxEth = 0.000003;
  const txsAvailable = ethBal > 0 ? Math.floor(ethBal / gasPerTxEth) : 0;

  const metaMaskConnector = connectors.find(
    (c) => c.name === 'MetaMask' || c.id === 'metaMask' || c.id === 'io.metamask',
  );

  return (
    <div style={containerStyle}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Hamster size={40} mood={isConnected ? 'rich' : 'happy'} />
          <div>
            <h1 style={{ margin: 0, fontSize: 26, color: '#fbbf24', fontWeight: 800 }}>
              Flash Hamster
            </h1>
            <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 2 }}>
              <span style={{ color: health.data?.status === 'ok' ? '#4ade80' : '#ef4444' }}>
                {health.data?.status === 'ok'
                  ? `Scanning ${health.data.pools} pools`
                  : 'Bot offline'}
              </span>
              {wsConnected && scanStats && (
                <span style={{ color: '#94a3b8' }}>
                  {scanStats.opportunitiesFound} opps / {scanStats.scanDurationMs}ms
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Wallet */}
        <div>
          {isConnected ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ textAlign: 'right' }}>
                {/* Chain warning */}
                {!onArbitrum && (
                  <div style={{ marginBottom: 4 }}>
                    <button
                      onClick={() => switchChain({ chainId: arbitrum.id })}
                      style={{ ...btnPrimary, padding: '4px 12px', fontSize: 12 }}
                    >
                      Switch to Arbitrum
                    </button>
                  </div>
                )}
                {/* Stablecoin balances */}
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginBottom: 2 }}>
                  {usdtBal > 0 && (
                    <span style={balBadge}>
                      <span style={{ color: '#4ade80' }}>${usdtBal.toFixed(2)}</span>
                      <span style={{ color: '#78716c' }}> USDT</span>
                    </span>
                  )}
                  {usdcBal > 0 && (
                    <span style={balBadge}>
                      <span style={{ color: '#60a5fa' }}>${usdcBal.toFixed(2)}</span>
                      <span style={{ color: '#78716c' }}> USDC</span>
                    </span>
                  )}
                  {usdceBal > 0 && (
                    <span style={balBadge}>
                      <span style={{ color: '#818cf8' }}>${usdceBal.toFixed(2)}</span>
                      <span style={{ color: '#78716c' }}> USDC.e</span>
                    </span>
                  )}
                  {totalStables === 0 && usdtRaw !== undefined && (
                    <span style={{ fontSize: 12, color: '#78716c' }}>No stables</span>
                  )}
                </div>
                {/* Gas balance */}
                <div style={{ fontSize: 11, color: '#78716c' }}>
                  <span style={{ color: ethBal > 0.0001 ? '#4ade80' : ethError ? '#ef4444' : '#a8a29e' }}>
                    Gas: {ethLoading
                      ? 'reading...'
                      : ethError
                        ? 'RPC error'
                        : ethBalance !== null
                          ? `${ethBal.toPrecision(4)} ETH (~$${ethBalUsd.toFixed(2)})`
                          : '0 ETH'}
                  </span>
                  {txsAvailable > 0 && (
                    <span style={{ color: '#57534e' }}> | ~{txsAvailable} txs</span>
                  )}
                  <span style={{ marginLeft: 8 }}>
                    {address?.slice(0, 6)}...{address?.slice(-4)}
                  </span>
                </div>
              </div>
              <button onClick={() => disconnect()} style={btnDanger}>X</button>
            </div>
          ) : (
            <button
              onClick={() => metaMaskConnector && connect({ connector: metaMaskConnector })}
              style={btnPrimary}
            >
              <Hamster size={18} mood="happy" /> Connect MetaMask
            </button>
          )}
        </div>
      </header>

      {/* ── Info banners ────────────────────────────────────────────── */}
      {isConnected && !onArbitrum && (
        <div style={{ ...bannerStyle, borderColor: '#f59e0b' }}>
          <Hamster size={32} mood="thinking" />
          <div style={{ fontSize: 13 }}>
            <b style={{ color: '#f59e0b' }}>Wrong network!</b>
            <span style={{ color: '#a8a29e' }}> Switch to Arbitrum in your MetaMask to see balances and execute trades.</span>
          </div>
        </div>
      )}

      {isConnected && onArbitrum && ethBal > 0 && ethBal < 0.00005 && (
        <div style={{ ...bannerStyle, borderColor: '#ef4444' }}>
          <Hamster size={32} mood="dead" />
          <div style={{ fontSize: 13 }}>
            <b style={{ color: '#ef4444' }}>Very low gas!</b>
            <span style={{ color: '#a8a29e' }}> You have ${ethBalUsd.toFixed(2)} in ETH. Still enough for ~{txsAvailable} trades on Arbitrum (gas ≈ $0.01/tx).</span>
          </div>
        </div>
      )}

      {!isConnected && (
        <div style={bannerStyle}>
          <Hamster size={48} mood="thinking" />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#fbbf24' }}>
              Connect MetaMask to start
            </div>
            <div style={{ fontSize: 13, color: '#a8a29e', marginTop: 4 }}>
              Flash loans are <b>self-funding</b> — you borrow the full amount, arb it, return the loan + 0.05% fee from profit.
              If the arb fails, the tx just reverts. <b>You only pay gas (~$0.04 on Arbitrum).</b>
              Keep your USDT, just need a bit of ETH for gas.
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <nav style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {(['opportunities', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              ...btnTab,
              background: tab === t ? '#b45309' : '#1c1917',
              borderColor: tab === t ? '#f59e0b' : '#44403c',
            }}
          >
            {t === 'opportunities' ? 'Opportunities' : 'Trade History'}
          </button>
        ))}
      </nav>

      {/* ── Content ─────────────────────────────────────────────────── */}
      {tab === 'opportunities' && (
        <OpportunitiesView isConnected={isConnected} hasGas={ethBal > 0.0001} />
      )}
      {tab === 'history' && <HistoryView />}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer style={{ textAlign: 'center', padding: '32px 0 16px', color: '#57534e', fontSize: 12 }}>
        Flash Hamster v0.1 | Aave V3 Flash Loans on Arbitrum | Not financial advice, degen responsibly
      </footer>
    </div>
  );
}

// ── Opportunities View ────────────────────────────────────────────────

function OpportunitiesView({
  isConnected,
  hasGas,
}: {
  isConnected: boolean;
  hasGas: boolean;
}) {
  // For flash loans: loan size doesn't depend on wallet balance
  // Pass null — the API uses a default based on pool liquidity constraints
  const opps = useOpportunities(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const { data: walletClient } = useWalletClient({ chainId: arbitrum.id });

  const executeFlashLoan = async (opp: any) => {
    console.log('Execute clicked:', { isConnected, hasGas, oppId: opp.id });
    if (!isConnected) { alert('Wallet not connected'); return; }
    if (!hasGas) { alert('Not enough ETH for gas'); return; }
    if (!walletClient) { alert('Wallet client not ready — is MetaMask on Arbitrum?'); return; }
    setExecutingId(opp.id);

    try {
      const path = opp.path;
      console.log('Building steps from path:', path);

      // Build swap steps for the contract
      const steps = path.map((pool: any, i: number) => {
        const isUniV3 = pool.dex === 'uniswap_v3';
        return {
          dexType: isUniV3 ? 1 : 2,
          router: isUniV3
            ? '0xE592427A0AEce92De3Edee1F18E0157C05861564'
            : '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
          tokenIn: pool.token0.address,
          tokenOut: pool.token1.address,
          fee: pool.feeTier,
          amountIn: 0n, // 0 = use full balance (contract handles this)
        };
      });
      console.log('Steps built:', steps);

      // ABI-encode the SwapStep[] array
      const params = encodeAbiParameters(
        parseAbiParameters('(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)[]'),
        [steps.map((s: any) => [s.dexType, s.router, s.tokenIn, s.tokenOut, s.fee, s.amountIn])],
      );
      console.log('Params encoded');

      const asset = opp.inputToken.address;
      const decimals = opp.inputToken.decimals ?? 6;
      const amount = BigInt(Math.floor(opp.maxLoanUsd * 10 ** decimals));
      console.log('Sending tx via walletClient:', { asset, amount: amount.toString(), contract: FLASH_TRADER_ADDRESS });

      const txHash = await walletClient.writeContract({
        address: FLASH_TRADER_ADDRESS,
        abi: FLASH_TRADER_ABI,
        functionName: 'requestFlashLoan',
        args: [asset, amount, params as Hex],
        chain: arbitrum,
      });
      console.log('TX hash:', txHash);

      await recordTrade(opp.id, txHash, 'submitted', opp.netProfitUsd);
    } catch (err: any) {
      console.error('Execution failed:', err);
      const msg = err.shortMessage ?? err.message ?? 'Unknown error';
      alert(`Execute failed: ${msg}`);
      await recordTrade(opp.id, '', 'reverted');
    } finally {
      setExecutingId(null);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: '#fbbf24', fontSize: 20 }}>
          <Hamster size={24} mood="rich" /> Flash Loan Opportunities
        </h2>
        <div style={chipStyle}>
          Loan fee: 0.05% (Aave) | Gas: ~$0.04
        </div>
      </div>

      {opps.isLoading && (
        <div style={{ padding: 32, textAlign: 'center', color: '#a8a29e' }}>
          <Hamster size={48} mood="thinking" />
          <div style={{ marginTop: 8 }}>Hamster is sniffing for arbitrage...</div>
        </div>
      )}

      {opps.data && opps.data.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: '#a8a29e' }}>
          <Hamster size={48} mood="dead" />
          <div style={{ marginTop: 8 }}>No profitable routes right now. Hamster is napping...</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(opps.data ?? []).map((opp: any, i: number) => (
          <div key={opp.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              {/* Left: route info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={rankBadge}>#{i + 1}</span>
                  <span style={hopBadge}>{opp.hops}-hop</span>
                  <span style={{ fontSize: 12, color: '#d6d3d1', wordBreak: 'break-all' }}>{opp.route}</span>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#a8a29e', flexWrap: 'wrap' }}>
                  <span>Spread: <b style={{ color: '#fbbf24' }}>{opp.profitBps.toFixed(1)} bps</b></span>
                  <span>Borrow: <b style={{ color: '#e2e8f0' }}>${opp.maxLoanUsd.toLocaleString('en', { maximumFractionDigits: 0 })}</b></span>
                  <span>Aave fee: <b style={{ color: '#ef4444' }}>${opp.feeCostUsd.toFixed(2)}</b></span>
                  <span>Gas: <b style={{ color: '#78716c' }}>~$0.04</b></span>
                </div>
              </div>

              {/* Right: profit + execute */}
              <div style={{ textAlign: 'right', minWidth: 140, marginLeft: 12 }}>
                <div style={{
                  fontSize: 22,
                  fontWeight: 800,
                  color: opp.netProfitUsd > 100 ? '#4ade80' : opp.netProfitUsd > 10 ? '#fbbf24' : '#a8a29e',
                }}>
                  +${opp.netProfitUsd.toFixed(2)}
                </div>
                <div style={{ fontSize: 10, color: '#78716c', marginBottom: 6 }}>
                  net profit (fee deducted)
                </div>
                <button
                  style={{
                    ...btnExecute,
                    opacity: !isConnected || !hasGas || executingId !== null ? 0.4 : 1,
                  }}
                  disabled={executingId !== null}
                  onClick={() => executeFlashLoan(opp)}
                  title={!hasGas ? 'Need ETH for gas' : !isConnected ? 'Connect wallet' : 'Execute flash loan'}
                >
                  {executingId === opp.id ? (
                    <><Hamster size={14} mood="run" /> Executing...</>
                  ) : (
                    <><Hamster size={14} mood="rich" /> Execute</>
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── History View ──────────────────────────────────────────────────────

function HistoryView() {
  const trades = useTrades();

  return (
    <div>
      <h2 style={{ margin: '0 0 16px', color: '#fbbf24', fontSize: 20 }}>
        <Hamster size={24} mood="rich" /> Trade History
      </h2>

      {(!trades.data || trades.data.length === 0) ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#a8a29e' }}>
          <Hamster size={48} mood="thinking" />
          <div style={{ marginTop: 8 }}>No trades yet. Go execute something!</div>
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>TX Hash</th>
              <th style={thStyle}>Est. Profit</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.data.map((t: any) => (
              <tr key={t.id}>
                <td style={tdStyle}>
                  {t.executed_at
                    ? new Date(t.executed_at * 1000).toLocaleString()
                    : '-'}
                </td>
                <td style={tdStyle}>
                  {t.tx_hash ? (
                    <a
                      href={`https://arbiscan.io/tx/${t.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#60a5fa' }}
                    >
                      {t.tx_hash.slice(0, 10)}...{t.tx_hash.slice(-6)}
                    </a>
                  ) : (
                    <span style={{ color: '#78716c' }}>-</span>
                  )}
                </td>
                <td style={{
                  ...tdStyle,
                  color: t.actual_profit_usd > 0 ? '#4ade80' : '#ef4444',
                  fontWeight: 700,
                }}>
                  {t.actual_profit_usd != null
                    ? `$${Number(t.actual_profit_usd).toFixed(2)}`
                    : '-'}
                </td>
                <td style={tdStyle}>
                  <span style={{
                    ...statusBadge,
                    background:
                      t.status === 'confirmed' ? '#166534'
                        : t.status === 'submitted' ? '#78350f'
                          : t.status === 'reverted' ? '#7f1d1d'
                            : '#292524',
                  }}>
                    {t.status === 'confirmed' ? 'Confirmed' :
                      t.status === 'submitted' ? 'Pending' :
                        t.status === 'reverted' ? 'Reverted' : t.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  maxWidth: 960,
  margin: '0 auto',
  padding: '16px 20px',
  background: '#0c0a09',
  minHeight: '100vh',
  color: '#e7e5e4',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 20,
  padding: '16px 20px',
  background: '#1c1917',
  borderRadius: 12,
  border: '1px solid #44403c',
};

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '14px 20px',
  background: '#1c1917',
  borderRadius: 12,
  border: '1px solid #44403c',
  marginBottom: 16,
};

const cardStyle: React.CSSProperties = {
  padding: '14px 18px',
  background: '#1c1917',
  borderRadius: 10,
  border: '1px solid #292524',
};

const btnPrimary: React.CSSProperties = {
  padding: '10px 20px',
  background: '#b45309',
  color: '#fef3c7',
  border: '1px solid #d97706',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const btnDanger: React.CSSProperties = {
  padding: '4px 10px',
  background: '#450a0a',
  color: '#fca5a5',
  border: '1px solid #7f1d1d',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 700,
};

const btnTab: React.CSSProperties = {
  padding: '8px 20px',
  color: '#fbbf24',
  border: '1px solid #44403c',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const btnExecute: React.CSSProperties = {
  padding: '6px 14px',
  background: '#166534',
  color: '#bbf7d0',
  border: '1px solid #22c55e',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const rankBadge: React.CSSProperties = {
  display: 'inline-block',
  background: '#78350f',
  color: '#fbbf24',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 800,
};

const hopBadge: React.CSSProperties = {
  display: 'inline-block',
  background: '#1e3a5f',
  color: '#7dd3fc',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
};

const chipStyle: React.CSSProperties = {
  background: '#292524',
  color: '#a8a29e',
  padding: '4px 12px',
  borderRadius: 6,
  fontSize: 11,
};

const balBadge: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
};

const statusBadge: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 10px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  color: '#e2e8f0',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  borderBottom: '2px solid #44403c',
  fontSize: 12,
  color: '#78716c',
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid #292524',
  fontSize: 13,
};
