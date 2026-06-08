import { useSyncExternalStore } from 'react';

const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';

function subscribe(cb: () => void) {
  if (!isBrowser) return () => {};
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

function getSnapshot() {
  return isBrowser ? navigator.onLine : true;
}

function getServerSnapshot() {
  return true;
}

/** 返回当前在线状态，SSR 安全 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
