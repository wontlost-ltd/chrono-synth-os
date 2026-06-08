import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { useTranslation } from 'react-i18next';

interface DeltaItem {
  pathId: string;
  compositeScoreDelta: number;
  regretProbabilityDelta: number;
}

interface DeltaChartProps {
  deltas: DeltaItem[];
  height?: number;
}

export const DeltaChart = React.memo(function DeltaChart({ deltas, height = 280 }: DeltaChartProps) {
  const { t } = useTranslation();
  const data = useMemo(() => deltas.map(d => ({
    name: d.pathId,
    score: +(d.compositeScoreDelta * 100).toFixed(1),
    regret: +(d.regretProbabilityDelta * 100).toFixed(1),
  })), [deltas]);

  return (
    <figure>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 16 }} role="img" aria-label={t('aria.stressDeltaChart')}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
          <XAxis dataKey="name" />
          <YAxis label={{ value: t('aria.changePercent'), angle: -90, position: 'insideLeft' }} />
          <Tooltip />
          <Bar dataKey="score" name={t('aria.scoreDelta')}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.score >= 0 ? 'var(--color-chart-positive)' : 'var(--color-chart-negative)'} />
            ))}
          </Bar>
          <Bar dataKey="regret" name={t('aria.regretDelta')}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.regret <= 0 ? 'var(--color-chart-positive)' : 'var(--color-chart-negative)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <table className="sr-only">
        <caption>{t('aria.stressDeltaData')}</caption>
        <thead><tr><th>{t('aria.pathColumn')}</th><th>{t('aria.scoreColumn')}</th><th>{t('aria.regretColumn')}</th></tr></thead>
        <tbody>
          {data.map(d => (
            <tr key={d.name}><td>{d.name}</td><td>{d.score}</td><td>{d.regret}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
});
