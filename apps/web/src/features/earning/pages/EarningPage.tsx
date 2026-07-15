import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Skeleton } from '../../../components/ui/Skeleton';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { usePersonaCoreList } from '../../../api/queries/personaCore';
import { useEarningWallet, useEarningFeed, useRunEarningCycle, type EarningTask } from '../../../api/queries/earning';
import { ApiError } from '../../../api/client';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

/* 数字人自主赚钱页（ADR-0048）：选一个 persona → 看钱包（只读）+ 收益流水 + 触发赚钱周期。
 * 钱包只增不减、提现须人工确认（不放自动提现按钮）；cycle 限流 12/min，429 给明确提示。 */

const TASK_STATUS_MAP: Record<EarningTask['status'], 'active' | 'paused' | 'error' | 'offline'> = {
  open: 'paused',
  accepted: 'active',
  completed: 'active',
  cancelled: 'offline',
};

function errMessage(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('earning.errors.rateLimited');
    return err.messageId ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function EarningPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('earning.title'));

  const personas = usePersonaCoreList();
  const [personaId, setPersonaId] = useState('');

  useEffect(() => {
    if (!personas.data?.length) return;
    const exists = personas.data.some(p => p.id === personaId);
    if (!personaId || !exists) setPersonaId(personas.data[0]!.id);
  }, [personas.data, personaId]);

  const wallet = useEarningWallet(personaId);
  const feed = useEarningFeed(personaId);
  const runCycle = useRunEarningCycle(personaId);

  const list = personas.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t('earning.title')} subtitle={t('earning.subtitle')} />

      {/* persona 选择器（复用 persona-core 列表） */}
      <div className="flex items-center gap-3">
        <label htmlFor="earning-persona" className="text-sm text-text-secondary">{t('earning.personaLabel')}</label>
        <select
          id="earning-persona"
          value={personaId}
          onChange={e => setPersonaId(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          disabled={!list.length}
        >
          {list.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      </div>

      {!personas.isLoading && list.length === 0 && (
        <EmptyState title={t('earning.noPersona')} message={t('earning.noPersonaHint')} />
      )}

      {personaId && (
        <>
          {/* 钱包卡（只读） */}
          <section className="rounded-lg border border-border bg-surface-elevated p-5">
            <h2 className="mb-3 text-sm font-medium text-text-secondary">{t('earning.wallet.heading')}</h2>
            {wallet.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : wallet.error ? (
              <p role="alert" className="text-sm text-error">{errMessage(t, wallet.error)}</p>
            ) : wallet.data ? (
              <div className="flex flex-wrap items-baseline gap-6">
                <div>
                  <div className="text-2xl font-semibold text-text-primary">
                    {wallet.data.balance.toFixed(2)} <span className="text-base font-normal text-text-secondary">{wallet.data.currency}</span>
                  </div>
                  <div className="text-xs text-text-secondary">{t('earning.wallet.balance')}</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold text-text-primary">{wallet.data.tokenBalance.toFixed(2)}<span className="text-base font-normal text-text-secondary"> T</span></div>
                  <div className="text-xs text-text-secondary">{t('earning.wallet.tokenBalance')}</div>
                </div>
                <p className="ml-auto max-w-xs text-xs text-text-secondary">{t('earning.wallet.withdrawalNote')}</p>
              </div>
            ) : null}
          </section>

          {/* 触发赚钱周期 */}
          <section className="rounded-lg border border-border bg-surface-elevated p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-text-primary">{t('earning.cycle.heading')}</h2>
                <p className="text-xs text-text-secondary">{t('earning.cycle.hint')}</p>
              </div>
              <button
                type="button"
                onClick={() => runCycle.mutate({})}
                disabled={runCycle.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
              >
                {runCycle.isPending ? t('common.loading') : t('earning.cycle.run')}
              </button>
            </div>
            {runCycle.error && (
              <p role="alert" className="mt-3 text-sm text-error">{errMessage(t, runCycle.error)}</p>
            )}
            {runCycle.data && (
              <div role="status" className="mt-3 rounded-lg bg-neutral-1 p-3 text-sm text-text-secondary">
                {t('earning.cycle.result')
                  .replace('{scanned}', String(runCycle.data.scanned))
                  .replace('{applied}', String(runCycle.data.applied))
                  .replace('{reviewQueued}', String(runCycle.data.reviewQueued))
                  .replace('{skipped}', String(runCycle.data.skipped))}
              </div>
            )}
          </section>

          {/* 收益流水 */}
          <section className="rounded-lg border border-border bg-surface-elevated p-5">
            <h2 className="mb-3 text-sm font-medium text-text-secondary">{t('earning.feed.heading')}</h2>
            {feed.isLoading ? (
              <Skeleton variant="table" />
            ) : feed.error ? (
              <p role="alert" className="text-sm text-error">{errMessage(t, feed.error)}</p>
            ) : !feed.data?.tasks.length ? (
              <EmptyState title={t('earning.feed.empty')} message={t('earning.feed.emptyHint')} />
            ) : (
              <ul className="space-y-2">
                {feed.data.tasks.map(task => (
                  <li key={task.id} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-text-primary">{task.title}</div>
                      <div className="text-xs text-text-secondary">{t(`earning.category.${task.category}`)}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums text-text-primary">{task.reward.toFixed(2)} {task.currency}</span>
                      <StatusBadge status={TASK_STATUS_MAP[task.status]} label={t(`earning.taskStatus.${task.status}`)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
