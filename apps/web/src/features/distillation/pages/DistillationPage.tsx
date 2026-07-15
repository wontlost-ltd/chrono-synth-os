import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { FormField } from '../../../components/ui/FormField';
import { usePersonaCoreList } from '../../../api/queries/personaCore';
import {
  useDistillCandidates, useDistillArtifacts, useApproveArtifact, useRejectArtifact,
  type DistillArtifact,
} from '../../../api/queries/distillation';
import { ApiError } from '../../../api/client';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

/* 人格蒸馏审批页（ADR-0047）：选 persona → 待审批候选（approve 直接批 / reject 填原因）+ 历史工件（审计）。
 * approve = 编译进内核（高影响），置信度作可信度徽章；404/409 给明确文案。 */

type Tab = 'candidates' | 'artifacts';

/** confidence → 徽章色（高置信绿、中黄、低红）。 */
function confidenceClass(confidence: number): string {
  if (confidence >= 0.75) return 'bg-active/10 text-active';
  if (confidence >= 0.4) return 'bg-warning/10 text-warning';
  return 'bg-error/10 text-error';
}

function errMessage(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('distillation.errors.rateLimited');
    if (err.status === 409) return t('distillation.errors.conflict');
    if (err.status === 404) return t('distillation.errors.notFound');
    return err.messageId ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function DistillationPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('distillation.title'));

  const personas = usePersonaCoreList();
  const [personaId, setPersonaId] = useState('');
  const [tab, setTab] = useState<Tab>('candidates');
  const [rejectTarget, setRejectTarget] = useState<DistillArtifact | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (!personas.data?.length) return;
    const exists = personas.data.some(p => p.id === personaId);
    if (!personaId || !exists) setPersonaId(personas.data[0]!.id);
  }, [personas.data, personaId]);

  const candidates = useDistillCandidates(personaId);
  const artifacts = useDistillArtifacts(personaId);
  const approve = useApproveArtifact(personaId);
  const reject = useRejectArtifact(personaId);

  const list = personas.data ?? [];
  const active = tab === 'candidates' ? candidates : artifacts;
  const showActions = tab === 'candidates';

  const submitReject = () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    reject.mutate({ artifactId: rejectTarget.id, reason: rejectReason.trim() }, {
      onSuccess: () => { setRejectTarget(null); setRejectReason(''); },
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('distillation.title')} subtitle={t('distillation.subtitle')} />

      <div className="flex items-center gap-3">
        <label htmlFor="distill-persona" className="text-sm text-text-secondary">{t('distillation.personaLabel')}</label>
        <select
          id="distill-persona"
          value={personaId}
          onChange={e => setPersonaId(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          disabled={!list.length}
        >
          {list.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      </div>

      {!personas.isLoading && list.length === 0 && (
        <EmptyState title={t('distillation.noPersona')} message={t('distillation.noPersonaHint')} />
      )}

      {personaId && (
        <>
          {/* tab 切换 */}
          <div role="tablist" className="flex gap-1 border-b border-border">
            {(['candidates', 'artifacts'] as Tab[]).map(k => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-primary text-text-primary' : 'text-text-secondary'}`}
              >
                {t(`distillation.tab.${k}`)}
              </button>
            ))}
          </div>

          {/* 全局 mutation 错误 */}
          {(approve.error || reject.error) && (
            <p role="alert" className="text-sm text-error">{errMessage(t, approve.error ?? reject.error)}</p>
          )}

          {active.isLoading ? (
            <Skeleton variant="table" />
          ) : active.error ? (
            <p role="alert" className="text-sm text-error">{errMessage(t, active.error)}</p>
          ) : !active.data?.items.length ? (
            <EmptyState
              title={t(showActions ? 'distillation.candidates.empty' : 'distillation.artifacts.empty')}
              message={t(showActions ? 'distillation.candidates.emptyHint' : 'distillation.artifacts.emptyHint')}
            />
          ) : (
            <ul className="space-y-3">
              {active.data.items.map(a => (
                <li key={a.id} className="rounded-lg border border-border bg-surface-elevated p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-text-primary">{t(`distillation.kind.${a.kind}`)}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${confidenceClass(a.confidence)}`}>
                          {t('distillation.confidence')}: {(a.confidence * 100).toFixed(0)}%
                        </span>
                        {!showActions && (
                          <span className="rounded-full bg-neutral-1 px-2 py-0.5 text-xs text-text-secondary">
                            {t(`distillation.status.${a.status}`)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {t(`distillation.source.${a.source}`)} · {new Date(a.createdAt).toLocaleString()}
                        {a.evidence.length > 0 && ` · ${t('distillation.evidenceCount').replace('{n}', String(a.evidence.length))}`}
                      </p>
                    </div>

                    {showActions && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate(a.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-60"
                        >
                          {t('distillation.actions.approve')}
                        </button>
                        <button
                          type="button"
                          disabled={reject.isPending}
                          onClick={() => { setRejectTarget(a); setRejectReason(''); }}
                          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-error hover:bg-error/5 disabled:opacity-60"
                        >
                          {t('distillation.actions.reject')}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* payload 摘要（unknown → JSON 展示，供审阅提议内容） */}
                  <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-neutral-1 p-3 text-xs text-text-secondary">
                    {JSON.stringify(a.payload, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* 拒绝原因 Modal */}
      <Modal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title={t('distillation.reject.title')}>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">{t('distillation.reject.hint')}</p>
          <FormField label={t('distillation.reject.reasonLabel')}>
            {(props) => (
              <textarea
                {...props}
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                maxLength={500}
                rows={3}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                placeholder={t('distillation.reject.reasonPlaceholder')}
              />
            )}
          </FormField>
          {reject.error && <p role="alert" className="text-sm text-error">{errMessage(t, reject.error)}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRejectTarget(null)} className="rounded-lg border border-border px-4 py-2 text-sm">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submitReject}
              disabled={!rejectReason.trim() || reject.isPending}
              className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {reject.isPending ? t('common.loading') : t('distillation.actions.reject')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
