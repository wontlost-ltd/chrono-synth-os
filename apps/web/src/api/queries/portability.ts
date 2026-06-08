import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

// ── Export ────────────────────────────────────────────────────────────────────

export interface ExportJob {
  exportId: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  downloadUrl?: string;
  errorMessage?: string;
}

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
      return data.state === 'pending' || data.state === 'running' ? 3000 : false;
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
