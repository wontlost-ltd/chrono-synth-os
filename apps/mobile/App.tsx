import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TabNavigator } from './src/navigation/TabNavigator';
import {
  RuntimeSyncBadge,
  registerBackgroundSync,
  useMobileSyncState,
  usePushSync,
} from './src/sync';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export default function App() {
  const { state, conflictCount, triggerSync } = useMobileSyncState();

  usePushSync(triggerSync);

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
            <TabNavigator conflictCount={conflictCount} />
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
