import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { useStrategyAdvise, type StrategicInitiative, type StrategyAlternative } from '../../../api/queries/workforce-collab';

/** 战略辅助（M7，零-LLM 确定性，恒需人类批准）：输入目标+预算+风险容忍+候选举措 → 3 视角排序对比。 */
export function StrategyAdvisorPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const advise = useStrategyAdvise(orgId);
  const [objective, setObjective] = useState('');
  const [budgetCap, setBudgetCap] = useState('10000');
  const [riskTolerance, setRiskTolerance] = useState<'low' | 'medium' | 'high'>('medium');
  const [initiatives, setInitiatives] = useState<StrategicInitiative[]>([blankInitiative(1)]);

  /* 数值校验（Codex 复审）：budgetCap 须 finite ≥0；每个举措 priority/impact/feasibility 须 1..5、cost ≥0——
   * 否则空串→0 / NaN / 越界会让后端 zod 400。前端在此挡住，避免可点却必败。 */
  const budgetOk = Number.isFinite(Number(budgetCap)) && Number(budgetCap) >= 0;
  const initiativesOk = initiatives.length >= 1 && initiatives.every(i =>
    i.title.trim() && i.goalType.trim() &&
    [i.priority, i.impact, i.feasibility].every(n => Number.isInteger(n) && n >= 1 && n <= 5) &&
    Number.isFinite(i.estimatedCost) && i.estimatedCost >= 0);
  const canSubmit = objective.trim() && budgetOk && initiativesOk && !advise.isPending;

  const update = (idx: number, patch: Partial<StrategicInitiative>) =>
    setInitiatives(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));

  const submit = () => advise.mutate({
    objective: objective.trim(), budgetCap: Number(budgetCap), riskTolerance,
    initiatives: initiatives.map(i => ({ ...i, title: i.title.trim(), goalType: i.goalType.trim() })),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      {/* 输入表单 */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">{t('collab.strategy.inputHeading')}</h3>
        <p className="text-xs text-text-secondary">{t('collab.strategy.hint')}</p>
        <input value={objective} onChange={e => setObjective(e.target.value)} placeholder={t('collab.strategy.objective')} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <input type="number" min={0} value={budgetCap} onChange={e => setBudgetCap(e.target.value)} placeholder={t('collab.strategy.budgetCap')} className="w-32 rounded-lg border border-border px-3 py-2 text-sm" />
          <select value={riskTolerance} onChange={e => setRiskTolerance(e.target.value as 'low' | 'medium' | 'high')} className="rounded-lg border border-border px-3 py-2 text-sm">
            {(['low', 'medium', 'high'] as const).map(r => <option key={r} value={r}>{t(`collab.strategy.risk.${r}`)}</option>)}
          </select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">{t('collab.strategy.initiatives')}</span>
            <button onClick={() => setInitiatives(prev => [...prev, blankInitiative(prev.length + 1)])} className="text-xs text-primary hover:underline">+ {t('collab.strategy.addInitiative')}</button>
          </div>
          {initiatives.map((it, idx) => (
            <div key={it.id} className="space-y-1 rounded-lg border border-border p-2">
              <div className="flex gap-1">
                <input value={it.title} onChange={e => update(idx, { title: e.target.value })} placeholder={t('collab.strategy.initTitle')} className="flex-1 rounded border border-border px-2 py-1 text-xs" />
                <input value={it.goalType} onChange={e => update(idx, { goalType: e.target.value })} placeholder={t('collab.strategy.initGoalType')} className="w-28 rounded border border-border px-2 py-1 text-xs" />
                {initiatives.length > 1 && <button onClick={() => setInitiatives(prev => prev.filter((_, i) => i !== idx))} className="px-1 text-xs text-error">✕</button>}
              </div>
              <div className="flex flex-wrap gap-1 text-xs">
                <NumField label={t('collab.strategy.priority')} value={it.priority} onChange={v => update(idx, { priority: v })} min={1} max={5} />
                <NumField label={t('collab.strategy.impact')} value={it.impact} onChange={v => update(idx, { impact: v })} min={1} max={5} />
                <NumField label={t('collab.strategy.feasibility')} value={it.feasibility} onChange={v => update(idx, { feasibility: v })} min={1} max={5} />
                <NumField label={t('collab.strategy.cost')} value={it.estimatedCost} onChange={v => update(idx, { estimatedCost: v })} min={0} />
                <select value={it.riskLevel} onChange={e => update(idx, { riskLevel: e.target.value as 'low' | 'medium' | 'high' })} className="rounded border border-border px-1 py-0.5">
                  {(['low', 'medium', 'high'] as const).map(r => <option key={r} value={r}>{t(`collab.strategy.risk.${r}`)}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>

        <button disabled={!canSubmit} onClick={submit} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {advise.isPending ? t('common.loading') : t('collab.strategy.advise')}
        </button>
        {advise.error && <p role="alert" className="text-sm text-error">{advise.error instanceof ApiError ? (advise.error.messageId ?? advise.error.message) : String(advise.error)}</p>}
      </section>

      {/* 3 视角结果 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('collab.strategy.resultHeading')}</h3>
        {!advise.data ? (
          <p className="text-xs text-text-secondary">{t('collab.strategy.resultEmpty')}</p>
        ) : (
          <div className="space-y-3">
            <p className="rounded-lg bg-warning/10 p-2 text-xs text-warning">{t('collab.strategy.requiresApproval')}</p>
            {advise.data.alternatives.map((alt: StrategyAlternative) => (
              <div key={alt.lens} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-text-primary">{t(`collab.strategy.lens.${alt.lens}`)}</h4>
                  <span className="text-xs text-text-secondary">{t('collab.strategy.included')} {alt.includedCount} · {t('collab.strategy.escalations')} {alt.escalationCount} · {t('collab.strategy.totalCost')} {alt.totalCost}</span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">{alt.rationale}</p>
                <ul className="mt-2 space-y-1">
                  {alt.rankedInitiatives.map(ri => (
                    <li key={ri.initiative.id} className={`flex items-center justify-between rounded px-2 py-1 text-xs ${ri.included ? 'bg-active/5' : 'opacity-50'}`}>
                      <span className="text-text-primary">{ri.initiative.title}</span>
                      <span className="text-text-secondary">
                        {t('collab.strategy.score')} {ri.score.toFixed(1)}
                        {ri.needsEscalation && <span className="ml-1 text-error">⚠</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function NumField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-text-secondary">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="w-12 rounded border border-border px-1 py-0.5" />
    </label>
  );
}

let idCounter = 0;
function blankInitiative(n: number): StrategicInitiative {
  idCounter += 1;
  return { id: `init-${n}-${idCounter}`, title: '', goalType: '', priority: 3, impact: 3, feasibility: 3, riskLevel: 'medium', estimatedCost: 1000 };
}
