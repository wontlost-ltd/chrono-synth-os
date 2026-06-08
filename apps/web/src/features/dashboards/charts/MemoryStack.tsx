import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface MemoryStackPoint {
  ts: number;
  episodic: number;
  semantic: number;
  procedural: number;
}

interface Props {
  data: ReadonlyArray<MemoryStackPoint>;
  height?: number;
  legendLabels?: { episodic: string; semantic: string; procedural: string };
}

const DEFAULT_LEGEND = { episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural' };

function formatTick(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function MemoryStack({ data, height = 240, legendLabels = DEFAULT_LEGEND }: Props) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  return (
    <div role="img" aria-label="Memory growth by kind, last 30 days" className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data as MemoryStackPoint[]} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
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
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="episodic"
            stackId="memory"
            name={legendLabels.episodic}
            fill="var(--color-chart-1)"
            isAnimationActive={animate}
          />
          <Bar
            dataKey="semantic"
            stackId="memory"
            name={legendLabels.semantic}
            fill="var(--color-chart-2)"
            isAnimationActive={animate}
          />
          <Bar
            dataKey="procedural"
            stackId="memory"
            name={legendLabels.procedural}
            fill="var(--color-chart-3)"
            isAnimationActive={animate}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
