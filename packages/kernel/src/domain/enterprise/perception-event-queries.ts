/**
 * 感知事件审计的 Query/Command kind 契约（深化感知）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。**不存表征原文**——只存内容哈希 + 计数 +
 * 元数据（感知行为审计，不含敏感内容）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const PERCEPTION_EVENT_QUERY_BY_TENANT = 'perceptionEvent.byTenant' as const;
export const PERCEPTION_EVENT_CMD_INSERT = 'perceptionEvent.insert' as const;

/* ── Row ── */

export interface PerceptionEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly modality: string;
  readonly representation_sha256: string;
  readonly provider_name: string;
  readonly memory_count: number;
  readonly candidate_count: number;
  readonly pending_count: number;
  readonly status: string;
  readonly created_at: number;
}

/* ── Params ── */

export interface PerceptionEventInsertParams {
  id: string;
  tenantId: string;
  personaId: string;
  modality: string;
  representationSha256: string;
  providerName: string;
  memoryCount: number;
  candidateCount: number;
  pendingCount: number;
  status: string;
  createdAt: number;
}

/* ── 工厂 ── */

/** 列某租户感知事件（审计回看 / GDPR 导出），按时间倒序。 */
export function perceptionEventByTenant(tenantId: string): Query<PerceptionEventRow, string> {
  return { kind: PERCEPTION_EVENT_QUERY_BY_TENANT, params: tenantId };
}

/** 记一条感知事件审计（感知调用后）。 */
export function perceptionEventInsert(params: PerceptionEventInsertParams): Command<PerceptionEventInsertParams> {
  return { kind: PERCEPTION_EVENT_CMD_INSERT, params };
}
