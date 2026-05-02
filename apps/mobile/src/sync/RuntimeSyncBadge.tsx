import type { RuntimeSyncStateV1 } from '@chrono/contracts';
import { chronoDesignTokens } from '@chrono/design-tokens';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  state: RuntimeSyncStateV1;
}

const LABELS: Record<RuntimeSyncStateV1, string> = {
  unconfigured: 'Unconfigured',
  disabled: 'Disabled',
  idle: 'Synced',
  pulling: 'Pulling',
  merging: 'Merging',
  pushing: 'Pushing',
  paused: 'Paused',
  offline: 'Offline',
  conflicted: 'Conflict inbox',
  error: 'Sync error',
};

export function RuntimeSyncBadge({ state }: Props) {
  const color = chronoDesignTokens.color.status[state];

  return (
    <View
      accessibilityLabel={`Sync status: ${LABELS[state]}`}
      accessibilityRole="text"
      style={[
        styles.badge,
        {
          borderColor: color,
          padding: chronoDesignTokens.space.sm,
        },
      ]}
    >
      <Text style={[styles.label, { color }]}>{LABELS[state]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: chronoDesignTokens.color.surface.default,
    borderRadius: chronoDesignTokens.radius.sm,
    borderWidth: chronoDesignTokens.borderWidth.sm,
    minHeight: chronoDesignTokens.size.touchMin,
    justifyContent: 'center',
  },
  label: {
    fontSize: chronoDesignTokens.typography.size.sm,
    fontWeight: '500',
    lineHeight: chronoDesignTokens.typography.lineHeight.sm,
  },
});
