import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { useConflictInbox } from '../sync/useConflictInbox';
import type { ConflictItem } from '../sync/useConflictInbox';

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatObjectId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

type ResolutionChoice = 'keep_local' | 'keep_remote';

interface ResolvePayload {
  choice: ResolutionChoice;
}

function ConflictCard({ item }: { item: ConflictItem }) {
  const queryClient = useQueryClient();
  const [activeAction, setActiveAction] = useState<string | null>(null);

  const resolveMutation = useMutation({
    mutationFn: (choice: ResolutionChoice) => {
      setActiveAction(choice);
      return apiFetch(`/api/v1/conflicts/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ choice } satisfies ResolvePayload),
      });
    },
    onSettled: () => {
      setActiveAction(null);
      void queryClient.invalidateQueries({ queryKey: ['conflicts', 'inbox', 'pending'] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: () => {
      setActiveAction('dismiss');
      return apiFetch(`/api/v1/conflicts/${item.id}/dismiss`, { method: 'POST' });
    },
    onSettled: () => {
      setActiveAction(null);
      void queryClient.invalidateQueries({ queryKey: ['conflicts', 'inbox', 'pending'] });
    },
  });

  const isBusy = resolveMutation.isPending || dismissMutation.isPending;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{item.objectType}</Text>
        </View>
        <Text style={styles.timestamp}>{formatRelativeTime(item.detectedAt)}</Text>
      </View>

      <Text style={styles.conflictType}>{item.conflictType}</Text>
      <Text style={styles.objectId}>{formatObjectId(item.objectId)}</Text>

      <View style={styles.versionRow}>
        <Text style={styles.versionLabel}>Local v{item.localVersion}</Text>
        <Text style={styles.versionSep}>→</Text>
        <Text style={styles.versionLabel}>Remote v{item.remoteVersion}</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.localBtn, isBusy && styles.actionBtnDisabled]}
          onPress={() => resolveMutation.mutate('keep_local')}
          disabled={isBusy}
          accessibilityLabel="Keep local version"
        >
          {activeAction === 'keep_local' ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.actionBtnText}>Keep Local</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.remoteBtn, isBusy && styles.actionBtnDisabled]}
          onPress={() => resolveMutation.mutate('keep_remote')}
          disabled={isBusy}
          accessibilityLabel="Keep remote version"
        >
          {activeAction === 'keep_remote' ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.actionBtnText}>Keep Remote</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.dismissBtn, isBusy && styles.actionBtnDisabled]}
          onPress={() => dismissMutation.mutate()}
          disabled={isBusy}
          accessibilityLabel="Dismiss conflict"
        >
          {activeAction === 'dismiss' ? (
            <ActivityIndicator size="small" color="#94A3B8" />
          ) : (
            <Text style={styles.dismissBtnText}>Dismiss</Text>
          )}
        </TouchableOpacity>
      </View>

      {(resolveMutation.isError || dismissMutation.isError) && (
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
      keyExtractor={(item) => item.id}
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
  dismissBtn: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  dismissBtnText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '500',
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
