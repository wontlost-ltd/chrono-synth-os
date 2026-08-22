import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, unwrapList } from '../client';

export type KnowledgeSourceType = 'rss' | 'api' | 'file' | 'manual' | 'llm';

export interface KnowledgeSource {
  id: string;
  type: KnowledgeSourceType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastSyncAt?: string;
  itemCount?: number;
  status?: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateKnowledgeSourceDto {
  type: KnowledgeSourceType;
  name: string;
  config: Record<string, unknown>;
}

interface UpdateKnowledgeSourceDto {
  name?: string;
  type?: KnowledgeSourceType;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export function useKnowledgeSources() {
  return useQuery({
    queryKey: ['knowledge-sources'],
    /* ⚠️ 审计 P3：服务端返回分页信封 {data,pagination}，而 apiFetch **只对单键
     * {data} 自动解包**（多键要保留 pagination）。此前直接标注成 KnowledgeSource[]
     * 是编译期谎言（apiFetch<T> 无校验强转），运行时拿到的是对象：
     *   - KnowledgeSourceListPage → DataTable 判 `!rows.length` → undefined 为假
     *     → **有数据也渲染「暂无来源」空状态**
     *   - AutorunConfigPage 的来源选择器**永不渲染**，用户无法挂载来源
     *   - useContextualSuggestions 的「添加第一个来源」提示**永远显示**
     *   - useSetupProgress 的引导清单**永远到不了 100%**
     * 四处全部静默，无报错无告警。用 unwrapList 修（与 values/personas/conflicts 同款）。 */
    queryFn: ({ signal }) => apiFetch<unknown>('/api/v1/knowledge-sources', { signal })
      .then(unwrapList<KnowledgeSource>),
  });
}

export function useKnowledgeSource(id: string) {
  return useQuery({
    queryKey: ['knowledge-sources', id],
    queryFn: ({ signal }) => apiFetch<KnowledgeSource>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { signal }),
    enabled: !!id,
  });
}

export function useCreateKnowledgeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateKnowledgeSourceDto) =>
      apiFetch<KnowledgeSource>('/api/v1/knowledge-sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources'] }); },
  });
}

export function useUpdateKnowledgeSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateKnowledgeSourceDto) =>
      apiFetch<KnowledgeSource>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge-sources'] });
      qc.invalidateQueries({ queryKey: ['knowledge-sources', id] });
    },
  });
}

export function useDeleteKnowledgeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources'] }); },
  });
}

export function useSyncKnowledgeSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/knowledge-sources/${id}/sync`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources', id] }); },
  });
}
