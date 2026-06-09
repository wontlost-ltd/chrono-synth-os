/**
 * 移动端 ChronoCompanion · 精简设置（ADR-0046 Phase 2.3）。
 * 展示账号类型 + 登出。个人版不需要企业版治理设置。
 */

import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { AccountPlan } from '../../companion/accountPlan';

const PLAN_LABEL: Record<AccountPlan, string> = {
  companion: '个人版（ChronoCompanion）',
  enterprise: '企业版',
  unconfigured: '未登录',
};

export interface CompanionSettingsScreenProps {
  readonly plan: AccountPlan;
  readonly onLogout: () => void;
}

export function CompanionSettingsScreen({ plan, onLogout }: CompanionSettingsScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>账号类型</Text>
        <Text style={styles.value}>{PLAN_LABEL[plan]}</Text>
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={onLogout} accessibilityRole="button">
        <Text style={styles.logoutText}>登出</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', padding: 16 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 20 },
  label: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  value: { fontSize: 16, color: '#1E293B', marginTop: 6 },
  logoutBtn: { backgroundColor: '#FEE2E2', borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#FECACA' },
  logoutText: { fontSize: 15, color: '#B91C1C', fontWeight: '600' },
});
