/**
 * 移动端 ChronoCompanion ·「我的数字人」主页（ADR-0046 Phase 2.3）。
 * 渲染服务端 /companion/me：叙事 + 核心价值 + 最近记忆。
 */

import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { fetchCompanionMe } from '../../companion/companionApi';

export interface CompanionScreenProps {
  /** 当前账号身份键（userId:tenantId）——纳入 queryKey 做缓存隔离，杜绝换账号回显（Codex 隐私 Major）。 */
  readonly accountKey: string;
}

export function CompanionHomeScreen({ accountKey }: CompanionScreenProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['companion', accountKey, 'me'],
    queryFn: fetchCompanionMe,
  });

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
        <Text style={styles.muted}>读取失败，请检查网络后重新进入。</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>我的数字人</Text>
        <Text style={styles.narrative}>{data.narrative || '你的数字人还在认识你…'}</Text>
        <Text style={styles.counts}>
          {data.valueCount} 个价值观 · {data.memoryCount} 条记忆
        </Text>
      </View>

      <Text style={styles.sectionTitle}>最看重的</Text>
      {data.topValues.length === 0 ? (
        <Text style={styles.muted}>还没有形成稳定的价值观。</Text>
      ) : (
        data.topValues.map((v) => (
          <View key={v.id} style={styles.row}>
            <Text style={styles.rowLabel}>{v.label}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${Math.round(Math.min(1, Math.max(0, v.weight)) * 100)}%` }]} />
            </View>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>最近的记忆</Text>
      {data.recentMemories.length === 0 ? (
        <Text style={styles.muted}>还没有记忆。和你的数字人多聊聊吧。</Text>
      ) : (
        data.recentMemories.map((m) => (
          <View key={m.id} style={styles.memoryCard}>
            <Text style={styles.memoryContent}>{m.content}</Text>
            <Text style={styles.memoryMeta}>{new Date(m.createdAt).toLocaleString()}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  muted: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  heroCard: { backgroundColor: '#EEF2FF', borderRadius: 16, padding: 20, marginBottom: 20, borderWidth: 1, borderColor: '#C7D2FE' },
  heroLabel: { fontSize: 12, color: '#4338CA', fontWeight: '600' },
  narrative: { fontSize: 18, fontWeight: '700', marginTop: 6, color: '#1E1B4B' },
  counts: { fontSize: 13, color: '#6366F1', marginTop: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 12, color: '#334155' },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  rowLabel: { flex: 1, fontSize: 14, color: '#1E293B' },
  barTrack: { width: 120, height: 6, borderRadius: 3, backgroundColor: '#E2E8F0', overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: '#6366F1' },
  memoryCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  memoryContent: { fontSize: 14, color: '#1E293B' },
  memoryMeta: { fontSize: 12, color: '#94A3B8', marginTop: 6 },
});
