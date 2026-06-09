/**
 * 移动端 ChronoCompanion tab 导航（ADR-0046 Phase 2.3）。
 * 个人版四个 tab：我的数字人 / 成长 / 记忆 / 设置。与企业版 TabNavigator 刻意区分。
 */

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { CompanionHomeScreen } from '../screens/companion/CompanionHomeScreen';
import { CompanionGrowthScreen } from '../screens/companion/CompanionGrowthScreen';
import { CompanionMemoriesScreen } from '../screens/companion/CompanionMemoriesScreen';
import { CompanionSettingsScreen } from '../screens/companion/CompanionSettingsScreen';
import type { AccountPlan } from '../companion/accountPlan';

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Me: '🪞',
  Growth: '🌱',
  Memories: '📔',
  Settings: '⚙️',
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label] ?? '•'}</Text>;
}

export interface CompanionTabNavigatorProps {
  readonly plan: AccountPlan;
  readonly onLogout: () => void;
  /** 账号身份键（userId:tenantId）——透传到各数据屏，纳入 queryKey 做缓存隔离。 */
  readonly accountKey: string;
}

export function CompanionTabNavigator({ plan, onLogout, accountKey }: CompanionTabNavigatorProps) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: '#4338CA' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#4338CA',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
      })}
    >
      {/* 数据屏用 render-prop 注入 accountKey（缓存隔离），而非 component=，故 queryKey 含账号维度。 */}
      <Tab.Screen name="Me" options={{ title: '我的数字人' }}>
        {() => <CompanionHomeScreen accountKey={accountKey} />}
      </Tab.Screen>
      <Tab.Screen name="Growth" options={{ title: '成长' }}>
        {() => <CompanionGrowthScreen accountKey={accountKey} />}
      </Tab.Screen>
      <Tab.Screen name="Memories" options={{ title: '记忆' }}>
        {() => <CompanionMemoriesScreen accountKey={accountKey} />}
      </Tab.Screen>
      <Tab.Screen name="Settings" options={{ title: '设置' }}>
        {() => <CompanionSettingsScreen plan={plan} onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}
