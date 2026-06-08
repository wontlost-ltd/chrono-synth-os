import { QueryClient, onlineManager } from '@tanstack/react-query';

/* 自动暂停/恢复：浏览器离线时暂停请求，上线后自动恢复 */
if (typeof window !== 'undefined') {
  onlineManager.setEventListener((setOnline) => {
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    return () => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    };
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        /* 网络错误重试 3 次，其他错误重试 1 次 */
        if (error instanceof TypeError) return failureCount < 3;
        return failureCount < 1;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10_000),
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
    mutations: {
      networkMode: 'offlineFirst',
    },
  },
});
