/**
 * 生存锚点 Query/Command 规范
 * 定义 kind 常量和类型安全的工厂函数，SQL 实现留在宿主层
 */

import type { Query, Command } from '../../ports/query.js';
import type { SurvivalAnchor, SurvivalAnchorKind } from './anchor-types.js';

/* ── Query kind 常量 ── */
export const ANCHOR_QUERY_BY_ID = 'survival-anchor.get-by-id' as const;
export const ANCHOR_QUERY_ALL = 'survival-anchor.get-all' as const;

/* ── Command kind 常量 ── */
export const ANCHOR_CMD_CREATE = 'survival-anchor.create' as const;
export const ANCHOR_CMD_UPDATE = 'survival-anchor.update' as const;
export const ANCHOR_CMD_DELETE = 'survival-anchor.delete' as const;
export const ANCHOR_CMD_DELETE_ALL = 'survival-anchor.delete-all' as const;
export const ANCHOR_CMD_UPSERT = 'survival-anchor.upsert' as const;

/* ── Query 参数类型（ADR-0056 K5b：survival_anchors 按 (tenant, persona) 隔离；tenant_id 由宿主注入，
 * persona_id 经 executor 显式线程。） ── */

export interface AnchorByIdParams {
  readonly id: string;
  readonly personaId: string;
}

export interface AnchorAllParams {
  readonly personaId: string;
}

/* ── Query 工厂 ── */

export function anchorById(id: string, personaId = 'default'): Query<SurvivalAnchor | null, AnchorByIdParams> {
  return { kind: ANCHOR_QUERY_BY_ID, params: { id, personaId } };
}

export function allAnchors(personaId = 'default'): Query<SurvivalAnchor, AnchorAllParams> {
  return { kind: ANCHOR_QUERY_ALL, params: { personaId } };
}

/* ── Command 参数类型 ── */

export interface CreateAnchorParams {
  readonly id: string;
  readonly personaId: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  readonly valueJson: string;
  readonly severity: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateAnchorParams {
  readonly id: string;
  readonly personaId: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  readonly valueJson: string;
  readonly severity: number;
  readonly updatedAt: number;
}

export interface DeleteAnchorParams {
  readonly id: string;
  readonly personaId: string;
}

export interface DeleteAllAnchorsParams {
  readonly personaId: string;
}

/* ── Command 工厂 ── */

export function createAnchorCmd(params: CreateAnchorParams): Command<CreateAnchorParams> {
  return { kind: ANCHOR_CMD_CREATE, params };
}

export function updateAnchorCmd(params: UpdateAnchorParams): Command<UpdateAnchorParams> {
  return { kind: ANCHOR_CMD_UPDATE, params };
}

export function deleteAnchorCmd(id: string, personaId = 'default'): Command<DeleteAnchorParams> {
  return { kind: ANCHOR_CMD_DELETE, params: { id, personaId } };
}

export function deleteAllAnchorsCmd(personaId = 'default'): Command<DeleteAllAnchorsParams> {
  return { kind: ANCHOR_CMD_DELETE_ALL, params: { personaId } };
}

export function upsertAnchorCmd(params: CreateAnchorParams): Command<CreateAnchorParams> {
  return { kind: ANCHOR_CMD_UPSERT, params };
}
