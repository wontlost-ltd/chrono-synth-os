/**
 * 冲突收件箱数据层（对齐 @chrono/contracts 权威契约）。
 *
 * 背景（审计 Warning B6-1）：此前本模块自定义了一套与服务端**完全不同**的形状
 * （id/objectType/detectedAt:number），并请求了根本不存在的 `/conflicts/inbox`
 * 与 `/conflicts/:id/dismiss` 端点，解决请求体也用了服务端不接受的 `{choice}`。
 * 结果是移动端冲突收件箱整体不可用：列表恒空、解决必失败。
 *
 * 现与 desktop 的 conflict-api 同款：只用契约 schema，并在 HTTP 边界 parse——
 * 服务端形状一旦漂移就在边界立即报错，而不是在渲染层显示一堆 undefined。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ConflictInboxItemV1Schema,
  ConflictResolveRequestV1Schema,
  ConflictResolveResultV1Schema,
  type ConflictInboxItemV1,
  type ConflictResolveResultV1,
} from '@chrono/contracts';
import { z } from 'zod';
import { apiFetch } from '../api/client';

/** 列表端点返回分页信封 `{data, pagination}`——只取 data。 */
const ConflictsListEnvelopeSchema = z.object({
  data: z.array(ConflictInboxItemV1Schema),
});

const ConflictResolveEnvelopeSchema = z.object({
  data: ConflictResolveResultV1Schema,
});

export type ConflictItem = ConflictInboxItemV1;
/** 契约允许的解决动作。 */
export type ConflictAction = ConflictInboxItemV1['suggestedActions'][number];

const INBOX_QUERY_KEY = ['conflicts', 'inbox'] as const;

export function useConflictInbox(enabled = true) {
  return useQuery({
    queryKey: INBOX_QUERY_KEY,
    /* 正确路径是 `/api/v1/conflicts`（无 /inbox 子路径），返回分页信封。 */
    queryFn: async (): Promise<ConflictItem[]> => {
      const raw = await apiFetch<unknown>('/api/v1/conflicts');
      return ConflictsListEnvelopeSchema.parse(raw).data;
    },
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });
}

export interface ResolveConflictInput {
  conflictId: string;
  /** 乐观并发令牌，取自列表项的 conflictVersion；服务端不匹配返 409。 */
  ifMatch: string;
  action: ConflictAction;
  mergePayload?: Record<string, unknown>;
}

/**
 * 解决冲突。请求体在发出前经契约 schema 校验（例如 merge_manually 必须带
 * mergePayload），避免把明显非法的载荷送上网络再由服务端拒绝。
 */
export function useResolveConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResolveConflictInput): Promise<ConflictResolveResultV1> => {
      const body = ConflictResolveRequestV1Schema.parse(input);
      const raw = await apiFetch<unknown>(
        `/api/v1/conflicts/${encodeURIComponent(input.conflictId)}/resolve`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      /* 响应侧同样要 parse：`as` 只是编译期断言，服务端形状漂移时会把
       * undefined 一路带进 UI。ConflictResolveEnvelopeSchema 已在上方定义。 */
      return ConflictResolveEnvelopeSchema.parse(raw).data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
    },
  });
}
