/**
 * 附加组件 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const ADDON_QUERY_BY_CODE = 'addOn.byCode' as const;
export const ADDON_QUERY_BY_ID = 'addOn.byId' as const;
export const ADDON_QUERY_LIST_ACTIVE = 'addOn.listActive' as const;
export const ADDON_QUERY_LIST_ALL = 'addOn.listAll' as const;
export const ADDON_QUERY_CODE_EXISTS = 'addOn.codeExists' as const;

/* ── Command Kinds ── */

export const ADDON_CMD_SEED = 'addOn.seed' as const;
export const ADDON_CMD_CREATE = 'addOn.create' as const;
export const ADDON_CMD_UPDATE = 'addOn.update' as const;
export const ADDON_CMD_DEACTIVATE = 'addOn.deactivate' as const;

/* ── 行类型 ── */

export interface AddOnRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly stripe_price_id: string;
  readonly resource: string;
  readonly quota_amount: number;
  readonly is_active: number | boolean;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AddOnIdRow {
  readonly id: string;
}

/* ── 参数类型 ── */

export interface AddOnSeedParams {
  id: string;
  code: string;
  name: string;
  description: string;
  resource: string;
  quotaAmount: number;
  now: number;
}

export interface AddOnCreateParams {
  id: string;
  code: string;
  name: string;
  description: string;
  stripePriceId: string;
  resource: string;
  quotaAmount: number;
  now: number;
}

export interface AddOnUpdateParams {
  id: string;
  name?: string;
  description?: string;
  stripePriceId?: string;
  quotaAmount?: number;
  now: number;
}

export interface AddOnDeactivateParams {
  id: string;
  now: number;
}

/* ── Query 工厂 ── */

export function addonQueryByCode(code: string): Query<AddOnRow | null, string> {
  return { kind: ADDON_QUERY_BY_CODE, params: code };
}

export function addonQueryById(id: string): Query<AddOnRow | null, string> {
  return { kind: ADDON_QUERY_BY_ID, params: id };
}

export function addonQueryListActive(): Query<AddOnRow, void> {
  return { kind: ADDON_QUERY_LIST_ACTIVE, params: undefined as unknown as void };
}

export function addonQueryListAll(): Query<AddOnRow, void> {
  return { kind: ADDON_QUERY_LIST_ALL, params: undefined as unknown as void };
}

export function addonQueryCodeExists(code: string): Query<AddOnIdRow | null, string> {
  return { kind: ADDON_QUERY_CODE_EXISTS, params: code };
}

/* ── Command 工厂 ── */

export function addonCmdSeed(params: AddOnSeedParams): Command<AddOnSeedParams> {
  return { kind: ADDON_CMD_SEED, params };
}

export function addonCmdCreate(params: AddOnCreateParams): Command<AddOnCreateParams> {
  return { kind: ADDON_CMD_CREATE, params };
}

export function addonCmdUpdate(params: AddOnUpdateParams): Command<AddOnUpdateParams> {
  return { kind: ADDON_CMD_UPDATE, params };
}

export function addonCmdDeactivate(params: AddOnDeactivateParams): Command<AddOnDeactivateParams> {
  return { kind: ADDON_CMD_DEACTIVATE, params };
}
