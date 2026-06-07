import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface DecisionTrendPoint {
  ts: number;
  count: number;
}

interface Props {
  data: ReadonlyArray<DecisionTrendPoint>;
  height?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatTick(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function DecisionTrend({ data, height = 240 }: Props) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  /* Pre-compute a 30d-anchored x-axis domain so the line stays anchored
   * even when there are no data points for the trailing days. */
  const now = data.length > 0 ? data[data.length - 1]!.ts : Date.now();
  const domainStart = now - 30 * DAY_MS;

  return (
    <div role="img" aria-label="Decision trend over the last 30 days" className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data as DecisionTrendPoint[]} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[domainStart, now]}
            tickFormatter={formatTick}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            stroke="var(--color-chart-grid)"
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            stroke="var(--color-chart-grid)"
            width={40}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(label) => new Date(Number(label)).toLocaleDateString()}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={{ r: 3, fill: 'var(--color-primary)' }}
            isAnimationActive={animate}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
