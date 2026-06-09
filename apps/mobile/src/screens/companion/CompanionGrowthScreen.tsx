/**
 * 移动端 ChronoCompanion ·「你最近探索的方向」（ADR-0046 Phase 2.3）。
 * 直接渲染服务端 /companion/me/growth（服务端已把 persona drift 映射成探索语义，移动端不再映射）。
 */

import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { ExplorationIntensityV1, ExplorationDirectionV1 } from '@chrono/contracts';
import { fetchCompanionGrowth } from '../../companion/companionApi';
import type { CompanionScreenProps } from './CompanionHomeScreen';

/** 探索强度 → 中文 + 配色（成长语气，非告警）。 */
const INTENSITY: Record<ExplorationIntensityV1, { label: string; bg: string; fg: string }> = {
  steady: { label: '平稳', bg: '#DCFCE7', fg: '#166534' },
  exploring: { label: '探索中', bg: '#E0F2FE', fg: '#075985' },
  leaping: { label: '跃迁', bg: '#EDE9FE', fg: '#5B21B6' },
};

const DIRECTION_LABEL: Record<ExplorationDirectionV1['direction'], string> = {
  toward: '越来越看重',
  away: '逐渐放下',
  steady: '保持',
};

export function CompanionGrowthScreen({ accountKey }: CompanionScreenProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['companion', accountKey, 'growth'],
    queryFn: fetchCompanionGrowth,
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
        <Text style={styles.muted}>读取成长数据失败，请检查网络。</Text>
      </View>
    );
  }

  if (!data.hasBaseline) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>还在认识你 🌱</Text>
        <Text style={styles.muted}>
          你的数字人需要更多相处才能看出探索方向。多聊聊、多记一些，过段时间再回来看看。
        </Text>
      </View>
    );
  }

  const overall = INTENSITY[data.overallIntensity];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.muted}>整体节奏</Text>
        <View style={[styles.badge, { backgroundColor: overall.bg }]}>
          <Text style={[styles.badgeText, { color: overall.fg }]}>{overall.label}</Text>
        </View>
      </View>

      {data.directions.length === 0 ? (
        <Text style={styles.muted}>这段时间价值观保持稳定，没有明显的探索方向。</Text>
      ) : (
        data.directions.map((d) => {
          const tone = INTENSITY[d.intensity];
          return (
            <View key={d.valueId} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.cardLabel}>{d.label || d.valueId}</Text>
                <View style={[styles.badge, { backgroundColor: tone.bg }]}>
                  <Text style={[styles.badgeText, { color: tone.fg }]}>{tone.label}</Text>
                </View>
              </View>
              <Text style={styles.direction}>{DIRECTION_LABEL[d.direction]}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${Math.round(d.magnitude * 100)}%` }]} />
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  muted: { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  direction: { fontSize: 13, color: '#64748B', marginTop: 6 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: '#E2E8F0', overflow: 'hidden', marginTop: 8 },
  barFill: { height: 6, borderRadius: 3, backgroundColor: '#6366F1' },
});
