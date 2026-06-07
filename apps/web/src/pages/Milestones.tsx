import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Breadcrumbs } from '../components/ui/Breadcrumbs';
import { MilestoneTimeline } from '../components/charts/MilestoneTimeline';
import { MetricSelector } from '../components/ui/MetricSelector';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useMilestones } from '../api/queries/visualization';
import { useSimulationId } from '../hooks/useSimulationId';
import type { MetricKey } from '../types';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function Milestones() {
  const { t } = useTranslation();
  useDocumentTitle(t('milestones.title'));
  const simId = useSimulationId();
  const [metrics, setMetrics] = useState<MetricKey[]>(['wealth', 'healthIndex']);
  const metricsParam = metrics.join(',');
  const { data, isLoading, error } = useMilestones(simId, metricsParam);

  return (
    <>
      <Breadcrumbs items={[
        { label: t('sidebar.dashboard'), to: '/dashboard' },
        { label: t('sidebar.simulations'), to: '/simulations' },
        { label: t('milestones.title') },
      ]} />
      <PageHeader title={t('milestones.title')} subtitle={t('milestones.subtitle')} />

      <div className="mb-4">
        <MetricSelector selected={metrics} onChange={setMetrics} metricMeta={data?.metricMeta} />
      </div>

      {error ? (
        <EmptyState variant="error" message={t('milestones.loadError', { message: error.message })} />
      ) : isLoading ? (
        <Skeleton variant="chart" />
      ) : data && data.milestones.length > 0 ? (
        <div className="space-y-6">
          {data.milestones.map(m => (
            <div key={m.pathId} className="rounded-xl border border-border bg-surface-elevated p-4">
              <h3 className="mb-3 font-medium">{m.label}</h3>
              {m.events.length > 0 ? (
                <MilestoneTimeline events={m.events} />
              ) : (
                <p className="text-sm text-text-secondary">{t('milestones.noEvents')}</p>
              )}

              <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-3">
                <div>
                  <span className="text-xs text-text-secondary">{t('milestones.startLabel')}</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(m.summary.startSnapshot).map(([k, v]) => (
                      <span key={k} className="rounded bg-surface px-2 py-0.5 text-xs">
                        {k}: {typeof v === 'number' ? v.toFixed(2) : v}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="text-xs text-text-secondary">{t('milestones.endLabel')}</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(m.summary.endSnapshot).map(([k, v]) => (
                      <span key={k} className="rounded bg-surface px-2 py-0.5 text-xs">
                        {k}: {typeof v === 'number' ? v.toFixed(2) : v}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState message={t('milestones.noData')} />
      )}
    </>
  );
}
