/**
 * Avatar 快照 Query kind 常量与参数类型（只读查询）
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const ASNAP_QUERY_AUTORUN_CONFIG = 'avatarSnapshot.autorunConfig' as const;
export const ASNAP_QUERY_DRIFT_CONFIG = 'avatarSnapshot.driftConfig' as const;
export const ASNAP_QUERY_LAST_RUN_METRICS = 'avatarSnapshot.lastRunMetrics' as const;
export const ASNAP_QUERY_INSTALLED_DEVICES = 'avatarSnapshot.installedDevices' as const;

/* ── 行类型 ── */

export interface AsnapAutorunRow {
  readonly enabled: number;
  readonly interval_ms: number;
  readonly last_run_at: number | null;
}

export interface AsnapDriftConfigRow {
  readonly drift_threshold: number;
  readonly last_drift_check_at: number | null;
  readonly review_required: number;
}

export interface AsnapLastRunRow {
  readonly metrics_json: string | null;
}

export interface AsnapDeviceIdRow {
  readonly device_id: string;
}

/* ── 参数类型 ── */

export interface AsnapTenantAvatarParams {
  tenantId: string;
  avatarId: string;
}

export interface AsnapLastRunParams {
  tenantId: string;
  avatarId: string;
  status: string;
}

/* ── Query 工厂 ── */

export function asnapQueryAutorunConfig(params: AsnapTenantAvatarParams): Query<AsnapAutorunRow | null, AsnapTenantAvatarParams> {
  return { kind: ASNAP_QUERY_AUTORUN_CONFIG, params };
}

export function asnapQueryDriftConfig(params: AsnapTenantAvatarParams): Query<AsnapDriftConfigRow | null, AsnapTenantAvatarParams> {
  return { kind: ASNAP_QUERY_DRIFT_CONFIG, params };
}

export function asnapQueryLastRunMetrics(params: AsnapLastRunParams): Query<AsnapLastRunRow | null, AsnapLastRunParams> {
  return { kind: ASNAP_QUERY_LAST_RUN_METRICS, params };
}

export function asnapQueryInstalledDevices(avatarId: string): Query<readonly AsnapDeviceIdRow[], string> {
  return { kind: ASNAP_QUERY_INSTALLED_DEVICES, params: avatarId };
}
