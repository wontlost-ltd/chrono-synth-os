/**
 * 系统托盘「数字人状态」合成（ADR-0046 Phase 2.4b，TS 侧纯逻辑）。
 *
 * 把**本地**两路信号——drift alertLevel（数字人状态）+ sync 在线/离线——合成一个 tray label。
 * 这是可 vitest 的纯函数；Rust 侧 `set_tray_status` 命令拿这个 label 去更新 MenuItem 文本
 * （Rust 部分需 cargo 环境，见文件末注释 + tray.rs）。前端定期/状态变化时 invoke 推给 Rust。
 *
 * 设计取舍：离线优先——连不上时数字人状态无意义（本地 drift 可能过期），统一显示「离线」；
 * 在线时由 drift alertLevel 决定。语气是「陪伴/成长」不是「告警」（与企业版 alert 区分）。
 */

import type { RuntimeSyncStateV2 } from '@chrono/contracts';

/** drift 告警等级（与 @chrono/contracts DriftAlertLevelLike / 桥接 DriftAlertLevel 同义）。 */
export type TrayDriftLevel = 'ok' | 'warning' | 'critical';

/** tray 状态语义标识——给 Rust/测试用稳定枚举，UI 文案与图标由 label 字段承载。 */
export type TrayStatusKind = 'offline' | 'growing' | 'exploring' | 'attention';

export interface TrayStatus {
  readonly kind: TrayStatusKind;
  /** 完整菜单项文本（含状态点 emoji + 中文），直接灌进 Rust MenuItem。 */
  readonly label: string;
}

/** sync 状态里代表「离线/不可达」的集合——这些下数字人状态显示为离线。 */
const OFFLINE_SYNC_STATES: ReadonlySet<RuntimeSyncStateV2> = new Set<RuntimeSyncStateV2>([
  'offline_queueing',
  'offline_readonly',
  'degraded_remote',
  'recovery_required',
]);

const STATUS_LABEL: Record<TrayStatusKind, string> = {
  offline: '⚪ 数字人：离线',
  growing: '🟢 数字人：成长中',
  exploring: '🟡 数字人：探索活跃',
  attention: '🔴 数字人：需关注',
};

/**
 * 合成 tray 状态。
 *
 * @param driftLevel 最近一次本地 drift 报告的 alertLevel；无报告传 null（视作 ok=成长中）。
 * @param syncState  当前 sync 运行态；离线类状态优先覆盖为「离线」。
 */
export function computeTrayStatus(
  driftLevel: TrayDriftLevel | null,
  syncState: RuntimeSyncStateV2,
): TrayStatus {
  if (OFFLINE_SYNC_STATES.has(syncState)) {
    return { kind: 'offline', label: STATUS_LABEL.offline };
  }
  const kind: TrayStatusKind =
    driftLevel === 'critical' ? 'attention' : driftLevel === 'warning' ? 'exploring' : 'growing';
  return { kind, label: STATUS_LABEL[kind] };
}

/** 便捷取 label（Rust 桥接只需要字符串）。 */
export function computeTrayStatusLabel(
  driftLevel: TrayDriftLevel | null,
  syncState: RuntimeSyncStateV2,
): string {
  return computeTrayStatus(driftLevel, syncState).label;
}
