/**
 * Break-glass JTI 消费账本 Query/Command kind 常量与参数类型
 *
 * 提供跨实例的应急令牌一次性消费保证：依赖 UNIQUE(tenant_id, jti)
 * 索引在数据库层实现互斥；首次 INSERT 成功视为成功消费，
 * 后续相同 jti 的 INSERT 落入 ON CONFLICT 路径并被识别为重放。
 */

import type { Command } from '../../ports/query.js';

/* ── Command Kinds ── */

export const BG_CMD_INSERT_CONSUMPTION = 'breakGlass.insertConsumption' as const;
export const BG_CMD_PRUNE_CONSUMPTIONS = 'breakGlass.pruneConsumptions' as const;

/* ── 参数 / 结果类型 ── */

export interface BreakGlassInsertConsumptionParams {
  id: string;
  tenantId: string;
  jti: string;
  scope: string;
  consumedAt: string;
  consumedBy: string | null;
  requestIp: string | null;
  auditSeq: number | null;
}

export interface BreakGlassPruneConsumptionsParams {
  before: string;
}

export interface BreakGlassInsertConsumptionResult {
  inserted: boolean;
}

export interface BreakGlassPruneConsumptionsResult {
  rows: number;
}

/* ── Command 工厂 ── */

export function insertBreakGlassConsumption(
  params: BreakGlassInsertConsumptionParams,
): Command<BreakGlassInsertConsumptionParams> {
  return { kind: BG_CMD_INSERT_CONSUMPTION, params };
}

export function pruneOldBreakGlassConsumptions(before: Date): Command<BreakGlassPruneConsumptionsParams> {
  return {
    kind: BG_CMD_PRUNE_CONSUMPTIONS,
    params: { before: before.toISOString() },
  };
}

export function toBreakGlassInsertResult(rowsAffected: number): BreakGlassInsertConsumptionResult {
  return { inserted: rowsAffected === 1 };
}

export function toBreakGlassPruneResult(rowsAffected: number): BreakGlassPruneConsumptionsResult {
  return { rows: rowsAffected };
}
