/**
 * 移动端仪表盘屏幕
 */

import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';

interface OverviewData {
  simulationId: string;
  recommendedPathId: string;
  paths: Array<{ pathId: string; label?: string; compositeScore: number; regretProbability: number }>;
  meta: { horizonYears: number };
}

export function DashboardScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview'],
    queryFn: () => apiFetch<OverviewData>('/api/v1/visualization/overview'),
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Create your first simulation to get started</Text>
      </View>
    );
  }

  const recommended = data.paths.find(p => p.pathId === data.recommendedPathId);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {recommended && (
        <View style={styles.recommendedCard}>
          <Text style={styles.recommendedLabel}>Recommended Path</Text>
          <Text style={styles.recommendedTitle}>{recommended.label ?? recommended.pathId}</Text>
          <Text style={styles.scoreText}>{recommended.compositeScore.toFixed(3)}</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>All Paths</Text>
      {data.paths.map(p => (
        <View key={p.pathId} style={styles.pathCard}>
          <Text style={styles.pathName}>{p.label ?? p.pathId}</Text>
          <Text style={styles.pathScore}>Score: {p.compositeScore.toFixed(3)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { fontSize: 16, color: '#64748B' },
  emptyText: { fontSize: 16, color: '#64748B', textAlign: 'center' },
  recommendedCard: { backgroundColor: '#EFF6FF', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#BFDBFE' },
  recommendedLabel: { fontSize: 12, color: '#1E3A8A', fontWeight: '600' },
  recommendedTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 4 },
  scoreText: { fontSize: 24, fontWeight: 'bold', marginTop: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#334155' },
  pathCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  pathName: { fontSize: 14, fontWeight: '600', color: '#1E293B' },
  pathScore: { fontSize: 13, color: '#64748B', marginTop: 4 },
});
