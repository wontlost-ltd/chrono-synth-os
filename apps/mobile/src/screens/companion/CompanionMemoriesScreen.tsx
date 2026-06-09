/**
 * 移动端 ChronoCompanion ·「我的记忆」分页浏览（ADR-0046 Phase 2.3）。
 * 用 useInfiniteQuery 拉 /companion/me/memories，FlatList 触底加载下一页。
 */

import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { CompanionMemoryV1 } from '@chrono/contracts';
import { fetchCompanionMemories } from '../../companion/companionApi';
import type { CompanionScreenProps } from './CompanionHomeScreen';

const PAGE_SIZE = 20;

export function CompanionMemoriesScreen({ accountKey }: CompanionScreenProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['companion', accountKey, 'memories'],
      queryFn: ({ pageParam }) => fetchCompanionMemories(pageParam, PAGE_SIZE),
      initialPageParam: 1,
      getNextPageParam: (last) => {
        const { page, totalPages } = last.pagination;
        return page < totalPages ? page + 1 : undefined;
      },
    });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>加载中…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>读取记忆失败，请检查网络。</Text>
      </View>
    );
  }

  const items: CompanionMemoryV1[] = data?.pages.flatMap((p) => p.items) ?? [];

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>还没有记忆。和你的数字人多聊聊吧。</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={items}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.kind}>{item.kind}</Text>
            <Text style={styles.meta}>{new Date(item.createdAt).toLocaleDateString()}</Text>
          </View>
          <Text style={styles.body}>{item.content}</Text>
        </View>
      )}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
      }}
      ListFooterComponent={
        isFetchingNextPage ? <ActivityIndicator style={styles.footer} color="#6366F1" /> : null
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  muted: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  kind: { fontSize: 11, color: '#6366F1', fontWeight: '600', textTransform: 'uppercase' },
  meta: { fontSize: 12, color: '#94A3B8' },
  body: { fontSize: 14, color: '#1E293B' },
  footer: { paddingVertical: 16 },
});
