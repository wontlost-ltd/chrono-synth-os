/**
 * 移动设备 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const MDEV_QUERY_BY_UID = 'mobileDevice.byUid' as const;
export const MDEV_QUERY_LIST_BY_USER = 'mobileDevice.listByUser' as const;
export const MDEV_QUERY_OWNED = 'mobileDevice.owned' as const;

/* ── Command Kinds ── */

export const MDEV_CMD_CREATE = 'mobileDevice.create' as const;
export const MDEV_CMD_UPDATE_ON_REGISTER = 'mobileDevice.updateOnRegister' as const;
export const MDEV_CMD_UPDATE_PUSH_TOKEN = 'mobileDevice.updatePushToken' as const;
export const MDEV_CMD_DELETE = 'mobileDevice.delete' as const;

/* ── 行类型 ── */

export interface MdevDeviceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly device_uid: string;
  readonly platform: string;
  readonly push_token: string | null;
  readonly app_version: string | null;
  readonly last_seen_at: number;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface MdevByUidParams {
  tenantId: string;
  userId: string;
  deviceUid: string;
}

export interface MdevOwnedParams {
  deviceId: string;
  userId: string;
}

export interface MdevCreateParams {
  id: string;
  tenantId: string;
  userId: string;
  deviceUid: string;
  platform: string;
  pushToken: string | null;
  appVersion: string | null;
  now: number;
}

export interface MdevUpdateOnRegisterParams {
  deviceId: string;
  platform: string;
  pushToken: string | null;
  appVersion: string | null;
  now: number;
}

export interface MdevUpdatePushTokenParams {
  deviceId: string;
  pushToken: string;
  now: number;
}

/* ── Query 工厂 ── */

export function mdevQueryByUid(params: MdevByUidParams): Query<MdevDeviceRow | null, MdevByUidParams> {
  return { kind: MDEV_QUERY_BY_UID, params };
}

export function mdevQueryListByUser(userId: string): Query<MdevDeviceRow, string> {
  return { kind: MDEV_QUERY_LIST_BY_USER, params: userId };
}

export function mdevQueryOwned(params: MdevOwnedParams): Query<MdevDeviceRow | null, MdevOwnedParams> {
  return { kind: MDEV_QUERY_OWNED, params };
}

/* ── Command 工厂 ── */

export function mdevCmdCreate(params: MdevCreateParams): Command<MdevCreateParams> {
  return { kind: MDEV_CMD_CREATE, params };
}

export function mdevCmdUpdateOnRegister(params: MdevUpdateOnRegisterParams): Command<MdevUpdateOnRegisterParams> {
  return { kind: MDEV_CMD_UPDATE_ON_REGISTER, params };
}

export function mdevCmdUpdatePushToken(params: MdevUpdatePushTokenParams): Command<MdevUpdatePushTokenParams> {
  return { kind: MDEV_CMD_UPDATE_PUSH_TOKEN, params };
}

export function mdevCmdDelete(deviceId: string): Command<string> {
  return { kind: MDEV_CMD_DELETE, params: deviceId };
}
