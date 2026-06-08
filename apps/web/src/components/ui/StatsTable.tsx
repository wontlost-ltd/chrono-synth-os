import type { SeriesStats, MetricKey, MetricMeta } from '../../types';
import { formatMetricValue } from '../../utils/format';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface StatsTableProps {
  rows: Array<{ label: string; stats: SeriesStats }>;
  metrics: MetricKey[];
  metricMeta?: MetricMeta[];
}

export function StatsTable({ rows, metrics, metricMeta }: StatsTableProps) {
  const { t } = useTranslation();
  function metaFor(key: MetricKey) {
    return metricMeta?.find(m => m.key === key);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('statsTable.caption')}</caption>
        <thead>
          <tr className="border-b border-border text-text-secondary">
            <th scope="col" className="px-3 py-2">{t('statsTable.pathHeader')}</th>
            {metrics.map(m => {
              const meta = metaFor(m);
              return (
                <th key={m} scope="col" className="px-3 py-2" colSpan={4}>
                  {meta?.label ?? m}
                </th>
              );
            })}
          </tr>
          <tr className="border-b border-border text-xs text-text-secondary">
            <th scope="col" className="px-3 py-1" />
            {metrics.map(m => (
              <Fragment key={m}>
                <th scope="col" className="px-2 py-1">{t('statsTable.min')}</th>
                <th scope="col" className="px-2 py-1">{t('statsTable.max')}</th>
                <th scope="col" className="px-2 py-1">{t('statsTable.avg')}</th>
                <th scope="col" className="px-2 py-1">{t('statsTable.last')}</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className="border-b border-border/50">
              <th scope="row" className="px-3 py-2 font-medium">{row.label}</th>
              {metrics.map(m => {
                const meta = metaFor(m);
                const unit = meta?.unit ?? '';
                return (
                  <Fragment key={m}>
                    <td className="px-2 py-2">{row.stats.min[m] != null ? formatMetricValue(row.stats.min[m]!, unit) : '-'}</td>
                    <td className="px-2 py-2">{row.stats.max[m] != null ? formatMetricValue(row.stats.max[m]!, unit) : '-'}</td>
                    <td className="px-2 py-2">{row.stats.avg[m] != null ? formatMetricValue(row.stats.avg[m]!, unit) : '-'}</td>
                    <td className="px-2 py-2">{row.stats.last[m] != null ? formatMetricValue(row.stats.last[m]!, unit) : '-'}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fragment({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
