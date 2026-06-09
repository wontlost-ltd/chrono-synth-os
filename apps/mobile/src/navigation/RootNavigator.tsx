/**
 * 移动端根导航切换（ADR-0046 Phase 2.3）：按账号 plan 选企业版 / ChronoCompanion。
 *
 * 在线探测 plan（resolveAccountPlan）：companion → CompanionTabNavigator；其余（enterprise /
 * unconfigured / 探测中）→ 现有企业版 TabNavigator（默认，保持今日行为）。
 */

import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { TabNavigator } from './TabNavigator';
import { CompanionTabNavigator } from './CompanionTabNavigator';
import { resolveAccountPlan, type AccountPlan } from '../companion/accountPlan';

export interface RootNavigatorProps {
  /** 企业版 Conflicts tab 的角标数量（来自 sync 状态）。 */
  readonly conflictCount: number;
  /** 登出回调（companion 设置页用）。 */
  readonly onLogout: () => void;
  /** 会话变化的依赖键（如 access token / 登录态）——变化时重新探测 plan。 */
  readonly sessionKey?: string | number | boolean | null;
}

type PlanGate = 'resolving' | AccountPlan;

export function RootNavigator({ conflictCount, onLogout, sessionKey }: RootNavigatorProps) {
  const [gate, setGate] = useState<PlanGate>('resolving');

  useEffect(() => {
    let cancelled = false;
    setGate('resolving');
    void (async () => {
      let plan: AccountPlan;
      try {
        plan = await resolveAccountPlan();
      } catch {
        plan = 'unconfigured'; // 探测异常不阻断：降级企业版默认
      }
      if (!cancelled) setGate(plan);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  if (gate === 'resolving') {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>正在加载你的账号…</Text>
      </View>
    );
  }

  /* 用 sessionKey 作 React key：账号切换时强制重挂导航子树，丢弃上一账号的组件内状态，
   * 与 App 层清 companion 缓存形成双保险（Codex 隐私 Major）。 */
  const treeKey = String(sessionKey ?? 'anon');

  if (gate === 'companion') {
    /* companion 态必然已登录，treeKey 即账号身份键（userId:tenantId）；透传给各屏纳入 queryKey。
     * key + accountKey 双重隔离：换账号既重挂子树，新屏的 queryKey 也不同，缓存按构造隔离（无时序窗口）。 */
    return (
      <CompanionTabNavigator
        key={treeKey}
        plan="companion"
        onLogout={onLogout}
        accountKey={treeKey}
      />
    );
  }

  /* enterprise / unconfigured → 企业版（本地优先默认，与今日行为一致）。 */
  return <TabNavigator key={treeKey} conflictCount={conflictCount} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' },
  muted: { fontSize: 14, color: '#64748B' },
});
