/**
 * 设备-分身绑定 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const DAVT_QUERY_ACTIVE = 'deviceAvatar.active' as const;
export const DAVT_QUERY_LIST_BY_DEVICE = 'deviceAvatar.listByDevice' as const;
export const DAVT_QUERY_IS_INSTALLED = 'deviceAvatar.isInstalled' as const;

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
