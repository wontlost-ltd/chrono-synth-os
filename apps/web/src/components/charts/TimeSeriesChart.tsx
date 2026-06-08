import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { PathSeries, MetricKey, MetricMeta } from '../../types';

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];

interface TimeSeriesChartProps {
  series: PathSeries[];
  metric: MetricKey;
  metricMeta?: MetricMeta;
  height?: number;
}

export const TimeSeriesChart = React.memo(function TimeSeriesChart({ series, metric, metricMeta, height = 360 }: TimeSeriesChartProps) {
  const { t } = useTranslation();
  const data = useMemo(() => {
    if (series.length === 0) return [];
    const yearMap = new Map<number, Record<string, number | string>>();
    for (const s of series) {
      for (const point of s.points) {
        let entry = yearMap.get(point.year);
        if (!entry) { entry = { year: point.year }; yearMap.set(point.year, entry); }
        const v = point.values[metric];
        if (v != null) entry[s.pathId] = v;
      }
    }
    return [...yearMap.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  }, [series, metric]);

  const metricLabel = metricMeta?.label ?? metric;

  return (
    <figure>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 16 }} role="img" aria-label={t('aria.timeSeriesChart', { metric: metricLabel })}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
          <XAxis dataKey="year" label={{ value: t('chart.yearAxis'), position: 'insideBottomRight', offset: -4 }} />
          <YAxis label={{ value: metricLabel, angle: -90, position: 'insideLeft' }} />
          <Tooltip />
          <Legend />
          {series.map((s, i) => (
            <Line
              key={s.pathId}
              type="monotone"
              dataKey={s.pathId}
              name={s.label}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {data.length > 0 && (
        <table className="sr-only">
          <caption>{t('aria.timeSeriesData', { metric: metricLabel })}</caption>
          <thead><tr><th>{t('aria.yearLabel')}</th>{series.map(s => <th key={s.pathId}>{s.label}</th>)}</tr></thead>
          <tbody>
            {data.map(row => (
              <tr key={String(row['year'])}>
                <td>{row['year']}</td>
                {series.map(s => <td key={s.pathId}>{row[s.pathId] != null ? String(row[s.pathId]) : '-'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
});
