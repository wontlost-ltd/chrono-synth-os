import { useTranslation } from 'react-i18next';
import { formatMetricValue } from '../../utils/format';

interface MetricCardProps {
  title: string;
  value: number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  className?: string;
}

const TREND_ICONS: Record<string, string> = { up: '↑', down: '↓', flat: '→' };
const TREND_COLORS: Record<string, string> = {
  up: 'text-success',
  down: 'text-warning',
  flat: 'text-text-secondary',
};
const TREND_ARIA_KEYS: Record<string, string> = {
  up: 'aria.trendUp',
  down: 'aria.trendDown',
  flat: 'aria.trendFlat',
};

export function MetricCard({ title, value, unit = '', trend, className = '' }: MetricCardProps) {
  const { t } = useTranslation();
  const formattedValue = formatMetricValue(value, unit);
  return (
    <div
      role="group"
      aria-label={`${title}: ${formattedValue}`}
      className={`rounded-xl border border-border bg-surface-elevated p-4 ${className}`}
    >
      <p className="text-xs font-medium text-text-secondary">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold">{formattedValue}</span>
        {trend && (
          <span className={`text-sm font-medium ${TREND_COLORS[trend]}`} aria-label={t(TREND_ARIA_KEYS[trend]!)}>
            <span aria-hidden="true">{TREND_ICONS[trend]}</span>
            <span className="sr-only">{t(TREND_ARIA_KEYS[trend]!)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
