import { useQuery } from '@tanstack/react-query';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function useOpportunities(feeBudgetUsd: number | null, limit = 30) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (feeBudgetUsd !== null) params.set('feeBudgetUsd', String(feeBudgetUsd));

  return useQuery({
    queryKey: ['opportunities', feeBudgetUsd, limit],
    queryFn: () => fetchJson<any[]>(`/api/opportunities?${params}`),
    refetchInterval: 3000,
  });
}

export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: () => fetchJson<any[]>('/api/trades'),
    refetchInterval: 5000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => fetchJson<{ status: string; pools: number; lastScan: any }>('/api/health'),
    refetchInterval: 5000,
  });
}

export async function recordTrade(
  oppId: string,
  txHash: string,
  status: string,
  actualProfitUsd?: number,
) {
  await fetch(`/api/opportunities/${oppId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, status, actualProfitUsd }),
  });
}
