/**
 * 移动端 ChronoCompanion ·「TA 主动跟我说的」（ADR-0054 主动性）。
 * 数字人据自己内部状态变化主动发起的消息——从「我问 TA 答」到「TA 会主动找我」。
 * 渲染服务端 /companion/me/nudges（共享 contract CompanionNudgeListV1，端到端类型同源）。
 * 列表 + 标记已读 + 下拉刷新（RN 无 fetch-SSE 基建——实时推送是后续 expo-notifications 增量）。
 */

import { useCallback } from 'react';
import { View, Text, ScrollView, Pressable, RefreshControl, StyleSheet } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from '@react-navigation/native';
import type { CompanionNudgeV1 } from '@chrono/contracts';
import { fetchCompanionNudges, markCompanionNudgeRead } from '../../companion/companionApi';
import type { CompanionScreenProps } from './CompanionHomeScreen';

/** 各 nudge 类别 → 中文标签 + 配色。 */
const KIND: Record<string, { label: string; bg: string; fg: string }> = {
  memory: { label: '回想', bg: '#E0F2FE', fg: '#075985' },
  narrative: { label: '自我', bg: '#EDE9FE', fg: '#5B21B6' },
  growth: { label: '成长', bg: '#DCFCE7', fg: '#166534' },
  general: { label: '想说', bg: '#F1F5F9', fg: '#475569' },
};

function kindStyle(kind: string): { label: string; bg: string; fg: string } {
  return KIND[kind] ?? KIND.general;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

export function CompanionNudgesScreen({ accountKey }: CompanionScreenProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['companion', accountKey, 'nudges'],
    queryFn: () => fetchCompanionNudges('all'),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => markCompanionNudgeRead(id),
    onSettled: () => {
      /* 成功/幂等都刷新（mark-read 对已读幂等 200）。 */
      void queryClient.invalidateQueries({ queryKey: ['companion', accountKey, 'nudges'] });
    },
  });

  const onRefresh = useCallback(() => { void refetch(); }, [refetch]);

  /* 进入/重回本 tab 时重取——bottom tab 默认不卸载页面，靠 focus 重取拉到离开期间新增的主动消息
   * （mobile 无 SSE，focus + 下拉刷新是实时性的来源；Codex 复审建议补齐「重进 tab 重取」承诺）。 */
  useFocusEffect(useCallback(() => { void refetch(); }, [refetch]));

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>加载中…</Text>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>读取主动消息失败，请检查网络。</Text>
      </View>
    );
  }

  const items = data.items;
  if (items.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.center}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
      >
        <Text style={styles.emptyTitle}>还没有主动消息 💬</Text>
        <Text style={styles.muted}>等我有了新的想法或成长，会主动来找你说说。</Text>
      </ScrollView>
    );
  }

  const unreadCount = items.filter((n) => n.status === 'unread').length;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
    >
      <Text style={styles.muted}>
        {unreadCount > 0 ? `有 ${unreadCount} 条还没读` : '都读过了'}
      </Text>

      {items.map((n: CompanionNudgeV1) => {
        const k = kindStyle(n.kind);
        const unread = n.status === 'unread';
        return (
          <View key={n.id} style={[styles.card, unread && styles.cardUnread]}>
            <View style={styles.cardTop}>
              <View style={[styles.badge, { backgroundColor: k.bg }]}>
                <Text style={[styles.badgeText, { color: k.fg }]}>{k.label}</Text>
              </View>
              <Text style={styles.time}>{formatTime(n.createdAt)}</Text>
            </View>
            <Text style={styles.body}>{n.body}</Text>
            {unread && (
              <Pressable
                style={styles.readBtn}
                disabled={markRead.isPending}
                onPress={() => markRead.mutate(n.id)}
              >
                <Text style={styles.readBtnText}>标记已读</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16, gap: 10 },
  center: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  muted: { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E2E8F0' },
  cardUnread: { borderColor: '#6366F1' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  time: { fontSize: 12, color: '#94A3B8' },
  body: { fontSize: 15, lineHeight: 22, color: '#1E293B' },
  readBtn: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: '#E2E8F0' },
  readBtnText: { fontSize: 13, color: '#64748B' },
});
