import { useState, useCallback } from 'react';
import {
  useStartExport,
  useExportJob,
  useDryRunImport,
  useCommitImport,
  type DryRunReport,
  type CommitImportResult,
  type ExportJob,
} from '../api/queries/portability';

// ── Export state machine ──────────────────────────────────────────────────────

/**
 * 'partial' 单列一相：契约的 partial 表示「导出完成但有部分数据缺失」——
 * 归入 ready 会让用户以为拿到了完整数据，归入 error 又会掩盖已可下载的部分。
 */
export type ExportPhase = 'idle' | 'starting' | 'polling' | 'ready' | 'partial' | 'error';

export interface ExportState {
  phase: ExportPhase;
  exportId: string | null;
  downloadUrl: string | null;
  errorMessage: string | null;
  /** 服务端下发的告警（partial 时说明缺了什么）。messageId 需经 i18n 目录渲染。 */
  warnings: ExportJob['warnings'];
}

export function useExportFlow() {
  const [exportId, setExportId] = useState<string | null>(null);
  const startMutation = useStartExport();
  const jobQuery = useExportJob(exportId);

  const start = useCallback(async () => {
    const result = await startMutation.mutateAsync();
    setExportId(result.exportId);
  }, [startMutation]);

  const reset = useCallback(() => {
    setExportId(null);
    startMutation.reset();
  }, [startMutation]);

  const job = jobQuery.data;
  let phase: ExportPhase = 'idle';
  if (startMutation.isPending) phase = 'starting';
  /* 服务端的初始状态是 'queued'（此前前端写的 'pending' 根本不存在，
   * 导致排队中的任务落不进任何分支，界面停在 idle）。 */
  else if (exportId && (!job || job.state === 'queued' || job.state === 'running')) phase = 'polling';
  else if (job?.state === 'completed') phase = 'ready';
  else if (job?.state === 'partial') phase = 'partial';
  else if (startMutation.isError || job?.state === 'failed') phase = 'error';

  const state: ExportState = {
    phase,
    exportId,
    downloadUrl: job?.downloadUrl ?? null,
    /* 契约字段是 errorCode（此前读的 errorMessage 恒为 undefined，失败原因永远丢失）。 */
    errorMessage: startMutation.error?.message ?? job?.errorCode ?? null,
    warnings: job?.warnings ?? [],
  };

  return { state, start, reset };
}

// ── Import state machine ──────────────────────────────────────────────────────

export type ImportPhase =
  | 'idle'
  | 'validating'
  | 'review'
  | 'committing'
  | 'done'
  | 'error';

export interface ImportState {
  phase: ImportPhase;
  report: DryRunReport | null;
  result: CommitImportResult | null;
  errorMessage: string | null;
}

export function useImportFlow() {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [result, setResult] = useState<CommitImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<string | null>(null);

  const dryRun = useDryRunImport();
  const commit = useCommitImport();

  const validate = useCallback(async (manifestJson: string) => {
    setPhase('validating');
    setErrorMessage(null);
    try {
      const r = await dryRun.mutateAsync(manifestJson);
      setReport(r);
      setPendingManifest(manifestJson);
      setPhase('review');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Validation failed');
      setPhase('error');
    }
  }, [dryRun]);

  const confirmCommit = useCallback(async (importToken: string) => {
    if (!pendingManifest) return;
    setPhase('committing');
    setErrorMessage(null);
    try {
      const r = await commit.mutateAsync({ manifestJson: pendingManifest, importToken });
      setResult(r);
      setPhase('done');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Import failed');
      setPhase('error');
    }
  }, [commit, pendingManifest]);

  const reset = useCallback(() => {
    setPhase('idle');
    setReport(null);
    setResult(null);
    setErrorMessage(null);
    setPendingManifest(null);
    dryRun.reset();
    commit.reset();
  }, [dryRun, commit]);

  const state: ImportState = { phase, report, result, errorMessage };
  return { state, validate, confirmCommit, reset };
}
