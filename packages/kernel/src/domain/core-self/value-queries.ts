/**
 * 价值维度 Query/Command 规范
 * 定义 kind 常量和类型安全的工厂函数，SQL 实现留在宿主层
 */

import type { Query, Command } from '../../ports/query.js';
import type { CoreValue, CoreValuePatch, ValueId } from './value-types.js';

/* ── Query kind 常量 ── */
export const VALUE_QUERY_BY_ID = 'core-value.get-by-id' as const;
export const VALUE_QUERY_ALL = 'core-value.get-all' as const;

/* ── Command kind 常量 ── */
export const VALUE_CMD_CREATE = 'core-value.create' as const;
export const VALUE_CMD_UPDATE = 'core-value.update' as const;
export const VALUE_CMD_DELETE = 'core-value.delete' as const;
export const VALUE_CMD_DELETE_ALL = 'core-value.delete-all' as const;
export const VALUE_CMD_UPSERT = 'core-value.upsert' as const;

/* ── Query 工厂 ── */

export function valueById(id: ValueId): Query<CoreValue | null, { id: ValueId }> {
  return { kind: VALUE_QUERY_BY_ID, params: { id } };
}

export function allValues(): Query<CoreValue, void> {
  return { kind: VALUE_QUERY_ALL, params: undefined as void };
}

/* ── Command 参数类型 ── */

export interface CreateValueParams {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly timeDiscount: number;
  readonly emotionAmplifier: number;
  readonly updatedAt: number;
}

export interface UpdateValueParams {
  readonly id: ValueId;
  readonly patch: CoreValuePatch;
  readonly updatedAt: number;
}

/* ── Command 工厂 ── */

export function createValueCmd(params: CreateValueParams): Command<CreateValueParams> {
  return { kind: VALUE_CMD_CREATE, params };
}

export function updateValueCmd(params: UpdateValueParams): Command<UpdateValueParams> {
  return { kind: VALUE_CMD_UPDATE, params };
}

export function deleteValueCmd(id: ValueId): Command<{ id: ValueId }> {
  return { kind: VALUE_CMD_DELETE, params: { id } };
}

export function deleteAllValuesCmd(): Command<void> {
  return { kind: VALUE_CMD_DELETE_ALL, params: undefined as void };
}

export function upsertValueCmd(params: CreateValueParams): Command<CreateValueParams> {
  return { kind: VALUE_CMD_UPSERT, params };
}
