import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExportJobStatusV1 } from '@chrono/contracts';
import { apiFetch } from '../client';

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * 导出任务状态：直接取自权威契约（审计 Warning B6-5）。
 *
 * 此前这里手写了一份**与服务端不符**的类型：state 写成 'pending'（服务端是
 * 'queued'）、漏掉 'partial'、把 errorCode 写成 errorMessage。后果是任务处于
 * queued/partial 时前端状态机全分支落空 → 界面停在 idle，用户看不到任何进度；
 * 失败原因也永远读不到。改为 infer 契约类型，服务端一改动前端即编译报错。
 */
export type ExportJob = ExportJobStatusV1;

export function useExportJobs() {
  return useQuery({
    queryKey: ['privacy', 'export', 'jobs'],
    queryFn: ({ signal }) =>
      apiFetch<ExportJob[]>('/api/v1/privacy/export/jobs', { signal }),
  });
}

export function useExportJob(exportId: string | null) {
  return useQuery({
    queryKey: ['privacy', 'export', 'job', exportId],
    queryFn: ({ signal }) =>
      apiFetch<ExportJob>(`/api/v1/privacy/export/${exportId!}`, { signal }),
    enabled: exportId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      /* 服务端初始状态是 'queued'——写成 'pending' 时该判定恒 false，
       * 排队中的任务根本不会被轮询，界面一直停在旧数据上。 */
      return data.state === 'queued' || data.state === 'running' ? 3000 : false;
    },
  });
}

export function useStartExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ exportId: string }>('/api/v1/privacy/export/start', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['privacy', 'export', 'jobs'] });
    },
  });
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface DryRunReport {
  valid: boolean;
  entityCount: number;
  conflicts: Array<{ entityRef: string; reason: string }>;
  warnings: string[];
}

export function useDryRunImport() {
  return useMutation({
    mutationFn: (manifestJson: string) =>
      apiFetch<DryRunReport>('/api/v1/privacy/import/dry-run', {
        method: 'POST',
        body: JSON.stringify({ manifestJson }),
      }),
  });
}

export interface CommitImportResult {
  importId: string;
  importedCount: number;
  skippedCount: number;
}

export function useCommitImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { manifestJson: string; importToken: string }) =>
      apiFetch<CommitImportResult>('/api/v1/privacy/import/commit', {
        method: 'POST',
        body: JSON.stringify(opts),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['personas'] });
      void qc.invalidateQueries({ queryKey: ['memories'] });
    },
  });
}
