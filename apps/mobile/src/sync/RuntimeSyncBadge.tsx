import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { RuntimeSyncStateV2 } from '@chrono/contracts';

const SYNC_STATE_COLORS: Record<RuntimeSyncStateV2, string> = {
  initial_sync: '#3b82f6',
  online_synced: '#22c55e',
  online_dirty: '#eab308',
  syncing: '#3b82f6',
  offline_queueing: '#f97316',
  offline_readonly: '#6b7280',
  conflict_inbox: '#ef4444',
  degraded_remote: '#f97316',
  reauth_required: '#dc2626',
  recovery_required: '#dc2626',
};

const SYNC_STATE_LABELS: Record<RuntimeSyncStateV2, string> = {
  initial_sync: 'Initial sync',
  online_synced: 'Synced',
  online_dirty: 'Changes pending',
  syncing: 'Syncing',
  offline_queueing: 'Offline',
  offline_readonly: 'Read-only',
  conflict_inbox: 'Conflicts',
  degraded_remote: 'Degraded',
  reauth_required: 'Sign-in required',
  recovery_required: 'Recovery required',
};

interface Props {
  state: RuntimeSyncStateV2;
}

export function RuntimeSyncBadge({ state }: Props) {
  const pulse = useRef(new Animated.Value(0)).current;
  const color = SYNC_STATE_COLORS[state];
  const label = SYNC_STATE_LABELS[state];
  const isPulsing = state === 'syncing' || state === 'initial_sync';

  useEffect(() => {
    if (!isPulsing) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isPulsing, pulse]);

  const dotAnimStyle = isPulsing
    ? {
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
        transform: [
          { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.2] }) },
        ],
      }
    : undefined;

  return (
    <View
      accessibilityLabel={`Sync status: ${label}`}
      accessibilityRole="text"
      style={[styles.badge, { borderColor: color }]}
    >
      <Animated.View style={[styles.dot, { backgroundColor: color }, dotAnimStyle]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#1E293B',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
});
