import type { RuntimeSyncStateV2 } from '@chrono/contracts';
import clsx from 'clsx';

interface SyncStateView {
  color: string;
  icon: string;
  label: string;
  pulse?: boolean;
}

const syncStateViews: Record<RuntimeSyncStateV2, SyncStateView> = {
  initial_sync: { color: 'bg-blue-400', icon: '↻', label: 'Syncing…', pulse: true },
  online_synced: { color: 'bg-green-500', icon: '✓', label: 'Synced' },
  online_dirty: { color: 'bg-yellow-400', icon: '●', label: 'Pending' },
  syncing: { color: 'bg-blue-400', icon: '↻', label: 'Syncing…', pulse: true },
  offline_queueing: { color: 'bg-orange-400', icon: '↯', label: 'Offline' },
  offline_readonly: { color: 'bg-gray-400', icon: '🔒', label: 'Read-only' },
  conflict_inbox: { color: 'bg-red-400', icon: '⚠', label: 'Conflicts' },
  degraded_remote: { color: 'bg-orange-400', icon: '⚡', label: 'Degraded' },
  reauth_required: { color: 'bg-red-500', icon: '✕', label: 'Re-auth' },
  recovery_required: { color: 'bg-red-500', icon: '✕', label: 'Recovery' },
};

export function SyncBadge({ state }: { state: RuntimeSyncStateV2 }) {
  const view = syncStateViews[state];

  return (
    <span
      role="status"
      aria-label={`Sync status: ${view.label}`}
      className="inline-flex items-center gap-2 rounded-full border border-chrono-border bg-chrono-elevated px-2.5 py-1 text-xs font-medium text-chrono-text-primary"
    >
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          view.color,
          view.pulse && 'motion-safe:animate-pulse',
        )}
      />
      <span className="text-[11px] leading-none text-chrono-text-secondary">{view.icon}</span>
      <span className="leading-none">{view.label}</span>
    </span>
  );
}
