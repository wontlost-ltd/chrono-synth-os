import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { WsStatus } from '../../hooks/useWebSocket';

interface DataPoint {
  time: string;
  value: number;
}

interface LiveMetricStreamProps {
  subscribe: (eventType: string, handler: (payload: unknown) => void) => () => void;
  status: WsStatus;
  eventType?: string;
  maxPoints?: number;
}

export const LiveMetricStream = React.memo(function LiveMetricStream({
  subscribe,
  status,
  eventType = 'metric:stream',
  maxPoints = 50,
}: LiveMetricStreamProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<DataPoint[]>([]);
  const maxRef = useRef(maxPoints);
  maxRef.current = maxPoints;

  const handleEvent = useCallback((payload: unknown) => {
    const p = payload as { value?: number; timestamp?: string };
    if (typeof p?.value !== 'number') return;
    const point: DataPoint = {
      time: p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
      value: p.value,
    };
    setData(prev => {
      const next = [...prev, point];
      return next.length > maxRef.current ? next.slice(-maxRef.current) : next;
    });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe(eventType, handleEvent);
    return unsubscribe;
  }, [subscribe, eventType, handleEvent]);

  const chartData = useMemo(() => [...data], [data]);

  if (status !== 'connected') {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-text-secondary">
        {t('liveMetricStream.waitingForConnection')}
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-text-secondary">
        {t('liveMetricStream.waitingForData')}
      </div>
    );
  }

  return (
    <div role="img" aria-label={t('liveMetricStream.chartLabel')}>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" opacity={0.3} />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="var(--color-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <table className="sr-only">
        <caption>{t('liveMetricStream.dataTableCaption')}</caption>
        <thead><tr><th>{t('liveMetricStream.timeColumn')}</th><th>{t('liveMetricStream.valueColumn')}</th></tr></thead>
        <tbody>
          {chartData.map((d, i) => (
            <tr key={i}><td>{d.time}</td><td>{d.value}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
