/**
 * 更新闸门 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const UGATE_QUERY_BY_ID = 'updateGate.byId' as const;
export const UGATE_QUERY_PENDING = 'updateGate.pending' as const;

/* ── Command Kinds ── */

export const UGATE_CMD_PROPOSE = 'updateGate.propose' as const;
export const UGATE_CMD_SET_STATUS = 'updateGate.setStatus' as const;

/* ── 行类型 ── */

export interface PendingUpdateRow {
  readonly id: string;
  readonly layer: string;
  readonly trigger_type: string;
  readonly target_id: string;
  readonly current_value: string | null;
  readonly proposed_value: string | null;
  readonly delta: number;
  readonly reason: string | null;
  readonly created_at: number;
  readonly status: string;
}

/* ── 参数类型 ── */

export interface UgateProposeParams {
  id: string;
  layer: string;
  triggerType: string;
  targetId: string;
  currentValue: string | null;
  proposedValue: string | null;
  delta: number;
  reason: string | null;
  createdAt: number;
  status: string;
}

export interface UgateSetStatusParams {
  id: string;
  status: string;
}

/* ── Query 工厂 ── */

export function ugateQueryById(id: string): Query<PendingUpdateRow | null, string> {
  return { kind: UGATE_QUERY_BY_ID, params: id };
}

export function ugateQueryPending(): Query<PendingUpdateRow, string> {
  return { kind: UGATE_QUERY_PENDING, params: 'pending' };
}

/* ── Command 工厂 ── */

export function ugateCmdPropose(params: UgateProposeParams): Command<UgateProposeParams> {
  return { kind: UGATE_CMD_PROPOSE, params };
}

export function ugateCmdSetStatus(params: UgateSetStatusParams): Command<UgateSetStatusParams> {
  return { kind: UGATE_CMD_SET_STATUS, params };
}
