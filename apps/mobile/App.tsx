import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { useAuth } from './src/hooks/useAuth';
import {
  RuntimeSyncBadge,
  registerBackgroundSync,
  useMobileSyncState,
  usePushSync,
} from './src/sync';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

/** 清掉所有 companion 私有数据缓存——换账号/登出时调用，杜绝跨账号回显（Codex 隐私 Major）。 */
function clearCompanionCache(): void {
  queryClient.removeQueries({ queryKey: ['companion'] });
}

export default function App() {
  const { state, conflictCount, triggerSync } = useMobileSyncState();
  const { isAuthenticated, user, logout } = useAuth();

  usePushSync(triggerSync, isAuthenticated);

  /* 账号身份键：能区分「换账号/换 tenant」（不只是 false/true 登录态）。用它作 plan 重探测的依赖，
   * 也用它做缓存隔离的触发——身份一变就清 companion 缓存，避免 staleTime 窗口内回显上一账号数据。 */
  const accountKey = user ? `${user.userId}:${user.tenantId}` : null;

  const prevAccountKey = useRef<string | null>(null);
  useEffect(() => {
    if (prevAccountKey.current !== null && prevAccountKey.current !== accountKey) {
      clearCompanionCache(); // 账号切换（含登出 → null）：立即清缓存
    }
    prevAccountKey.current = accountKey;
  }, [accountKey]);

  /* 登出：先清 companion 私有缓存，再走 auth 登出（清 session + 状态）。 */
  const handleLogout = useCallback(() => {
    clearCompanionCache();
    logout();
  }, [logout]);

  useEffect(() => {
    void registerBackgroundSync().catch(() => {
      // Background fetch registration is best-effort on restricted/denied platforms
    });
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <View style={styles.shell}>
          <View style={styles.syncBadgeHost}>
            <RuntimeSyncBadge state={state} />
          </View>
          <NavigationContainer>
            <RootNavigator
              conflictCount={conflictCount}
              onLogout={handleLogout}
              sessionKey={accountKey ?? isAuthenticated}
            />
          </NavigationContainer>
        </View>
        <StatusBar style="light" />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
  },
  syncBadgeHost: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
});
