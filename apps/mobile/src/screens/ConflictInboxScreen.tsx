import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useConflictInbox, useResolveConflict } from '../sync/useConflictInbox';
import type { ConflictAction, ConflictItem } from '../sync/useConflictInbox';

/** 契约的 detectedAt 是 ISO 8601 字符串（带偏移），不是 epoch 毫秒。 */
function formatRelativeTime(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return '';
  const diffMin = Math.floor((Date.now() - parsed) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatObjectId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

/** 摘要以 messageId + 参数下发；移动端暂无 i18n 目录，退化为可读的键值串。 */
function formatSummary(summaryId: string, params: Record<string, unknown>): string {
  const detail = Object.entries(params)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
  return detail ? `${summaryId} (${detail})` : summaryId;
}

const ACTION_LABELS: Record<ConflictAction, string> = {
  keep_local: 'Keep Local',
  keep_server: 'Keep Server',
  duplicate: 'Keep Both',
  /* merge_manually 需要结构化编辑器（desktop 有 ManualMergeEditor），
   * 移动端尚未实现，故不在此渲染为可点按钮——见下方 filter。 */
  merge_manually: 'Merge Manually',
};

function ConflictCard({ item }: { item: ConflictItem }) {
  const [activeAction, setActiveAction] = useState<ConflictAction | null>(null);
  const resolve = useResolveConflict();

  /* 只渲染服务端为该冲突建议、且移动端能够完成的动作。
   * merge_manually 需要字段级编辑界面，移动端未实现——列出却点不动比不列更糟。 */
  const actions = item.suggestedActions.filter((a) => a !== 'merge_manually');

  const onResolve = (action: ConflictAction): void => {
    setActiveAction(action);
    resolve.mutate(
      /* ifMatch 取当前 conflictVersion：他端已解决时服务端返 409，避免覆盖。 */
      { conflictId: item.conflictId, ifMatch: item.conflictVersion, action },
      { onSettled: () => setActiveAction(null) },
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{item.entityType}</Text>
        </View>
        <Text style={styles.timestamp}>{formatRelativeTime(item.detectedAt)}</Text>
      </View>

      <Text style={styles.conflictType}>{item.severity === 'blocking' ? 'Blocking' : 'Warning'}</Text>
      <Text style={styles.objectId}>{formatObjectId(item.entityId)}</Text>

      <View style={styles.versionRow}>
        <Text style={styles.versionLabel}>
          {formatSummary(item.localSummaryId, item.localSummaryParams)}
        </Text>
        <Text style={styles.versionSep}>→</Text>
        <Text style={styles.versionLabel}>
          {formatSummary(item.serverSummaryId, item.serverSummaryParams)}
        </Text>
      </View>

      <View style={styles.actions}>
        {actions.map((action) => (
          <TouchableOpacity
            key={action}
            style={[
              styles.actionBtn,
              action === 'keep_local' ? styles.localBtn : styles.remoteBtn,
              resolve.isPending && styles.actionBtnDisabled,
            ]}
            onPress={() => onResolve(action)}
            disabled={resolve.isPending}
            accessibilityLabel={ACTION_LABELS[action]}
          >
            {activeAction === action ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.actionBtnText}>{ACTION_LABELS[action]}</Text>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {resolve.isError && (
        <Text style={styles.errorText}>Action failed — please retry</Text>
      )}
    </View>
  );
}

export function ConflictInboxScreen() {
  const { data: conflicts, isLoading, isError, refetch } = useConflictInbox();

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading conflicts…</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorHeading}>Failed to load conflicts</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => void refetch()}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!conflicts || conflicts.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>✓</Text>
        <Text style={styles.emptyHeading}>No pending conflicts</Text>
        <Text style={styles.emptySubtext}>All data is in sync</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={conflicts}
      keyExtractor={(item) => item.conflictId}
      renderItem={({ item }) => <ConflictCard item={item} />}
      contentContainerStyle={styles.list}
      style={styles.screen}
    />
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  list: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeBadge: {
    backgroundColor: '#334155',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeBadgeText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  timestamp: {
    color: '#64748B',
    fontSize: 12,
  },
  conflictType: {
    color: '#F1F5F9',
    fontSize: 15,
    fontWeight: '600',
  },
  objectId: {
    color: '#64748B',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  versionLabel: {
    color: '#94A3B8',
    fontSize: 12,
  },
  versionSep: {
    color: '#475569',
    fontSize: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 38,
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  localBtn: {
    backgroundColor: '#1d4ed8',
  },
  remoteBtn: {
    backgroundColor: '#15803d',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    marginTop: 4,
  },
  centered: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 14,
  },
  errorHeading: {
    color: '#f87171',
    fontSize: 16,
    fontWeight: '600',
  },
  retryBtn: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryBtnText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '500',
  },
  emptyIcon: {
    fontSize: 40,
    color: '#22c55e',
  },
  emptyHeading: {
    color: '#F1F5F9',
    fontSize: 18,
    fontWeight: '600',
  },
  emptySubtext: {
    color: '#64748B',
    fontSize: 14,
  },
});
