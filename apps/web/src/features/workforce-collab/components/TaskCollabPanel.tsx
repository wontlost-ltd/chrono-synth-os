import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../../components/ui/Skeleton';
import { ApiError } from '../../../api/client';
import type { OrgTask } from '../../../api/queries/workforce';
import {
  useEscalations, useRaiseEscalation, useResolveEscalation, useReescalate, useCancelEscalation,
  useHandoffs, useProposeHandoff, useAcceptHandoff, useRejectHandoff, useCancelHandoff,
  type OrgEscalation, type OrgHandoff,
} from '../../../api/queries/workforce-collab';

/** per-task 协作面板：升级链（B3）+ 交接（B2）。admin-gated；workerId 从 workerNames 选或手输。 */
export function TaskCollabPanel({ orgId, task, workerNames }: { orgId: string; task: OrgTask; workerNames: Map<string, string> }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-border bg-surface-elevated p-4">
      <h3 className="mb-1 text-sm font-semibold text-text-primary">{t('collab.panel.heading')}</h3>
      <p className="mb-4 text-xs text-text-secondary">{task.title}</p>
      <div className="grid gap-6 md:grid-cols-2">
        <EscalationsBlock orgId={orgId} taskId={task.id} workerNames={workerNames} />
        <HandoffsBlock orgId={orgId} taskId={task.id} workerNames={workerNames} />
      </div>
    </section>
  );
}

function errMsg(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('collab.errors.rateLimited');
    if (err.status === 409) return t('collab.errors.conflict');
    return err.messageId ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const nameOf = (m: Map<string, string>, id: string) => m.get(id) ?? id;

/* ── 升级链（B3）── */
function EscalationsBlock({ orgId, taskId, workerNames }: { orgId: string; taskId: string; workerNames: Map<string, string> }) {
  const { t } = useTranslation();
  const list = useEscalations(orgId, taskId);
  const raise = useRaiseEscalation(orgId);
  const resolve = useResolveEscalation(orgId, taskId);
  const reesc = useReescalate(orgId, taskId);
  const cancel = useCancelEscalation(orgId, taskId);
  const [fromWorkerId, setFromWorkerId] = useState('');
  const [reason, setReason] = useState('');

  const canRaise = fromWorkerId.trim() && reason.trim() && !raise.isPending;

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('collab.escalations.heading')}</h4>

      {list.isLoading ? <Skeleton className="h-20 w-full" /> : list.error ? (
        <p role="alert" className="text-sm text-error">{errMsg(t, list.error)}</p>
      ) : !list.data?.length ? (
        <p className="text-xs text-text-secondary">{t('collab.escalations.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {list.data.map((e: OrgEscalation) => (
            <li key={e.id} className="rounded-lg border border-border p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">{nameOf(workerNames, e.fromWorkerId)} → {nameOf(workerNames, e.toWorkerId)}</span>
                <span className="text-text-secondary">{t(`collab.escStatus.${e.status}`, e.status)}（L{e.depth}）</span>
              </div>
              <p className="mt-1 text-text-secondary">{e.reason}</p>
              {e.status === 'pending' && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <button disabled={resolve.isPending} onClick={() => { const r = window.prompt(t('collab.escalations.resolvePrompt'))?.trim(); const w = window.prompt(t('collab.escalations.byWorkerPrompt'))?.trim(); if (r && w) resolve.mutate({ escalationId: e.id, resolvingWorkerId: w, resolution: r }); }}
                    className="rounded bg-primary px-2 py-0.5 text-white disabled:opacity-50">{t('collab.escalations.resolve')}</button>
                  <button disabled={reesc.isPending} onClick={() => { const w = window.prompt(t('collab.escalations.byWorkerPrompt'))?.trim(); const r = window.prompt(t('collab.escalations.reescReasonPrompt'))?.trim(); if (w && r) reesc.mutate({ escalationId: e.id, byWorkerId: w, reason: r }); }}
                    className="rounded border border-border px-2 py-0.5 disabled:opacity-50">{t('collab.escalations.reescalate')}</button>
                  <button disabled={cancel.isPending} onClick={() => { const w = window.prompt(t('collab.escalations.byWorkerPrompt'))?.trim(); if (w) cancel.mutate({ escalationId: e.id, byWorkerId: w }); }}
                    className="rounded border border-border px-2 py-0.5 text-error disabled:opacity-50">{t('collab.cancel')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 发起升级 */}
      <div className="mt-3 space-y-2">
        <input value={fromWorkerId} onChange={e => setFromWorkerId(e.target.value)} placeholder={t('collab.fromWorkerId')} className="w-full rounded border border-border px-2 py-1 text-xs" />
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('collab.escalations.reasonPlaceholder')} className="w-full rounded border border-border px-2 py-1 text-xs" />
        <button disabled={!canRaise} onClick={() => raise.mutate({ taskId, fromWorkerId: fromWorkerId.trim(), reason: reason.trim() }, { onSuccess: () => { setReason(''); } })}
          className="rounded bg-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{raise.isPending ? t('common.loading') : t('collab.escalations.raise')}</button>
        {(raise.error || resolve.error || reesc.error || cancel.error) && (
          <p role="alert" className="text-xs text-error">{errMsg(t, raise.error ?? resolve.error ?? reesc.error ?? cancel.error)}</p>
        )}
      </div>
    </div>
  );
}

/* ── 交接（B2）── */
function HandoffsBlock({ orgId, taskId, workerNames }: { orgId: string; taskId: string; workerNames: Map<string, string> }) {
  const { t } = useTranslation();
  const list = useHandoffs(orgId, taskId);
  const propose = useProposeHandoff(orgId);
  const accept = useAcceptHandoff(orgId, taskId);
  const reject = useRejectHandoff(orgId, taskId);
  const cancel = useCancelHandoff(orgId, taskId);
  const [fromWorkerId, setFromWorkerId] = useState('');
  const [toWorkerId, setToWorkerId] = useState('');
  const [reason, setReason] = useState('');

  const canPropose = fromWorkerId.trim() && toWorkerId.trim() && !propose.isPending;
  const respond = (m: { mutate: (v: { handoffId: string; byWorkerId: string }) => void }, id: string) => { const w = window.prompt(t('collab.escalations.byWorkerPrompt'))?.trim(); if (w) m.mutate({ handoffId: id, byWorkerId: w }); };

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('collab.handoffs.heading')}</h4>

      {list.isLoading ? <Skeleton className="h-20 w-full" /> : list.error ? (
        <p role="alert" className="text-sm text-error">{errMsg(t, list.error)}</p>
      ) : !list.data?.length ? (
        <p className="text-xs text-text-secondary">{t('collab.handoffs.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {list.data.map((h: OrgHandoff) => (
            <li key={h.id} className="rounded-lg border border-border p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">{nameOf(workerNames, h.fromWorkerId)} → {nameOf(workerNames, h.toWorkerId)}</span>
                <span className="text-text-secondary">{t(`collab.handoffStatus.${h.status}`, h.status)}</span>
              </div>
              {h.reason && <p className="mt-1 text-text-secondary">{h.reason}</p>}
              {h.status === 'proposed' && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <button disabled={accept.isPending} onClick={() => respond(accept, h.id)} className="rounded bg-primary px-2 py-0.5 text-white disabled:opacity-50">{t('collab.handoffs.accept')}</button>
                  <button disabled={reject.isPending} onClick={() => respond(reject, h.id)} className="rounded border border-border px-2 py-0.5 disabled:opacity-50">{t('collab.handoffs.reject')}</button>
                  <button disabled={cancel.isPending} onClick={() => respond(cancel, h.id)} className="rounded border border-border px-2 py-0.5 text-error disabled:opacity-50">{t('collab.cancel')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 提议交接 */}
      <div className="mt-3 space-y-2">
        <input value={fromWorkerId} onChange={e => setFromWorkerId(e.target.value)} placeholder={t('collab.fromWorkerId')} className="w-full rounded border border-border px-2 py-1 text-xs" />
        <input value={toWorkerId} onChange={e => setToWorkerId(e.target.value)} placeholder={t('collab.toWorkerId')} className="w-full rounded border border-border px-2 py-1 text-xs" />
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('collab.handoffs.reasonPlaceholder')} className="w-full rounded border border-border px-2 py-1 text-xs" />
        <button disabled={!canPropose} onClick={() => propose.mutate({ taskId, fromWorkerId: fromWorkerId.trim(), toWorkerId: toWorkerId.trim(), reason: reason.trim() || undefined }, { onSuccess: () => setReason('') })}
          className="rounded bg-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{propose.isPending ? t('common.loading') : t('collab.handoffs.propose')}</button>
        {(propose.error || accept.error || reject.error || cancel.error) && (
          <p role="alert" className="text-xs text-error">{errMsg(t, propose.error ?? accept.error ?? reject.error ?? cancel.error)}</p>
        )}
      </div>
    </div>
  );
}
