import { useTranslation } from 'react-i18next';
import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useConflictInbox, type ConflictAction } from './useConflictInbox';

const SEVERITY_CLASS: Record<ConflictInboxItemV1['severity'], string> = {
  blocking: 'bg-error/10 text-error',
  warning: 'bg-warning/10 text-warning',
};

function formatParams(params: ConflictInboxItemV1['localSummaryParams']): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '{}';
  return entries.map(([key, value]) => `${key}: ${value}`).join(', ');
}

function ConflictRow({
  item,
  resolving,
  onResolve,
}: {
  item: ConflictInboxItemV1;
  resolving: boolean;
  onResolve: (action: ConflictAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">
              {item.entityType} / {item.entityId}
            </h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[item.severity]}`}>
              {item.severity}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {item.sourceRuntime} · {new Date(item.detectedAt).toLocaleString()}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {item.suggestedActions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={resolving}
              onClick={() => onResolve(action)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resolving ? t('conflicts.resolving') : t(`conflicts.actions.${action}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-md bg-surface p-3">
          <p className="text-xs font-medium text-text-secondary">{item.localSummaryId}</p>
          <p className="mt-1 break-words text-sm text-text-primary">{formatParams(item.localSummaryParams)}</p>
        </div>
        <div className="rounded-md bg-surface p-3">
          <p className="text-xs font-medium text-text-secondary">{item.serverSummaryId}</p>
          <p className="mt-1 break-words text-sm text-text-primary">{formatParams(item.serverSummaryParams)}</p>
        </div>
      </div>
    </li>
  );
}

export function ConflictInboxPage() {
  const { t } = useTranslation();
  const { conflicts, loading, resolving, error, resolve, refresh } = useConflictInbox();

  /* 解析 i18n key 顺序：messageId（后端权威）→ conflicts.errors.<code> → 默认通用键。
   * 这样后端添加新的 code 时，没翻译也能落到一个合理的 fallback 字符串。 */
  const errorKey = error
    ? error.messageId ?? (error.code ? `conflicts.errors.${error.code}` : 'conflicts.errors.UNKNOWN')
    : null;

  return (
    <>
      <PageHeader title={t('conflicts.title')} subtitle={t('conflicts.subtitle')} />

      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface"
        >
          {t('conflicts.refresh')}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-error/40 bg-error/5 p-4 text-sm text-error"
        >
          <div>
            <p className="font-medium">
              {error.scope === 'load' ? t('conflicts.errors.loadTitle') : t('conflicts.errors.resolveTitle')}
            </p>
            <p className="mt-1 text-error/80">
              {t(errorKey!, { defaultValue: error.message })}
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 rounded-md border border-error/40 px-3 py-1 text-xs text-error hover:bg-error/10"
          >
            {t('conflicts.errors.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <Skeleton variant="table" />
      ) : conflicts.length === 0 && !error ? (
        <div className="rounded-lg border border-border bg-surface-elevated p-6 text-sm text-text-secondary">
          {t('conflicts.empty')}
        </div>
      ) : conflicts.length === 0 ? null : (
        <ul className="space-y-3">
          {conflicts.map((item) => (
            <ConflictRow
              key={item.conflictId}
              item={item}
              resolving={resolving === item.conflictId}
              onResolve={(action) => {
                void resolve(item.conflictId, item.conflictVersion, action);
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export default ConflictInboxPage;
