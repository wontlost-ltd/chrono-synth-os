/**
 * 响应模板专用持久化（ADR-0047 deferred 项落地）。
 *
 * 背景：response_template 蒸馏工件原先由 ArtifactCompiler 编译成 procedural memory，
 * 但 procedural 记忆会按 salience 衰减并在容量超限时被驱逐——「学到的回应模板会被遗忘」，
 * 违背 ADR-0047「蒸馏进确定性内核即持久」的承诺。改为落本专用表：
 *   - 不在 memory 衰减/驱逐范围内 → 真正持久；
 *   - 版本化：同一 (tenant, persona, intent) 保留多版本（蒸馏是迭代改进，留史可审计/回滚），
 *     检索按 intent 取最高版本；
 *   - 按 intent 精确检索，作为未来对话消费端的契约入口（当前无消费者，先铺基础设施）。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。SQL 由 src/storage 执行器实现。
 */

import type { Query, Command } from '../../ports/query.js';

/** 一条响应模板的领域视图。 */
export interface ResponseTemplate {
  readonly tenantId: string;
  readonly personaId: string;
  /** 触发该模板的意图/主题键（精确匹配检索）。 */
  readonly intent: string;
  /** 模板正文（可含 slot 占位）。 */
  readonly template: string;
  /** 版本号，从 1 起，同 intent 每次编译 +1。 */
  readonly version: number;
  /** 溯源：编译来源的蒸馏工件 id（审计用，可空——非蒸馏直写时为 null）。 */
  readonly artifactId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/* ── Query / Command kind 常量 ── */

export const RT_QUERY_LATEST_BY_INTENT = 'responseTemplate.latestByIntent' as const;
export const RT_QUERY_BY_INTENT = 'responseTemplate.byIntent' as const;
export const RT_QUERY_BY_PERSONA = 'responseTemplate.byPersona' as const;
export const RT_QUERY_MAX_VERSION = 'responseTemplate.maxVersion' as const;

export const RT_CMD_INSERT = 'responseTemplate.insert' as const;

/* ── 行类型 ── */

export interface ResponseTemplateRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly intent: string;
  readonly template: string;
  readonly version: number;
  readonly artifact_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** maxVersion 查询返回（聚合，无行时为 null）。 */
export interface ResponseTemplateMaxVersionRow {
  readonly max_version: number | null;
}

/* ── 参数类型 ── */

export interface RtScopedIntentParams {
  tenantId: string;
  personaId: string;
  intent: string;
}

export interface RtByPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface RtInsertParams {
  tenantId: string;
  personaId: string;
  intent: string;
  template: string;
  version: number;
  artifactId: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ── Query 工厂 ── */

/** 取某 intent 的最高版本（对话消费端契约入口）。 */
export function rtQueryLatestByIntent(params: RtScopedIntentParams): Query<ResponseTemplateRow | null, RtScopedIntentParams> {
  return { kind: RT_QUERY_LATEST_BY_INTENT, params };
}

/** 取某 intent 的所有版本（审计/回滚）。 */
export function rtQueryByIntent(params: RtScopedIntentParams): Query<ResponseTemplateRow, RtScopedIntentParams> {
  return { kind: RT_QUERY_BY_INTENT, params };
}

/** 取某 persona 的所有模板（每 intent 每版本一行）。 */
export function rtQueryByPersona(params: RtByPersonaParams): Query<ResponseTemplateRow, RtByPersonaParams> {
  return { kind: RT_QUERY_BY_PERSONA, params };
}

/** 取某 intent 的当前最高版本号（upsert 计算下一版本用）。 */
export function rtQueryMaxVersion(params: RtScopedIntentParams): Query<ResponseTemplateMaxVersionRow | null, RtScopedIntentParams> {
  return { kind: RT_QUERY_MAX_VERSION, params };
}

/* ── Command 工厂 ── */

export function rtCmdInsert(params: RtInsertParams): Command<RtInsertParams> {
  return { kind: RT_CMD_INSERT, params };
}

/** 把数据库行转成领域视图。集中一处，store 复用。 */
export function responseTemplateFromRow(row: ResponseTemplateRow): ResponseTemplate {
  return {
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    intent: row.intent,
    template: row.template,
    version: row.version,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
