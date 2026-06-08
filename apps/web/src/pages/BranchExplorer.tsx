import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Breadcrumbs } from '../components/ui/Breadcrumbs';
import { SankeyGraph } from '../components/charts/SankeyGraph';
import { RadioGroup } from '../components/ui/RadioGroup';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useBranches } from '../api/queries/visualization';
import { useOverview } from '../api/queries/visualization';
import { useSimulationId } from '../hooks/useSimulationId';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function BranchExplorer() {
  const { t } = useTranslation();
  useDocumentTitle(t('branchExplorer.title'));
  const simId = useSimulationId();
  const { data: overview } = useOverview(simId);
  const pathIds = useMemo(() => overview?.paths.map(p => p.pathId) ?? [], [overview]);
  const [pathId, setPathId] = useState<string>('');

  const selectedPathId = pathId || pathIds[0] || '';
  const { data, isLoading, error } = useBranches(simId, selectedPathId);

  const pathOptions = pathIds.map(id => ({ value: id, label: id }));

  return (
    <>
      <Breadcrumbs items={[
        { label: t('sidebar.dashboard'), to: '/dashboard' },
        { label: t('sidebar.simulations'), to: '/simulations' },
        { label: t('branchExplorer.title') },
      ]} />
      <PageHeader title={t('branchExplorer.title')} subtitle={t('branchExplorer.subtitle')} />

      {pathIds.length > 1 && (
        <RadioGroup
          options={pathOptions}
          value={selectedPathId}
          onChange={setPathId}
          label={t('branchExplorer.pathSelectionLabel')}
          className="mb-4"
        />
      )}

      {error ? (
        <EmptyState variant="error" message={t('branchExplorer.loadError', { message: error.message })} />
      ) : isLoading ? (
        <Skeleton variant="chart" />
      ) : data ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface-elevated p-4 lg:col-span-2">
            <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('branchExplorer.branchGraphTitle')}</h3>
            {data.graph.nodes.length > 0 ? (
              <SankeyGraph
                nodes={data.graph.nodes.map(n => ({ id: n.id, label: n.label }))}
                edges={data.graph.edges}
              />
            ) : (
              <EmptyState message={t('branchExplorer.noBranchData')} />
            )}
          </div>
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-surface-elevated p-4">
              <h3 className="mb-2 text-sm font-medium text-text-secondary">{t('branchExplorer.pathInfoTitle')}</h3>
              <p className="text-lg font-bold">{data.label}</p>
              <p className="text-sm text-text-secondary">{t('branchExplorer.timespanLabel')} {data.horizonYears}</p>
              <p className="text-sm text-text-secondary">{t('branchExplorer.pivotPointLabel')} Y{data.pivotYear}</p>
            </div>
            {data.branches.map(br => (
              <div key={br.label} className="rounded-xl border border-border bg-surface-elevated p-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{br.label}</span>
                  <span className="text-sm text-text-secondary">{(br.probability * 100).toFixed(0)}%</span>
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('branchExplorer.compositeScoreLabel')} {br.compositeScore.toFixed(3)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState message={t('branchExplorer.selectPathPrompt')} />
      )}
    </>
  );
}
