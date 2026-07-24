/**
 * 设备-分身绑定 Query/Command kind 常量与参数类型
 *
 * 分片 Phase 0 · Plan 1b（Task 2 Avatar 组）：
 * device_avatars **无 tenant_id 列**（只 device_id/avatar_id）→ link 两端归属须分别经父表验：
 * - device 端：`devices.tenant_id`（devices 有 tenant_id 列）；
 * - avatar 端：`avatars.identity_id → identities.tenant_id`（avatars 无 tenant_id，经 identity 父归属）。
 * 服务层在 install/activate/uninstall/list 前先跑两端 belongs 探针（防跨租户 link）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const DAVT_QUERY_ACTIVE = 'deviceAvatar.active' as const;
export const DAVT_QUERY_LIST_BY_DEVICE = 'deviceAvatar.listByDevice' as const;
export const DAVT_QUERY_IS_INSTALLED = 'deviceAvatar.isInstalled' as const;
/** device 端归属探针：device 是否属于该租户（devices.tenant_id）。 */
export const DAVT_QUERY_DEVICE_BELONGS_TO_TENANT = 'deviceAvatar.deviceBelongsToTenant' as const;
/** avatar 端归属探针：avatar 经 identity 父归属是否属于该租户。 */
export const DAVT_QUERY_AVATAR_BELONGS_TO_TENANT = 'deviceAvatar.avatarBelongsToTenant' as const;

/* ── Command Kinds ── */

export const DAVT_CMD_INSTALL = 'deviceAvatar.install' as const;
export const DAVT_CMD_UNINSTALL = 'deviceAvatar.uninstall' as const;
export const DAVT_CMD_DEACTIVATE_ALL = 'deviceAvatar.deactivateAll' as const;
export const DAVT_CMD_ACTIVATE = 'deviceAvatar.activate' as const;

/* ── 行类型 ── */

export interface DavtRow {
  readonly id: string;
  readonly device_id: string;
  readonly avatar_id: string;
  readonly is_active: number;
  readonly installed_at: number;
}

export interface DavtInstalledRow {
  readonly id: string;
}

/* ── 参数类型 ── */

export interface DavtDeviceAvatarParams {
  deviceId: string;
  avatarId: string;
}

export interface DavtInstallParams {
  id: string;
  deviceId: string;
  avatarId: string;
  now: number;
}

/* ── tenant 归属探针参数（两端验，Plan 1b Task 2）── */

export interface DavtDeviceBelongsToTenantParams {
  tenantId: string;
  deviceId: string;
}

export interface DavtAvatarBelongsToTenantParams {
  tenantId: string;
  avatarId: string;
}

/* ── Query 工厂 ── */

export function davtQueryActive(deviceId: string): Query<DavtRow | null, string> {
  return { kind: DAVT_QUERY_ACTIVE, params: deviceId };
}

export function davtQueryListByDevice(deviceId: string): Query<DavtRow, string> {
  return { kind: DAVT_QUERY_LIST_BY_DEVICE, params: deviceId };
}

export function davtQueryIsInstalled(params: DavtDeviceAvatarParams): Query<DavtInstalledRow | null, DavtDeviceAvatarParams> {
  return { kind: DAVT_QUERY_IS_INSTALLED, params };
}

export function davtQueryDeviceBelongsToTenant(tenantId: string, deviceId: string): Query<{ id: string } | null, DavtDeviceBelongsToTenantParams> {
  return { kind: DAVT_QUERY_DEVICE_BELONGS_TO_TENANT, params: { tenantId, deviceId } };
}

export function davtQueryAvatarBelongsToTenant(tenantId: string, avatarId: string): Query<{ id: string } | null, DavtAvatarBelongsToTenantParams> {
  return { kind: DAVT_QUERY_AVATAR_BELONGS_TO_TENANT, params: { tenantId, avatarId } };
}

/* ── Command 工厂 ── */

export function davtCmdInstall(params: DavtInstallParams): Command<DavtInstallParams> {
  return { kind: DAVT_CMD_INSTALL, params };
}

export function davtCmdUninstall(params: DavtDeviceAvatarParams): Command<DavtDeviceAvatarParams> {
  return { kind: DAVT_CMD_UNINSTALL, params };
}

export function davtCmdDeactivateAll(deviceId: string): Command<string> {
  return { kind: DAVT_CMD_DEACTIVATE_ALL, params: deviceId };
}

export function davtCmdActivate(params: DavtDeviceAvatarParams): Command<DavtDeviceAvatarParams> {
  return { kind: DAVT_CMD_ACTIVATE, params };
}
