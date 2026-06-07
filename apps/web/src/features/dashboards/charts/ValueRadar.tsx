/**
 * ValueRadar — radar chart of a persona's core value graph.
 *
 * Compares three series on the same axes:
 *   current  → today's snapshot (dark fill)
 *   d7       → 7 days ago         (medium fill)
 *   d30      → 30 days ago        (light fill)
 *
 * Visualizes drift at a glance: if a polygon shrinks toward an axis,
 * that value's weight is fading; if it grows past prior, the value is
 * strengthening. Pairs with the drift-report numerical view in the
 * SafetyDriftReport page.
 *
 * Reduced-motion: recharts' default 1500ms entry animation is honored
 * when the user has motion enabled; we set isAnimationActive=false
 * when the prefers-reduced-motion hook returns true.
 */

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from 'recharts';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

export interface ValueRadarPoint {
  /** Value label (already localized at the call site) */
  label: string;
  current: number;
  d7?: number;
  d30?: number;
}

interface ValueRadarProps {
  data: ReadonlyArray<ValueRadarPoint>;
  /** Chart height in px; default 320 */
  height?: number;
  /** Optional translations for legend labels; falls back to English */
  legendLabels?: { current: string; d7: string; d30: string };
}

const DEFAULT_LEGEND = { current: 'Today', d7: '7 days ago', d30: '30 days ago' };

export function ValueRadar({ data, height = 320, legendLabels = DEFAULT_LEGEND }: ValueRadarProps) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  return (
    <div className="w-full" role="img" aria-label="Persona value radar chart">
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={data as ValueRadarPoint[]} margin={{ top: 16, right: 24, bottom: 16, left: 24 }}>
          <PolarGrid stroke="var(--color-chart-grid)" />
          <PolarAngleAxis
            dataKey="label"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
          />
          <PolarRadiusAxis
            angle={30}
            domain={[0, 1]}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
            stroke="var(--color-chart-grid)"
          />
          <Radar
            name={legendLabels.d30}
            dataKey="d30"
            stroke="var(--color-chart-3)"
            fill="var(--color-chart-3)"
            fillOpacity={0.15}
            isAnimationActive={animate}
          />
          <Radar
            name={legendLabels.d7}
            dataKey="d7"
            stroke="var(--color-chart-2)"
            fill="var(--color-chart-2)"
            fillOpacity={0.25}
            isAnimationActive={animate}
          />
          <Radar
            name={legendLabels.current}
            dataKey="current"
            stroke="var(--color-primary)"
            fill="var(--color-primary)"
            fillOpacity={0.35}
            isAnimationActive={animate}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
