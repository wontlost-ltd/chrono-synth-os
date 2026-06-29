import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, unwrapList } from '../client';
import type { CoreValue } from '../../types';

export function useValues() {
  return useQuery({
    queryKey: ['values'],
    /* /api/v1/values 返回分页信封 {data,pagination}，apiFetch 不自动解包（保留 pagination）。
     * 用 unwrapList 取出数组，否则消费方 values.length 恒 undefined→有数据也静默显示「空」。 */
    queryFn: ({ signal }) => apiFetch<unknown>('/api/v1/values', { signal }).then(unwrapList<CoreValue>),
  });
}

export function useCreateValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label: string; weight: number }) =>
      apiFetch<CoreValue>('/api/v1/values', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['values'] }); },
  });
}
