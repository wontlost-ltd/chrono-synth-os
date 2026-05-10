/**
 * 移动设备 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const MDEV_QUERY_BY_UID = 'mobileDevice.byUid' as const;
export const MDEV_QUERY_BY_ID = 'mobileDevice.byId' as const;
export const MDEV_QUERY_LIST_BY_USER = 'mobileDevice.listByUser' as const;
export const MDEV_QUERY_OWNED = 'mobileDevice.owned' as const;

/* ── Command Kinds ── */

export const MDEV_CMD_CREATE = 'mobileDevice.create' as const;
export const MDEV_CMD_UPDATE_ON_REGISTER = 'mobileDevice.updateOnRegister' as const;
export const MDEV_CMD_UPDATE_PUSH_TOKEN = 'mobileDevice.updatePushToken' as const;
export const MDEV_CMD_MARK_TOKEN_INVALID = 'mobileDevice.markTokenInvalid' as const;
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
  /** EP-3.5: epoch-ms 时间戳，由 PushDispatcher 在收到 BadDeviceToken /
   *  UNREGISTERED 时写入。dispatcher 的 deviceLookup 看到这个字段后短路返回
   *  tokenInvalid:true，避免再次重试这个 token。null 表示未失效。 */
  readonly is_invalid_at: number | null;
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

/** EP-3.5: mark this device's push token as platform-invalidated. */
export interface MdevMarkTokenInvalidParams {
  deviceId: string;
  /** epoch-ms; same value as the timestamp logged into the audit trail */
  now: number;
  /** Optional human-readable reason from the provider — stored is left
   *  to the executor (current schema has no column for it; we keep the
   *  reason in the audit log instead). */
  reason?: string | undefined;
}

/* ── Query 工厂 ── */

export function mdevQueryByUid(params: MdevByUidParams): Query<MdevDeviceRow | null, MdevByUidParams> {
  return { kind: MDEV_QUERY_BY_UID, params };
}

/**
 * 按主键查询，不带 user 校验。EP-3.5 dispatcher 用这个：dispatcher 从
 * autorun / drift 事件里只拿到 deviceId，没有 user 上下文；安全性靠
 * "deviceId 已经是不可猜的随机串 + 推送内容只在该设备上展示"来保证。
 */
export function mdevQueryById(deviceId: string): Query<MdevDeviceRow | null, string> {
  return { kind: MDEV_QUERY_BY_ID, params: deviceId };
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

export function mdevCmdMarkTokenInvalid(params: MdevMarkTokenInvalidParams): Command<MdevMarkTokenInvalidParams> {
  return { kind: MDEV_CMD_MARK_TOKEN_INVALID, params };
}

export function mdevCmdDelete(deviceId: string): Command<string> {
  return { kind: MDEV_CMD_DELETE, params: deviceId };
}
