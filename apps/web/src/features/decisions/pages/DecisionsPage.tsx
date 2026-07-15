import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { ApiError } from '../../../api/client';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';
import {
  useDecisions, useCreateDecision, useSimulateDecision, useDecisionFeedback,
  type DecisionCase, type DecisionResult,
} from '../../../api/queries/decisions';

/**
 * 决策模拟页：建决策 case（≥2 备选）→ 蒙特卡洛模拟 → 看排序结果（推荐/对齐/风险/后悔概率）→ 反馈校准。
 * 租户级；simulate 限流 10/min 扣配额，429 明确提示。
 */

function splitLines(v: string): string[] {
  return v.split('\n').map(s => s.trim()).filter(Boolean);
}

function errMsg(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('decisions.errors.rateLimited');
    if (err.status === 402 || err.status === 403) return t('decisions.errors.quota');
    return err.messageId ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function DecisionsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('decisions.title'));
  const list = useDecisions();
  const create = useCreateDecision();
  const [selected, setSelected] = useState<DecisionCase | null>(null);
  const [form, setForm] = useState({ title: '', description: '', alternatives: '', constraints: '' });

  const canCreate = form.title.trim() && form.description.trim() && splitLines(form.alternatives).length >= 2 && !create.isPending;

  const submitCreate = () => {
    create.mutate({
      title: form.title.trim(), description: form.description.trim(),
      alternatives: splitLines(form.alternatives),
      constraints: splitLines(form.constraints).length ? splitLines(form.constraints) : undefined,
    }, { onSuccess: (c) => { setForm({ title: '', description: '', alternatives: '', constraints: '' }); setSelected(c); } });
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('decisions.title')} subtitle={t('decisions.subtitle')} />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* 左：建新 + 列表 */}
        <div className="space-y-6">
          <section className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4">
            <h2 className="text-sm font-semibold text-text-primary">{t('decisions.create.heading')}</h2>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder={t('decisions.create.title')} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} placeholder={t('decisions.create.description')} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
            <textarea value={form.alternatives} onChange={e => setForm(f => ({ ...f, alternatives: e.target.value }))} rows={3} placeholder={t('decisions.create.alternatives')} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
            <textarea value={form.constraints} onChange={e => setForm(f => ({ ...f, constraints: e.target.value }))} rows={2} placeholder={t('decisions.create.constraints')} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
            <button disabled={!canCreate} onClick={submitCreate} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {create.isPending ? t('common.loading') : t('decisions.create.submit')}
            </button>
            {create.error && <p role="alert" className="text-sm text-error">{errMsg(t, create.error)}</p>}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-text-secondary">{t('decisions.listHeading')}</h2>
            {list.isLoading ? <Skeleton variant="table" /> : list.error ? (
              <p role="alert" className="text-sm text-error">{errMsg(t, list.error)}</p>
            ) : !list.data?.data.length ? (
              <EmptyState title={t('decisions.empty')} message={t('decisions.emptyHint')} />
            ) : (
              <ul className="space-y-1">
                {list.data.data.map(d => (
                  <li key={d.id}>
                    <button onClick={() => setSelected(d)}
                      className={`w-full rounded-lg border p-2 text-left text-sm ${selected?.id === d.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-neutral-1'}`}>
                      <div className="font-medium text-text-primary">{d.title}</div>
                      <div className="text-xs text-text-secondary">{(d.alternatives?.length ?? 0)} {t('decisions.alternativesCount')}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 右：详情 + 模拟 + 结果 + 反馈 */}
        <div>
          {selected ? <DecisionDetail decision={selected} /> : (
            <EmptyState title={t('decisions.selectTitle')} message={t('decisions.selectHint')} />
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionDetail({ decision }: { decision: DecisionCase }) {
  const { t } = useTranslation();
  const simulate = useSimulateDecision(decision.id);
  const result: DecisionResult | undefined = simulate.data?.result;
  const runId = simulate.data?.runId;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-surface-elevated p-4">
        <h2 className="text-base font-semibold text-text-primary">{decision.title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{decision.description}</p>
        {decision.alternatives && (
          <ul className="mt-2 flex flex-wrap gap-1">
            {decision.alternatives.map(a => <li key={a} className="rounded-full bg-neutral-1 px-2 py-0.5 text-xs text-text-secondary">{a}</li>)}
          </ul>
        )}
        <button disabled={simulate.isPending} onClick={() => simulate.mutate()}
          className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {simulate.isPending ? t('decisions.simulating') : t('decisions.simulate')}
        </button>
        {simulate.error && <p role="alert" className="mt-2 text-sm text-error">{errMsg(t, simulate.error)}</p>}
      </section>

      {/* 排序结果 */}
      {result && (
        <section className="rounded-lg border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('decisions.result.heading')}</h3>
          <p className="mb-3 text-sm">
            {t('decisions.result.recommended')}：<span className="font-semibold text-active">{result.recommendedAlternative}</span>
          </p>
          <ul className="space-y-2">
            {result.rankedOptions.map(o => (
              <li key={o.alternative} className="rounded-lg border border-border p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">#{o.rank} {o.alternative}</span>
                  <span className="text-text-secondary">{t('decisions.result.overall')} {(o.overallScore * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-text-secondary">
                  <span>{t('decisions.result.alignment')} {(o.alignmentScore * 100).toFixed(0)}%</span>
                  <span>{t('decisions.result.risk')} {(o.riskScore * 100).toFixed(0)}%</span>
                  <span>{t('decisions.result.confidence')} {(o.confidence * 100).toFixed(0)}%</span>
                  <span className={o.regretProbability > 0.5 ? 'text-error' : ''}>{t('decisions.result.regret')} {(o.regretProbability * 100).toFixed(0)}%</span>
                </div>
              </li>
            ))}
          </ul>

          {/* 反馈 */}
          {runId && <FeedbackForm decisionId={decision.id} runId={runId} alternatives={result.rankedOptions.map(o => o.alternative)} />}
        </section>
      )}
    </div>
  );
}

function FeedbackForm({ decisionId, runId, alternatives }: { decisionId: string; runId: string; alternatives: string[] }) {
  const { t } = useTranslation();
  const feedback = useDecisionFeedback(decisionId);
  const [selectedAlternative, setSelectedAlternative] = useState(alternatives[0] ?? '');
  const [satisfaction, setSatisfaction] = useState(4);
  const [notes, setNotes] = useState('');

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('decisions.feedback.heading')}</h4>
      {feedback.isSuccess ? (
        <p role="status" className="text-sm text-active">{t('decisions.feedback.thanks')}</p>
      ) : (
        <>
          <select value={selectedAlternative} onChange={e => setSelectedAlternative(e.target.value)} className="w-full rounded border border-border px-2 py-1 text-xs">
            {alternatives.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            {t('decisions.feedback.satisfaction')}
            <input type="range" min={1} max={5} value={satisfaction} onChange={e => setSatisfaction(Number(e.target.value))} />
            <span className="font-medium text-text-primary">{satisfaction}/5</span>
          </label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder={t('decisions.feedback.notes')} className="w-full rounded border border-border px-2 py-1 text-xs" />
          <button disabled={!selectedAlternative || feedback.isPending}
            onClick={() => feedback.mutate({ runId, selectedAlternative, satisfaction, notes: notes.trim() || undefined })}
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
            {feedback.isPending ? t('common.loading') : t('decisions.feedback.submit')}
          </button>
          {feedback.error && <p role="alert" className="text-xs text-error">{errMsg(t, feedback.error)}</p>}
        </>
      )}
    </div>
  );
}
