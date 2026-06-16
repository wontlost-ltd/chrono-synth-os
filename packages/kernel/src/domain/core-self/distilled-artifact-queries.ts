/**
 * 蒸馏工件 Query/Command kind 常量与参数类型（ADR-0047）
 * 纯类型，零 node:* 依赖。SQL 由 src 执行器实现。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const DISTILL_QUERY_BY_ID = 'distilledArtifact.byId' as const;
export const DISTILL_QUERY_BY_PERSONA = 'distilledArtifact.byPersona' as const;
export const DISTILL_QUERY_BY_STATUS = 'distilledArtifact.byStatus' as const;
/** 数窗口内 auto-compiled（未验证）工件数——不确定性预算用，避免 listByPersona 全量扫（性能债）。 */
export const DISTILL_QUERY_COUNT_AUTO_COMPILED = 'distilledArtifact.countAutoCompiledSince' as const;

/* ── Command Kinds ── */

export const DISTILL_CMD_INSERT = 'distilledArtifact.insert' as const;
export const DISTILL_CMD_SET_STATUS = 'distilledArtifact.setStatus' as const;

/* ── 行类型（payload/evidence 为 JSON 文本，由 src 层解析） ── */

export interface DistilledArtifactRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly kind: string;
  readonly source: string;
  readonly payload: string;
  readonly confidence: number;
  readonly evidence: string;
  readonly status: string;
  readonly reason: string | null;
  readonly created_at: number;
  readonly compiled_at: number | null;
  /** 编译路径（compiled 后写入）：'auto'=自动编译（未验证）/'approved'=人工审批（已验证）/null=未编译或历史行 */
  readonly compiled_via: string | null;
}

/* ── 参数类型 ── */

export interface DistillInsertParams {
  id: string;
  tenantId: string;
  personaId: string;
  kind: string;
  source: string;
  payload: string;
  confidence: number;
  evidence: string;
  status: string;
  reason: string | null;
  createdAt: number;
}

export interface DistillSetStatusParams {
  id: string;
  tenantId: string;
  /** 对象级授权：必须匹配工件所属 persona，防跨 persona/tenant 越权（IDOR） */
  personaId: string;
  /** 期望的当前状态（乐观并发：仅当当前状态匹配才推进） */
  expectedStatus: string;
  status: string;
  reason: string | null;
  /** 进入 compiled 时写入；其余传 null */
  compiledAt: number | null;
  /** 进入 compiled 时写入编译路径（'auto'/'approved'）；其余传 null（不确定性预算据此只数 auto） */
  compiledVia?: string | null;
}

/** 按 id + tenant + persona 精确定位单件工件（对象级授权） */
export interface DistillByIdScopedParams {
  id: string;
  tenantId: string;
  personaId: string;
}

export interface DistillByPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface DistillByStatusParams {
  tenantId: string;
  personaId: string;
  status: string;
}

/** 数窗口内 auto-compiled 工件参数：status=compiled ∧ compiled_via='auto' ∧ compiled_at ≥ since。 */
export interface DistillCountAutoCompiledParams {
  tenantId: string;
  personaId: string;
  /** 窗口起点（epoch ms）；compiled_at ≥ since 才计入。 */
  since: number;
}

/* ── Query 工厂 ── */

export function distillQueryById(params: DistillByIdScopedParams): Query<DistilledArtifactRow | null, DistillByIdScopedParams> {
  return { kind: DISTILL_QUERY_BY_ID, params };
}

export function distillQueryByPersona(params: DistillByPersonaParams): Query<DistilledArtifactRow, DistillByPersonaParams> {
  return { kind: DISTILL_QUERY_BY_PERSONA, params };
}

export function distillQueryByStatus(params: DistillByStatusParams): Query<DistilledArtifactRow, DistillByStatusParams> {
  return { kind: DISTILL_QUERY_BY_STATUS, params };
}

/** 数窗口内 auto-compiled（未验证）工件数（返回单个 count）。 */
export function distillQueryCountAutoCompiled(params: DistillCountAutoCompiledParams): Query<{ count: number }, DistillCountAutoCompiledParams> {
  return { kind: DISTILL_QUERY_COUNT_AUTO_COMPILED, params };
}

/* ── Command 工厂 ── */

export function distillCmdInsert(params: DistillInsertParams): Command<DistillInsertParams> {
  return { kind: DISTILL_CMD_INSERT, params };
}

export function distillCmdSetStatus(params: DistillSetStatusParams): Command<DistillSetStatusParams> {
  return { kind: DISTILL_CMD_SET_STATUS, params };
}
