import { useTranslation } from 'react-i18next';
import type { RuntimeSyncStateV2 } from '@chrono/contracts';

interface SyncStatusIndicatorProps {
  state: RuntimeSyncStateV2;
  pendingCount?: number;
  className?: string;
}

const STATE_COLORS: Record<RuntimeSyncStateV2, string> = {
  initial_sync:      '#0369A1',
  online_synced:     '#2f6b3b',
  online_dirty:      '#0369A1',
  syncing:           '#0369A1',
  offline_queueing:  '#6B7280',
  offline_readonly:  '#6B7280',
  conflict_inbox:    '#C2410C',
  degraded_remote:   '#9f2621',
  reauth_required:   '#C2410C',
  recovery_required: '#9f2621',
};

export function SyncStatusIndicator({
  state,
  pendingCount = 0,
  className,
}: SyncStatusIndicatorProps) {
  const { t } = useTranslation();
  const label = t(`syncStatus.${state}`);
  const ariaLabel = pendingCount > 0 ? `${label} (${pendingCount})` : label;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span
        aria-hidden="true"
        style={{
          backgroundColor: STATE_COLORS[state],
          borderRadius: '9999px',
          display: 'inline-block',
          height: 8,
          width: 8,
        }}
      />
      <span>
        {label}
        {pendingCount > 0 ? ` (${pendingCount})` : null}
      </span>
    </span>
  );
}
