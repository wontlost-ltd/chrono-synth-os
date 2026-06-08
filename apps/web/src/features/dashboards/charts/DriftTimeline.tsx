import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export type DriftAlertLevel = 'ok' | 'warning' | 'critical';

export interface DriftTimelinePoint {
  reportId: string;
  analyzedAt: number;
  overallDriftScore: number;
  alertLevel: DriftAlertLevel;
}

interface Props {
  data: ReadonlyArray<DriftTimelinePoint>;
  height?: number;
}

const ALERT_COLOR: Record<DriftAlertLevel, string> = {
  ok: 'var(--color-success)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-warning)',
};

const ALERT_SIZE: Record<DriftAlertLevel, number> = {
  ok: 60,
  warning: 120,
  critical: 240,
};

function formatTick(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function DriftTimeline({ data, height = 220 }: Props) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  /* Recharts ScatterChart needs `z` for variable bubble size, encoded
   * in the data points. */
  const points = data.map((d) => ({
    x: d.analyzedAt,
    y: d.overallDriftScore,
    z: ALERT_SIZE[d.alertLevel],
    fill: ALERT_COLOR[d.alertLevel],
    alertLevel: d.alertLevel,
  }));

  return (
    <div role="img" aria-label="Persona drift timeline, last 90 days" className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTick}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            stroke="var(--color-chart-grid)"
            name="Date"
          />
          <YAxis
            dataKey="y"
            type="number"
            domain={[0, 'dataMax']}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            stroke="var(--color-chart-grid)"
            width={40}
            name="Drift score"
          />
          <ZAxis dataKey="z" range={[40, 240]} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            contentStyle={{
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={() => ''}
            formatter={(value, key) => {
              const v = value as number | string;
              const k = String(key);
              if (k === 'x') return [new Date(Number(v)).toLocaleDateString(), 'Date'];
              if (k === 'y') return [(Number(v)).toFixed(3), 'Drift'];
              return [String(v), k];
            }}
          />
          <Scatter data={points} isAnimationActive={animate}>
            {points.map((p, i) => (
              <Scatter key={i} data={[p]} fill={p.fill} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
