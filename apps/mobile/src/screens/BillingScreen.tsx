/**
 * 移动端计费屏幕
 */

import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';

interface UsageData {
  planId: string;
  status: string;
  limits: { maxSimulations: number; maxPaths: number; llmTokensPerMonth: number };
  usage: Record<string, number>;
}

export function BillingScreen() {
  const { data, isLoading } = useQuery({
    queryKey: ['billing', 'usage'],
    queryFn: () => apiFetch<UsageData>('/api/v1/billing/usage'),
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.planCard}>
        <Text style={styles.planLabel}>Current Plan</Text>
        <Text style={styles.planName}>{data?.planId ?? 'Free'}</Text>
        <Text style={styles.statusText}>Status: {data?.status ?? 'active'}</Text>
      </View>

      <Text style={styles.sectionTitle}>Usage</Text>
      <UsageMeter label="Simulations" used={data?.usage?.['simulation'] ?? 0} limit={data?.limits?.maxSimulations ?? 0} />
      <UsageMeter label="Paths" used={data?.usage?.['paths'] ?? 0} limit={data?.limits?.maxPaths ?? 0} />
      <UsageMeter label="LLM Tokens" used={data?.usage?.['llm_tokens'] ?? 0} limit={data?.limits?.llmTokensPerMonth ?? 0} />
    </ScrollView>
  );
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const isUnlimited = limit === -1;
  const pct = !isUnlimited && limit > 0 ? Math.min(used / limit, 1) : 0;

  return (
    <View style={styles.meterContainer}>
      <Text style={styles.meterLabel}>{label}</Text>
      <Text style={styles.meterValue}>
        {used.toLocaleString()} / {isUnlimited ? 'Unlimited' : limit.toLocaleString()}
      </Text>
      {!isUnlimited && limit > 0 && (
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${Math.min(pct * 100, 100)}%` }, pct > 0.9 && styles.meterWarning]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 16, color: '#64748B' },
  planCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E2E8F0' },
  planLabel: { fontSize: 14, color: '#64748B' },
  planName: { fontSize: 24, fontWeight: 'bold', color: '#1E3A8A', marginTop: 4 },
  statusText: { fontSize: 13, color: '#64748B', marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#334155' },
  meterContainer: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  meterLabel: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  meterValue: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginTop: 4 },
  meterTrack: { height: 6, backgroundColor: '#E2E8F0', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  meterFill: { height: '100%', backgroundColor: '#1E3A8A', borderRadius: 3 },
  meterWarning: { backgroundColor: '#B91C1C' },
});
