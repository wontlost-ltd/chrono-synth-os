import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useOfflineQueue } from '../../hooks/useOfflineQueue';

export function NetworkStatus() {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();
  const { count: queuedCount } = useOfflineQueue();
  const lastOnlineRef = useRef<Date | null>(isOnline ? new Date() : null);

  useEffect(() => {
    if (isOnline) lastOnlineRef.current = new Date();
  }, [isOnline]);

  if (isOnline) return null;

  const lastSeen = lastOnlineRef.current;

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-warning px-4 py-2 text-sm text-white shadow-lg"
    >
      <span>{t('common.offline')}</span>
      {lastSeen && (
        <span className="text-xs opacity-80">
          · {t('common.lastSynced', { time: lastSeen.toLocaleTimeString() })}
        </span>
      )}
      {queuedCount > 0 && (
        <span className="text-xs opacity-80">
          · {t('common.queuedActions', { count: queuedCount })}
        </span>
      )}
    </div>
  );
}
