import { useTranslation } from 'react-i18next';
import type { WsStatus } from '../../hooks/useWebSocket';

interface LiveIndicatorProps {
  status: WsStatus;
}

const STATUS_COLORS: Record<WsStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-accent animate-pulse',
  disconnected: 'bg-warning',
};

export function LiveIndicator({ status }: LiveIndicatorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1.5" title={t(`liveIndicator.${status}`)}>
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[status]}`} aria-hidden="true" />
      <span className="text-xs text-text-secondary">{t(`liveIndicator.${status}`)}</span>
    </div>
  );
}
