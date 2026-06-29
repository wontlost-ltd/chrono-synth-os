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

/* ── Query 参数类型（ADR-0056 K5b：value 按 (tenant, persona) 隔离；tenant_id 由 TenantDatabase 自动注入，
 * persona_id 经 executor 显式线程——因 rewriter 只认 tenant，persona 必须显式传） ── */

export interface ValueByIdParams {
  readonly id: ValueId;
  readonly personaId: string;
}

export interface ValueAllParams {
  readonly personaId: string;
}

/* ── Query 工厂 ── */

export function valueById(id: ValueId, personaId = 'default'): Query<CoreValue | null, ValueByIdParams> {
  return { kind: VALUE_QUERY_BY_ID, params: { id, personaId } };
}

export function allValues(personaId = 'default'): Query<CoreValue, ValueAllParams> {
  return { kind: VALUE_QUERY_ALL, params: { personaId } };
}

/* ── Command 参数类型 ── */

export interface CreateValueParams {
  readonly id: string;
  readonly personaId: string;
  readonly label: string;
  readonly weight: number;
  readonly timeDiscount: number;
  readonly emotionAmplifier: number;
  readonly updatedAt: number;
}

export interface UpdateValueParams {
  readonly id: ValueId;
  readonly personaId: string;
  readonly patch: CoreValuePatch;
  readonly updatedAt: number;
}

export interface DeleteValueParams {
  readonly id: ValueId;
  readonly personaId: string;
}

export interface DeleteAllValuesParams {
  readonly personaId: string;
}

/* ── Command 工厂 ── */

export function createValueCmd(params: CreateValueParams): Command<CreateValueParams> {
  return { kind: VALUE_CMD_CREATE, params };
}

export function updateValueCmd(params: UpdateValueParams): Command<UpdateValueParams> {
  return { kind: VALUE_CMD_UPDATE, params };
}

export function deleteValueCmd(id: ValueId, personaId = 'default'): Command<DeleteValueParams> {
  return { kind: VALUE_CMD_DELETE, params: { id, personaId } };
}

export function deleteAllValuesCmd(personaId = 'default'): Command<DeleteAllValuesParams> {
  return { kind: VALUE_CMD_DELETE_ALL, params: { personaId } };
}

export function upsertValueCmd(params: CreateValueParams): Command<CreateValueParams> {
  return { kind: VALUE_CMD_UPSERT, params };
}
