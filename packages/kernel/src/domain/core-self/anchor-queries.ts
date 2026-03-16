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

/* ── Query 工厂 ── */

export function anchorById(id: string): Query<SurvivalAnchor | null, { id: string }> {
  return { kind: ANCHOR_QUERY_BY_ID, params: { id } };
}

export function allAnchors(): Query<SurvivalAnchor, void> {
  return { kind: ANCHOR_QUERY_ALL, params: undefined as void };
}

/* ── Command 参数类型 ── */

export interface CreateAnchorParams {
  readonly id: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  readonly valueJson: string;
  readonly severity: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateAnchorParams {
  readonly id: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  readonly valueJson: string;
  readonly severity: number;
  readonly updatedAt: number;
}

/* ── Command 工厂 ── */

export function createAnchorCmd(params: CreateAnchorParams): Command<CreateAnchorParams> {
  return { kind: ANCHOR_CMD_CREATE, params };
}

export function updateAnchorCmd(params: UpdateAnchorParams): Command<UpdateAnchorParams> {
  return { kind: ANCHOR_CMD_UPDATE, params };
}

export function deleteAnchorCmd(id: string): Command<{ id: string }> {
  return { kind: ANCHOR_CMD_DELETE, params: { id } };
}

export function deleteAllAnchorsCmd(): Command<void> {
  return { kind: ANCHOR_CMD_DELETE_ALL, params: undefined as void };
}

export function upsertAnchorCmd(params: CreateAnchorParams): Command<CreateAnchorParams> {
  return { kind: ANCHOR_CMD_UPSERT, params };
}
