import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCompleteOnboarding } from '../api/queries/onboarding';
import { useCreateValue } from '../api/queries/values';
import { useCreateSimulation } from '../api/queries/simulations';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type Step = 'welcome' | 'template' | 'values' | 'simulation' | 'done';

const STEPS: Step[] = ['welcome', 'template', 'values', 'simulation', 'done'];

interface ValueDraft {
  label: string;
  weight: number;
}

/** 预设模板：覆盖常见用户画像
 * 注意：values[].label 会被原样写入数据库 core_values.label —— 这是用户*数据*而非
 * UI 文案。模板提供 zh-CN 默认值（与 zh-CN 默认产品语言对齐）；如果未来要让英文用户
 * 看到英文默认价值观，应当在选择模板时根据 i18n.language 切换 values 数组本身，
 * 而不是把这些字符串送进 t()。 */
const TEMPLATES = [
  { id: 'career', labelKey: 'onboarding.templateCareer', descKey: 'onboarding.templateCareerDesc', values: [{ label: '事业成就', weight: 0.9 }, { label: '工作生活平衡', weight: 0.7 }, { label: '财务安全', weight: 0.8 }] }, // i18n-allow-cjk: seed data written to DB
  { id: 'family', labelKey: 'onboarding.templateFamily', descKey: 'onboarding.templateFamilyDesc', values: [{ label: '家庭关系', weight: 0.9 }, { label: '个人成长', weight: 0.6 }, { label: '健康', weight: 0.8 }] }, // i18n-allow-cjk: seed data written to DB
  { id: 'explorer', labelKey: 'onboarding.templateExplorer', descKey: 'onboarding.templateExplorerDesc', values: [{ label: '自由', weight: 0.9 }, { label: '创造力', weight: 0.8 }, { label: '新体验', weight: 0.7 }] }, // i18n-allow-cjk: seed data written to DB
  { id: 'custom', labelKey: 'onboarding.templateCustom', descKey: 'onboarding.templateCustomDesc', values: [] },
] as const;

export function Onboarding() {
  const { t } = useTranslation();
  useDocumentTitle(t('onboarding.welcomeTitle'));
  const navigate = useNavigate();
  const completeOnboarding = useCompleteOnboarding();
  const createValue = useCreateValue();
  const createSim = useCreateSimulation();

  const [step, setStep] = useState<Step>('welcome');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [values, setValues] = useState<ValueDraft[]>([
    { label: '', weight: 0.8 },
    { label: '', weight: 0.6 },
  ]);
  const [error, setError] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);

  function selectTemplate(templateId: string) {
    setSelectedTemplate(templateId);
    const tpl = TEMPLATES.find(t => t.id === templateId);
    if (tpl && tpl.values.length > 0) {
      setValues(tpl.values.map(v => ({ ...v })));
    } else {
      setValues([{ label: '', weight: 0.8 }, { label: '', weight: 0.6 }]);
    }
    setStep('values');
  }

  function updateValue(index: number, patch: Partial<ValueDraft>) {
    setValues(prev => prev.map((v, i) => i === index ? { ...v, ...patch } : v));
    setError(null);
  }

  async function handleValuesNext() {
    const filled = values.filter(v => v.label.trim());
    if (filled.length === 0) {
      setError(t('onboarding.atLeastOneValue'));
      return;
    }
    setError(null);
    try {
      for (const v of filled) {
        await createValue.mutateAsync({ label: v.label.trim(), weight: v.weight });
      }
      setStep('simulation');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.valueError'));
    }
  }

  async function handleSimulationNext() {
    setError(null);
    try {
      const result = await createSim.mutateAsync({
        paths: [
          {
            id: 'default',
            label: t('onboarding.defaultPathLabel'),
            description: t('onboarding.defaultPathDescription'),
            initialConditions: { income: 300000, savings: 500000 },
            branches: [],
          },
        ],
        horizonYears: 10,
        age: 30,
      });
      try { localStorage.setItem('last-sim-id', result.simulationId); } catch { /* ignored */ }
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.simError'));
    }
  }

  async function handleFinish() {
    try {
      await completeOnboarding.mutateAsync();
      navigate('/dashboard');
    } catch {
      navigate('/dashboard');
    }
  }

  const isPending = createValue.isPending || createSim.isPending || completeOnboarding.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-primary">ChronoSynth</h1>
        </div>

        <div className="mb-6 flex gap-1" role="progressbar" aria-valuenow={stepIndex + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label={t('onboarding.progressLabel', { step: stepIndex + 1, total: STEPS.length })}>
          {STEPS.map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-primary' : 'bg-border'}`} />
          ))}
        </div>

        <div className="rounded-xl border border-border bg-surface-elevated p-6">
          {step === 'welcome' && (
            <>
              <h2 className="mb-2 text-lg font-medium">{t('onboarding.welcomeTitle')}</h2>
              <p className="mb-6 text-sm text-text-secondary">{t('onboarding.welcomeDescription')}</p>
              <button onClick={() => setStep('template')} className="w-full rounded-lg bg-primary px-4 py-2 text-sm text-white">
                {t('onboarding.getStarted')}
              </button>
            </>
          )}

          {step === 'template' && (
            <>
              <h2 className="mb-2 text-lg font-medium">{t('onboarding.templateTitle')}</h2>
              <p className="mb-4 text-sm text-text-secondary">{t('onboarding.templateDescription')}</p>
              <div className="space-y-3">
                {TEMPLATES.map(tpl => (
                  <button
                    key={tpl.id}
                    onClick={() => selectTemplate(tpl.id)}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                      selectedTemplate === tpl.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <p className="font-medium text-text-primary">{t(tpl.labelKey)}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">{t(tpl.descKey)}</p>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'values' && (
            <>
              <h2 className="mb-2 text-lg font-medium">{t('onboarding.valuesTitle')}</h2>
              <p className="mb-4 text-sm text-text-secondary">{t('onboarding.valuesDescription')}</p>
              <div className="space-y-3">
                {values.map((v, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <input
                      className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm"
                      placeholder={t('onboarding.valuePlaceholder', { index: i + 1 })}
                      aria-label={t('onboarding.valuePlaceholder', { index: i + 1 })}
                      value={v.label}
                      onChange={e => updateValue(i, { label: e.target.value })}
                    />
                    <input
                      type="range" min="0" max="1" step="0.1"
                      value={v.weight}
                      onChange={e => updateValue(i, { weight: +e.target.value })}
                      className="w-20"
                      aria-label={t('onboarding.weightAria', { value: v.weight.toFixed(1) })}
                    />
                    <span className="w-8 text-xs text-text-secondary">{v.weight.toFixed(1)}</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setValues(prev => [...prev, { label: '', weight: 0.5 }])}
                  className="text-sm text-primary"
                >
                  {t('onboarding.addValue')}
                </button>
              </div>
              {error && <p className="mt-3 text-sm text-warning" role="alert">{error}</p>}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setStep('template')}
                  className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface"
                >
                  {t('onboarding.back')}
                </button>
                <button
                  onClick={handleValuesNext}
                  disabled={isPending}
                  className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {isPending ? t('common.loading') : t('onboarding.next')}
                </button>
              </div>
            </>
          )}

          {step === 'simulation' && (
            <>
              <h2 className="mb-2 text-lg font-medium">{t('onboarding.simulationTitle')}</h2>
              <p className="mb-4 text-sm text-text-secondary">{t('onboarding.simulationDescription')}</p>
              {error && <p className="mb-3 text-sm text-warning" role="alert">{error}</p>}
              <button
                onClick={handleSimulationNext}
                disabled={isPending}
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {isPending ? t('common.loading') : t('onboarding.createFirstSim')}
              </button>
            </>
          )}

          {step === 'done' && (
            <>
              <h2 className="mb-2 text-lg font-medium">{t('onboarding.doneTitle')}</h2>
              <p className="mb-6 text-sm text-text-secondary">{t('onboarding.doneDescription')}</p>
              <button
                onClick={handleFinish}
                disabled={isPending}
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {t('onboarding.goToDashboard')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
