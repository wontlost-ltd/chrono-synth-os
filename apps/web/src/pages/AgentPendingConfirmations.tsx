/**
 * 待确认调用列表 (F3).
 *
 * 当 persona 试图执行 highRisk 工具（如 email.send / calendar.create）
 * 而 confirmationToken 缺失时，pipeline 会发出一个 pending_confirmation
 * invocation。这个页面让用户审批/拒绝。
 *
 * 设计取舍：approve 需要重放原始 arguments — 后端不持久化 args
 * 避免 PII；UI 提示用户从 audit_log 或 LLM 历史中复制原始 JSON。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  usePendingConfirmations,
  useApproveConfirmation,
  useRejectConfirmation,
  type PendingConfirmation,
} from '../api/queries/agent-confirmations';

function formatTs(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function AgentPendingConfirmations() {
  const { t } = useTranslation();
  useDocumentTitle(t('agentConfirmations.documentTitle'));
  const list = usePendingConfirmations(20);
  const [activeApproval, setActiveApproval] = useState<PendingConfirmation | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('agentConfirmations.title')}
        subtitle={t('agentConfirmations.subtitle')}
      />

      {list.isLoading ? (
        <Skeleton variant="card" />
      ) : list.error ? (
        <EmptyState
          variant="error"
          message={t('agentConfirmations.errors.loadFailed', { message: (list.error as Error).message })}
        />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState message={t('agentConfirmations.empty')} />
      ) : (
        <ul className="space-y-3">
          {list.data!.map((c) => (
            <PendingItem
              key={c.invocationId}
              item={c}
              onApprove={() => setActiveApproval(c)}
            />
          ))}
        </ul>
      )}

      {activeApproval && (
        <ApproveDialog
          item={activeApproval}
          onClose={() => setActiveApproval(null)}
        />
      )}
    </div>
  );
}

interface ItemProps {
  item: PendingConfirmation;
  onApprove: () => void;
}

function PendingItem({ item, onApprove }: ItemProps) {
  const { t } = useTranslation();
  const reject = useRejectConfirmation();
  return (
    <li className="rounded-xl border border-border bg-surface-elevated p-4 space-y-2">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{item.toolId}</span>
          <StatusBadge status="paused" label={t('agentConfirmations.statusPending')} />
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-xs text-white hover:bg-primary-light"
            onClick={onApprove}
          >
            {t('agentConfirmations.actions.approve')}
          </button>
          <button
            type="button"
            className="text-xs text-warning hover:underline"
            disabled={reject.isPending}
            onClick={() => {
              if (!item.confirmationTokenId) return;
              const reason = window.prompt(t('agentConfirmations.prompts.rejectReason')) ?? 'user_rejected';
              reject.mutate({ tokenId: item.confirmationTokenId, reason });
            }}
          >
            {t('agentConfirmations.actions.reject')}
          </button>
        </div>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-text-secondary">
        <div>{t('agentConfirmations.fields.persona')}：<span className="font-mono">{item.personaId}</span></div>
        <div>{t('agentConfirmations.fields.invoker')}：<span className="font-mono">{item.invokerType}</span></div>
        <div>{t('agentConfirmations.fields.invokedAt')}：{formatTs(item.invokedAt)}</div>
        <div>{t('agentConfirmations.fields.inputHash')}：<span className="font-mono">{item.inputHash.slice(0, 16)}…</span></div>
      </div>
    </li>
  );
}

interface ApproveDialogProps {
  item: PendingConfirmation;
  onClose: () => void;
}

function ApproveDialog({ item, onClose }: ApproveDialogProps) {
  const { t } = useTranslation();
  const approve = useApproveConfirmation();
  const [argsJson, setArgsJson] = useState('{\n  \n}');
  const [parseError, setParseError] = useState<string | null>(null);

  const handleSubmit = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(argsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('agentConfirmations.errors.argsNotObject'));
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('agentConfirmations.errors.argsParseFailed'));
      return;
    }
    setParseError(null);
    if (!item.confirmationTokenId) return;
    try {
      await approve.mutateAsync({ tokenId: item.confirmationTokenId, arguments: parsed });
      onClose();
    } catch {
      /* error message rendered below */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface-elevated p-4 space-y-3">
        <h2 className="text-base font-semibold">{t('agentConfirmations.dialog.title')}</h2>
        <div className="text-sm space-y-1">
          <p><strong>{t('agentConfirmations.dialog.tool')}：</strong> <span className="font-mono">{item.toolId}</span></p>
          <p><strong>{t('agentConfirmations.dialog.persona')}：</strong> <span className="font-mono">{item.personaId}</span></p>
          <p className="text-xs text-text-secondary">{t('agentConfirmations.dialog.hint')}</p>
        </div>
        <textarea
          className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-xs"
          rows={8}
          value={argsJson}
          onChange={(e) => setArgsJson(e.target.value)}
        />
        {parseError && <p className="text-xs text-warning">{parseError}</p>}
        {approve.error && (
          <p className="text-xs text-warning">
            {t('agentConfirmations.errors.submitFailed', { message: (approve.error as Error).message })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-surface"
            onClick={onClose}
          >
            {t('agentConfirmations.actions.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50"
            disabled={approve.isPending}
            onClick={handleSubmit}
          >
            {approve.isPending
              ? t('agentConfirmations.actions.executing')
              : t('agentConfirmations.actions.execute')}
          </button>
        </div>
      </div>
    </div>
  );
}
