import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface ToolMixSlice {
  toolId: string;
  count: number;
}

interface Props {
  data: ReadonlyArray<ToolMixSlice>;
  height?: number;
}

/* Pull from the chart palette (6 base hues), cycling for slices beyond 6. */
const SLICE_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];

export function ToolMix({ data, height = 240 }: Props) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  return (
    <div role="img" aria-label="Tool invocation mix, last 7 days" className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
          <Pie
            data={data as ToolMixSlice[]}
            dataKey="count"
            nameKey="toolId"
            outerRadius="75%"
            isAnimationActive={animate}
            stroke="var(--color-surface-elevated)"
            strokeWidth={2}
          >
            {data.map((_slice, idx) => (
              <Cell key={idx} fill={SLICE_COLORS[idx % SLICE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
