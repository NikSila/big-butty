import { useEffect, useRef, useState, useCallback } from 'react';

type WsEvent =
  | { type: 'opportunity'; data: any }
  | { type: 'scan_stats'; data: any }
  | { type: 'prices'; data: any }
  | { type: 'discovery'; data: any };

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [scanStats, setScanStats] = useState<any>(null);
  const [liveOppCount, setLiveOppCount] = useState(0);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 3000);
    };

    ws.onmessage = (event) => {
      try {
        const data: WsEvent = JSON.parse(event.data);
        if (data.type === 'scan_stats') {
          setScanStats(data.data);
          setLiveOppCount(data.data.opportunitiesFound);
        }
      } catch { /* ignore parse errors */ }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  return { connected, scanStats, liveOppCount };
}
