import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Breadcrumbs } from '../components/ui/Breadcrumbs';
import { DeltaChart } from '../components/charts/DeltaChart';
import { MetricCard } from '../components/ui/MetricCard';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useStressComparison } from '../api/queries/visualization';
import { useCreateStressTest } from '../api/queries/simulations';
import { useSimulationId } from '../hooks/useSimulationId';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function StressTest() {
  const { t } = useTranslation();
  useDocumentTitle(t('stressTest.title'));
  const simId = useSimulationId();
  const isOnline = useOnlineStatus();
  const { data, isLoading, error } = useStressComparison(simId);
  const createStress = useCreateStressTest(simId);

  const [form, setForm] = useState({
    variantLabel: '',
    incomeFreezeYears: 2,
    marketDownturnFactor: 0.5,
    healthShock: 0.2,
  });
  const [formError, setFormError] = useState<string | null>(null);

  async function handleCreate() {
    if (!form.variantLabel.trim()) { setFormError(t('stressTest.variantNameRequired')); return; }
    if (!Number.isFinite(form.incomeFreezeYears) || form.incomeFreezeYears < 0) { setFormError(t('stressTest.invalidIncomeFreeze')); return; }
    if (!Number.isFinite(form.marketDownturnFactor) || form.marketDownturnFactor < 0 || form.marketDownturnFactor > 1) { setFormError(t('stressTest.invalidMarketDownturn')); return; }
    if (!Number.isFinite(form.healthShock) || form.healthShock < 0 || form.healthShock > 1) { setFormError(t('stressTest.invalidHealthShock')); return; }
    setFormError(null);
    try {
      await createStress.mutateAsync({
        variantLabel: form.variantLabel,
        overrides: {
          incomeFreezeYears: form.incomeFreezeYears,
          marketDownturnFactor: form.marketDownturnFactor,
          healthShock: form.healthShock,
        },
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('stressTest.createError'));
    }
  }

  return (
    <>
      <Breadcrumbs items={[
        { label: t('sidebar.dashboard'), to: '/dashboard' },
        { label: t('sidebar.simulations'), to: '/simulations' },
        { label: t('stressTest.title') },
      ]} />
      <PageHeader title={t('stressTest.title')} subtitle={t('stressTest.subtitle')} />

      <form className="mb-6 rounded-xl border border-border bg-surface-elevated p-4" onSubmit={e => { e.preventDefault(); handleCreate(); }}>
        <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('stressTest.formTitle')}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-xs text-text-secondary">{t('stressTest.variantNameLabel')}</span>
            <input
              className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
              value={form.variantLabel}
              onChange={e => { setForm(f => ({ ...f, variantLabel: e.target.value })); setFormError(null); }}
              aria-describedby={formError ? 'stress-form-error' : undefined}
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-secondary">{t('stressTest.incomeFreezeLabel')}</span>
            <input
              type="number"
              className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
              value={form.incomeFreezeYears}
              onChange={e => { setForm(f => ({ ...f, incomeFreezeYears: +e.target.value })); setFormError(null); }}
              aria-describedby={formError ? 'stress-form-error' : undefined}
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-secondary">{t('stressTest.marketDownturnLabel')}</span>
            <input
              type="number"
              step="0.1" min="0" max="1"
              className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
              value={form.marketDownturnFactor}
              onChange={e => { setForm(f => ({ ...f, marketDownturnFactor: +e.target.value })); setFormError(null); }}
              aria-describedby={formError ? 'stress-form-error' : undefined}
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-secondary">{t('stressTest.healthShockLabel')}</span>
            <input
              type="number"
              step="0.1" min="0" max="1"
              className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
              value={form.healthShock}
              onChange={e => { setForm(f => ({ ...f, healthShock: +e.target.value })); setFormError(null); }}
              aria-describedby={formError ? 'stress-form-error' : undefined}
            />
          </label>
        </div>
        {formError && (
          <div id="stress-form-error" className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-2 text-sm text-warning" role="alert">
            {formError}
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={createStress.isPending || !isOnline}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            aria-describedby={!isOnline ? 'stress-offline-hint' : undefined}
          >
            {createStress.isPending ? t('stressTest.running') : t('stressTest.run')}
          </button>
          {!isOnline && <span id="stress-offline-hint" className="text-xs text-warning">{t('common.offline')}</span>}
        </div>
      </form>

      {error ? (
        <EmptyState variant="error" message={t('stressTest.loadError', { message: error.message })} />
      ) : isLoading ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
          <Skeleton variant="chart" className="mt-4" />
        </>
      ) : data && data.variants.length > 0 ? (
        <>
          {data.variants.map(variant => (
            <div key={variant.simulationId} className="mb-6">
              <h3 className="mb-3 text-sm font-medium">
                {t('stressTest.variantLabel', { id: variant.simulationId.slice(0, 16) })}
                <span className={`ml-2 rounded px-2 py-0.5 text-xs ${
                  variant.status === 'completed' ? 'bg-success/10 text-success' : 'bg-accent/10 text-accent'
                }`}>
                  {variant.status}
                </span>
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {variant.deltas.map(d => (
                  <MetricCard
                    key={d.pathId}
                    title={t('stressTest.deltaScoreLabel', { pathId: d.pathId })}
                    value={d.compositeScoreDelta}
                    trend={d.compositeScoreDelta >= 0 ? 'up' : 'down'}
                  />
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-border bg-surface-elevated p-4">
                <DeltaChart deltas={variant.deltas} />
              </div>
            </div>
          ))}
        </>
      ) : (
        <EmptyState message={t('stressTest.noVariants')} />
      )}
    </>
  );
}
