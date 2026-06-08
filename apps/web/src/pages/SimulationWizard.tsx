import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Breadcrumbs } from '../components/ui/Breadcrumbs';
import { useCreateSimulation } from '../api/queries/simulations';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import type { CreateSimulationRequest } from '../types';
import type { TFunction } from 'i18next';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface PathDraft {
  id: string;
  label: string;
  description: string;
  income: number;
  savings: number;
  branches: Array<{ label: string; probability: number; conditions: Record<string, number> }>;
}

const EMPTY_PATH: PathDraft = {
  id: '', label: '', description: '', income: 300000, savings: 500000, branches: [],
};

function validateStep0(t: TFunction, paths: PathDraft[]): string | null {
  for (let i = 0; i < paths.length; i++) {
    if (!paths[i]!.id.trim()) return t('wizard.pathIdRequired', { index: i + 1 });
    if (!paths[i]!.label.trim()) return t('wizard.pathNameRequired', { index: i + 1 });
  }
  const ids = paths.map(p => p.id.trim());
  if (new Set(ids).size !== ids.length) return t('wizard.duplicatePathIds');
  return null;
}

function validateStep1(t: TFunction, paths: PathDraft[]): string | null {
  for (const p of paths) {
    if (p.branches.length === 0) continue;
    for (const br of p.branches) {
      if (!br.label.trim()) return t('wizard.branchNameRequired', { label: p.label });
      if (Number.isNaN(br.probability)) return t('wizard.invalidProbability', { label: br.label });
      if (br.probability < 0 || br.probability > 1) return t('wizard.probabilityOutOfRange', { label: br.label });
    }
    const sum = p.branches.reduce((s, br) => s + br.probability, 0);
    if (Math.abs(sum - 1) > 0.01 && p.branches.length > 0) {
      return t('wizard.probabilitySumInvalid', { label: p.label, sum: sum.toFixed(2) });
    }
  }
  return null;
}

function validateStep2(t: TFunction, age: number, horizonYears: number, paths: PathDraft[]): string | null {
  if (Number.isNaN(age) || age < 1 || age > 120) return t('wizard.ageOutOfRange');
  if (Number.isNaN(horizonYears) || horizonYears < 1 || horizonYears > 80) return t('wizard.horizonOutOfRange');
  for (const p of paths) {
    if (!Number.isFinite(p.income) || p.income < 0) return t('wizard.invalidIncome', { label: p.label });
    if (!Number.isFinite(p.savings) || p.savings < 0) return t('wizard.invalidSavings', { label: p.label });
  }
  return null;
}

export function SimulationWizard() {
  const { t } = useTranslation();
  useDocumentTitle(t('wizard.title'));
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();
  const createSim = useCreateSimulation();

  const [step, setStep] = useState(0);
  const [paths, setPaths] = useState<PathDraft[]>([{ ...EMPTY_PATH }]);
  const [age, setAge] = useState(35);
  const [horizonYears, setHorizonYears] = useState(10);
  const [validationError, setValidationError] = useState<string | null>(null);
  const stepContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stepContentRef.current?.focus();
  }, [step]);

  function updatePath(index: number, patch: Partial<PathDraft>) {
    setPaths(prev => prev.map((p, i) => i === index ? { ...p, ...patch } : p));
    setValidationError(null);
  }

  function addBranch(pathIndex: number) {
    setPaths(prev => prev.map((p, i) =>
      i === pathIndex
        ? { ...p, branches: [...p.branches, { label: '', probability: 0.5, conditions: {} }] }
        : p
    ));
  }

  function tryNext() {
    let err: string | null = null;
    if (step === 0) err = validateStep0(t, paths);
    else if (step === 1) err = validateStep1(t, paths);
    else if (step === 2) err = validateStep2(t, age, horizonYears, paths);
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    setStep(s => s + 1);
  }

  async function handleSubmit() {
    const body: CreateSimulationRequest = {
      paths: paths.map(p => ({
        id: p.id,
        label: p.label,
        description: p.description,
        initialConditions: { income: p.income, savings: p.savings },
        branches: p.branches,
      })),
      horizonYears,
      age,
    };

    try {
      const result = await createSim.mutateAsync(body);
      try { localStorage.setItem('last-sim-id', result.simulationId); } catch { /* ignored */ }
      navigate(`/simulations/${encodeURIComponent(result.simulationId)}/paths`);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : t('wizard.createError'));
    }
  }

  const STEPS = [t('wizard.stepDefinePaths'), t('wizard.stepBranches'), t('wizard.stepParameters'), t('wizard.stepPreview')];

  return (
    <>
      <Breadcrumbs items={[
        { label: t('sidebar.dashboard'), to: '/dashboard' },
        { label: t('sidebar.simulations'), to: '/simulations' },
        { label: t('wizard.title') },
      ]} />
      <PageHeader title={t('wizard.title')} subtitle={t('wizard.stepSubtitle', { step: step + 1, total: STEPS.length, name: STEPS[step] })} />

      <div className="mb-6 flex gap-1" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label={t('wizard.title')}>
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-border'}`}
          />
        ))}
      </div>

      {validationError && (
        <div id="wizard-error" className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning" role="alert">
          {validationError}
        </div>
      )}

      <div ref={stepContentRef} tabIndex={-1} className="outline-none" aria-live="polite">
      {step === 0 && (
        <div className="space-y-4">
          {paths.map((p, i) => (
            <div key={i} className="rounded-xl border border-border bg-surface-elevated p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium">{t('wizard.pathLabel', { index: i + 1 })}</h3>
                {paths.length > 1 && (
                  <button type="button" onClick={() => setPaths(prev => prev.filter((_, j) => j !== i))} className="text-xs text-warning" aria-label={`${t('wizard.delete')} ${t('wizard.pathLabel', { index: i + 1 })}`}>{t('wizard.delete')}</button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs text-text-secondary">{t('wizard.idLabel')}</span>
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={p.id} onChange={e => updatePath(i, { id: e.target.value })} placeholder={t('wizard.idPlaceholder')} required aria-describedby={validationError ? 'wizard-error' : undefined} />
                </label>
                <label className="block">
                  <span className="text-xs text-text-secondary">{t('wizard.nameLabel')}</span>
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={p.label} onChange={e => updatePath(i, { label: e.target.value })} placeholder={t('wizard.namePlaceholder')} required aria-describedby={validationError ? 'wizard-error' : undefined} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs text-text-secondary">{t('wizard.descriptionLabel')}</span>
                  <input className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={p.description} onChange={e => updatePath(i, { description: e.target.value })} placeholder={t('wizard.descriptionPlaceholder')} />
                </label>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => setPaths(prev => [...prev, { ...EMPTY_PATH }])} className="rounded-lg border border-dashed border-border px-4 py-2 text-sm text-text-secondary hover:border-primary">
            {t('wizard.addPath')}
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          {paths.map((p, pi) => (
            <div key={pi} className="rounded-xl border border-border bg-surface-elevated p-4">
              <h3 className="mb-3 font-medium">{t('wizard.branchesForPath', { label: p.label || t('wizard.pathLabel', { index: pi + 1 }) })}</h3>
              {p.branches.map((br, bi) => (
                <div key={bi} className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="block">
                    <span className="sr-only">{t('wizard.branchNamePlaceholder')}</span>
                    <input
                      className="w-full rounded-lg border border-border px-3 py-1.5 text-sm"
                      value={br.label} placeholder={t('wizard.branchNamePlaceholder')}
                      aria-describedby={validationError ? 'wizard-error' : undefined}
                      onChange={e => {
                        const branches = [...p.branches];
                        branches[bi] = { ...br, label: e.target.value };
                        updatePath(pi, { branches });
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">{t('wizard.probabilityLabel')}</span>
                    <input
                      type="number" step="0.1" min="0" max="1"
                      className="w-full rounded-lg border border-border px-3 py-1.5 text-sm"
                      value={br.probability}
                      onChange={e => {
                        const branches = [...p.branches];
                        branches[bi] = { ...br, probability: +e.target.value };
                        updatePath(pi, { branches });
                      }}
                      aria-describedby={validationError ? 'wizard-error' : undefined}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => updatePath(pi, { branches: p.branches.filter((_, j) => j !== bi) })}
                    className="text-xs text-warning"
                    aria-label={t('wizard.deleteBranchAria', { label: br.label || String(bi + 1) })}
                  >
                    {t('wizard.delete')}
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => addBranch(pi)} className="text-sm text-primary">{t('wizard.addBranch')}</button>
            </div>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="text-xs text-text-secondary">{t('wizard.ageLabel')}</span>
              <input type="number" min="1" max="120" className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={age} onChange={e => { setAge(+e.target.value); setValidationError(null); }} aria-describedby={validationError ? 'wizard-error' : undefined} />
            </label>
            <label className="block">
              <span className="text-xs text-text-secondary">{t('wizard.horizonYearsLabel')}</span>
              <input type="number" min="1" max="80" className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={horizonYears} onChange={e => { setHorizonYears(+e.target.value); setValidationError(null); }} aria-describedby={validationError ? 'wizard-error' : undefined} />
            </label>
            {paths.map((p, i) => (
              <div key={i} className="grid grid-cols-2 gap-3 sm:col-span-2">
                <label className="block">
                  <span className="text-xs text-text-secondary">{t('wizard.incomeLabel', { label: p.label || t('wizard.pathLabel', { index: i + 1 }) })}</span>
                  <input type="number" min="0" className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={p.income} onChange={e => updatePath(i, { income: +e.target.value })} aria-describedby={validationError ? 'wizard-error' : undefined} />
                </label>
                <label className="block">
                  <span className="text-xs text-text-secondary">{t('wizard.savingsLabel', { label: p.label || t('wizard.pathLabel', { index: i + 1 }) })}</span>
                  <input type="number" min="0" className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm" value={p.savings} onChange={e => updatePath(i, { savings: +e.target.value })} aria-describedby={validationError ? 'wizard-error' : undefined} />
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <h3 className="mb-3 font-medium">{t('wizard.configSummary')}</h3>
          <pre className="overflow-x-auto rounded-lg bg-surface p-3 text-xs">
            {JSON.stringify({ paths: paths.map(p => ({ id: p.id, label: p.label, branches: p.branches.length })), age, horizonYears }, null, 2)}
          </pre>
        </div>
      )}
      </div>

      <div className="mt-6 flex justify-between sm:static fixed bottom-0 left-0 right-0 z-10 border-t border-border bg-surface-elevated p-4 sm:border-0 sm:bg-transparent sm:p-0">
        <button
          type="button"
          onClick={() => { setStep(s => s - 1); setValidationError(null); }}
          disabled={step === 0}
          className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-30"
        >
          {t('wizard.previous')}
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={tryNext} className="rounded-lg bg-primary px-4 py-2 text-sm text-white">
            {t('wizard.next')}
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={createSim.isPending || !isOnline}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
              aria-describedby={!isOnline ? 'wizard-offline-hint' : undefined}
            >
              {createSim.isPending ? t('wizard.creating') : t('wizard.create')}
            </button>
            {!isOnline && <span id="wizard-offline-hint" className="text-xs text-warning">{t('common.offline')}</span>}
          </div>
        )}
      </div>
      <div className="h-16 sm:hidden" />
    </>
  );
}
