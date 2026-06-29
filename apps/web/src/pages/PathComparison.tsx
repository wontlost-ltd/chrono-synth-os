import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
/* 经 ui barrel 统一导入（P2-3：验证 components/ui/index.ts 收敛点）。 */
import { Breadcrumbs, MetricSelector, ResolutionToggle, RadioGroup, StatsTable, Skeleton, EmptyState } from '../components/ui';
import { usePaths } from '../api/queries/visualization';
import { useSimulationId } from '../hooks/useSimulationId';
import type { MetricKey, Resolution } from '../types';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const DEFAULT_METRICS: MetricKey[] = ['wealth', 'healthIndex', 'overallScore', 'emotionalState.valence'];

export function PathComparison() {
  const { t } = useTranslation();
  useDocumentTitle(t('pathComparison.title'));
  const simId = useSimulationId();
  const [metrics, setMetrics] = useState<MetricKey[]>(DEFAULT_METRICS);
  const [resolution, setResolution] = useState<Resolution>('year');
  const [activeMetric, setActiveMetric] = useState<MetricKey>('wealth');

  const metricsParam = metrics.join(',');
  const { data, isLoading, error } = usePaths(simId, metricsParam, resolution);

  const metricOptions = metrics.map(m => {
    const meta = data?.metricMeta?.find(mm => mm.key === m);
    return { value: m, label: meta?.label ?? m };
  });

  return (
    <>
      <Breadcrumbs items={[
        { label: t('sidebar.dashboard'), to: '/dashboard' },
        { label: t('sidebar.simulations'), to: '/simulations' },
        { label: t('pathComparison.title') },
      ]} />
      <PageHeader title={t('pathComparison.title')} subtitle={t('pathComparison.subtitle')} />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <MetricSelector
          selected={metrics}
          onChange={keys => { setMetrics(keys); if (!keys.includes(activeMetric) && keys.length > 0) setActiveMetric(keys[0]!); }}
          metricMeta={data?.metricMeta}
        />
        <ResolutionToggle value={resolution} onChange={setResolution} />
      </div>

      {metrics.length > 0 && (
        <RadioGroup
          options={metricOptions}
          value={activeMetric}
          onChange={setActiveMetric}
          label={t('pathComparison.activeMetricLabel')}
          className="mb-2"
        />
      )}

      {error ? (
        <EmptyState variant="error" message={t('pathComparison.loadError', { message: error.message })} />
      ) : isLoading ? (
        <Skeleton variant="chart" />
      ) : data ? (
        <>
          <div className="rounded-xl border border-border bg-surface-elevated p-4">
            <TimeSeriesChart
              series={data.series}
              metric={activeMetric}
              metricMeta={data.metricMeta?.find(m => m.key === activeMetric)}
            />
          </div>
          <div className="mt-6 rounded-xl border border-border bg-surface-elevated p-4">
            <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('pathComparison.statsSummary')}</h3>
            <StatsTable
              rows={data.series.map(s => ({ label: s.label, stats: s.stats }))}
              metrics={metrics}
              metricMeta={data.metricMeta}
            />
          </div>
        </>
      ) : (
        <EmptyState message={t('pathComparison.noData')} />
      )}
    </>
  );
}
