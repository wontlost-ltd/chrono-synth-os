import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { BillingScreen } from '../screens/BillingScreen';
import { ConflictInboxScreen } from '../screens/ConflictInboxScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { SimulationWizardScreen } from '../screens/SimulationWizardScreen';

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Dashboard: '📊',
  Simulate: '🔮',
  Billing: '💳',
  Conflicts: '⚠️',
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label] ?? '•'}</Text>;
}

interface TabNavigatorProps {
  conflictCount: number;
}

export function TabNavigator({ conflictCount }: TabNavigatorProps) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: '#1E3A8A' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#1E3A8A',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Dashboard' }} />
      <Tab.Screen name="Simulate" component={SimulationWizardScreen} options={{ title: 'New Simulation' }} />
      <Tab.Screen name="Billing" component={BillingScreen} options={{ title: 'Billing' }} />
      <Tab.Screen
        name="Conflicts"
        component={ConflictInboxScreen}
        options={{
          title: 'Conflicts',
          tabBarBadge: conflictCount > 0 ? conflictCount : undefined,
          tabBarBadgeStyle: { backgroundColor: '#ef4444' },
        }}
      />
    </Tab.Navigator>
  );
}
