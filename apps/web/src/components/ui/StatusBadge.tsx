import { useTranslation } from 'react-i18next';

type Status = 'active' | 'paused' | 'error' | 'syncing' | 'offline' | 'completed';

interface StatusBadgeProps {
  status: Status;
  label?: string;
  size?: 'sm' | 'md';
}

const STATUS_CONFIG: Record<Status, { bg: string; text: string; icon: string; labelKey: string }> = {
  active:    { bg: 'bg-active/10',    text: 'text-active',    icon: '●', labelKey: 'statusBadge.active' },
  completed: { bg: 'bg-completed/10', text: 'text-completed', icon: '✓', labelKey: 'statusBadge.completed' },
  paused:   { bg: 'bg-paused/10',    text: 'text-paused',    icon: '⏸', labelKey: 'statusBadge.paused' },
  error:    { bg: 'bg-error/10',     text: 'text-error',     icon: '✕', labelKey: 'statusBadge.error' },
  syncing:  { bg: 'bg-syncing/10',   text: 'text-syncing',   icon: '↻', labelKey: 'statusBadge.syncing' },
  offline:  { bg: 'bg-offline/10',   text: 'text-offline',   icon: '○', labelKey: 'statusBadge.offline' },
};

export function StatusBadge({ status, label, size = 'sm' }: StatusBadgeProps) {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status];
  const displayLabel = label ?? t(config.labelKey);
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${config.bg} ${config.text} ${sizeClass}`}
      aria-label={displayLabel}
    >
      <span aria-hidden="true">{config.icon}</span>
      {displayLabel}
    </span>
  );
}
