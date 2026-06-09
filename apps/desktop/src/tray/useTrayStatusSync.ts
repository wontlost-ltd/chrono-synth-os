/**
 * 把本地数字人状态同步到系统托盘（ADR-0046 Phase 2.4b）。
 *
 * 合成逻辑在纯函数 computeTrayStatusLabel（drift alertLevel + sync 在线/离线）；本 hook 只负责
 * 「取本地信号 → 算 label → label 变化时 push 给 Rust」。挂在 App 顶层即可（companion / 企业版都适用）。
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLatestDriftReport, getSyncState, pushTrayStatus } from '@/bridge/tauri-commands';
import { computeTrayStatusLabel, type TrayDriftLevel } from './tray-status';

export function useTrayStatusSync(): void {
  /* drift 变化慢，60s 轮询足够；sync 状态用既有 2s 频率（与 useSyncState 一致，靠 query 缓存复用）。 */
  const drift = useQuery({
    queryKey: ['driftReport', 'latest'],
    queryFn: getLatestDriftReport,
    refetchInterval: 60_000,
  });
  const sync = useQuery({
    queryKey: ['syncState'],
    queryFn: getSyncState,
    refetchInterval: 2_000,
    staleTime: 1_000,
  });

  /* 记住上次 push 的 label，仅在变化时再 invoke，避免每个轮询周期都打 Rust。 */
  const lastLabel = useRef<string | null>(null);

  const driftLevel: TrayDriftLevel | null = drift.data?.alertLevel ?? null;
  const syncState = sync.data?.state;

  useEffect(() => {
    if (!syncState) return; // sync 状态未知前不推（避免误显示）
    const label = computeTrayStatusLabel(driftLevel, syncState);
    if (label === lastLabel.current) return;
    lastLabel.current = label;
    void pushTrayStatus(label);
  }, [driftLevel, syncState]);
}
