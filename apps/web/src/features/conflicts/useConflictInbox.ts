import { useCallback, useEffect, useState } from 'react';
import {
  ConflictInboxItemV1Schema,
  type ConflictInboxItemV1,
  type ConflictResolveRequestV1,
  type ConflictResolveResultV1,
} from '@chrono/contracts';
import { apiFetch, ApiError } from '@/api/client';
import { useSyncEngine } from '@/sync/use-sync-engine';

/**
 * GA §8 #1: 把 /api/v1/conflicts 的响应在边界处做一次 Zod runtime 解析。
 * 仅依赖 TypeScript 类型会让 OS 端 schema 漂移、错误响应或被中间代理改写
 * 的 payload 无声进入 UI 缓存，最终在 ResolutionPanel 渲染时炸成空白。
 * 这里失败时抛出明确的 invariant，让 useConflictInbox 走 load 错误路径，
 * UI 渲染兜底的"无法加载冲突列表"卡片而不是 corrupt 状态。
 * 用 Schema.array() 而不是直接 import z 以避免在 web 包额外声明 zod 依赖。
 */
const ConflictInboxResponseSchema = ConflictInboxItemV1Schema.array();

export type ConflictAction = ConflictResolveRequestV1['action'];

/**
 * 错误描述 — 区分加载失败与解决失败，使页面能各自渲染合适的恢复入口。
 * `code` 来自后端 ApiError，UI 据此选 i18n 文案（不依赖易漂移的 message）。
 */
export interface ConflictError {
  scope: 'load' | 'resolve';
  status: number;
  code: string | null;
  messageId: string | null;
  message: string;
}

function toConflictError(scope: ConflictError['scope'], err: unknown): ConflictError {
  if (err instanceof ApiError) {
    return { scope, status: err.status, code: err.code, messageId: err.messageId, message: err.message };
  }
  return {
    scope,
    status: 0,
    code: null,
    messageId: null,
    message: err instanceof Error ? err.message : String(err),
  };
}

export function useConflictInbox(): {
  conflicts: ConflictInboxItemV1[];
  loading: boolean;
  resolving: string | null;
  error: ConflictError | null;
  resolve(conflictId: string, conflictVersion: string, action: ConflictAction): Promise<void>;
  refresh(): void;
} {
  const [conflicts, setConflicts] = useState<ConflictInboxItemV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<ConflictError | null>(null);
  const syncEngine = useSyncEngine({ enabled: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await apiFetch<unknown>('/api/v1/conflicts');
      const parsed = ConflictInboxResponseSchema.safeParse(raw);
      if (!parsed.success) {
        /* schema 漂移 → 把 zod 错误压成一条 ConflictError，UI 走 load 失败兜底。
         * 不把 raw payload 留在 state 中，避免 ResolutionPanel 拿到不完整字段。 */
        throw new Error(`conflict inbox schema mismatch: ${parsed.error.message}`);
      }
      setConflicts(parsed.data);
    } catch (err) {
      setError(toConflictError('load', err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const resolve = useCallback(async (
    conflictId: string,
    conflictVersion: string,
    action: ConflictAction,
  ) => {
    setResolving(conflictId);
    setError(null);
    try {
      await apiFetch<ConflictResolveResultV1>(`/api/v1/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          conflictId,
          ifMatch: conflictVersion,
          action,
        } satisfies ConflictResolveRequestV1),
      });
      setConflicts((current) => current.filter((item) => item.conflictId !== conflictId));
      syncEngine.triggerSync();
    } catch (err) {
      const next = toConflictError('resolve', err);
      setError(next);
      /* 412/409 通常表示对端被其他客户端先一步解决 — 自动 refresh 刷新本地视图 */
      if (next.status === 412 || next.status === 409) {
        void load();
      }
    } finally {
      setResolving(null);
    }
  }, [syncEngine, load]);

  return { conflicts, loading, resolving, error, resolve, refresh };
}
