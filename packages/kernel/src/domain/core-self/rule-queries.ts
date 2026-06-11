/**
 * persona_rules 专用持久化（ADR-0047 rule 编译路径）。
 *
 * rule 蒸馏工件编译为版本化规则库：同一 (tenant, persona, ruleId) 保留多版本，
 * 决策时只消费每个 ruleId 的最高版本；审计/回滚可列出历史。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。SQL 由 src/storage 执行器实现。
 */

import type { Query, Command } from '../../ports/query.js';
import type { RulePayload } from './distilled-artifact-types.js';

/** 一条 persona rule 的领域视图。 */
export interface PersonaRule {
  readonly tenantId: string;
  readonly personaId: string;
  readonly ruleId: string;
  readonly condition: string;
  readonly action: 'prefer' | 'avoid';
  readonly weight: number;
  readonly description: string | null;
  readonly artifactId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/* ── Query / Command kind 常量 ── */

export const RULE_QUERY_ACTIVE_BY_PERSONA = 'personaRule.activeByPersona' as const;
export const RULE_QUERY_BY_PERSONA = 'personaRule.byPersona' as const;
export const RULE_QUERY_MAX_VERSION = 'personaRule.maxVersion' as const;

export const RULE_CMD_INSERT = 'personaRule.insert' as const;

/* ── 行类型 ── */

export interface PersonaRuleRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly rule_id: string;
  readonly condition: string;
  readonly action: 'prefer' | 'avoid';
  readonly weight: number;
  readonly description: string | null;
  readonly artifact_id: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** maxVersion 查询返回（聚合，无行时为 null）。 */
export interface PersonaRuleMaxVersionRow {
  readonly max_version: number | null;
}

/* ── 参数类型 ── */

export interface RuleScopedParams {
  tenantId: string;
  personaId: string;
  ruleId: string;
}

export interface RuleByPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface RuleInsertParams {
  tenantId: string;
  personaId: string;
  ruleId: string;
  condition: string;
  action: 'prefer' | 'avoid';
  weight: number;
  description: string | null;
  artifactId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/* ── Query 工厂 ── */

/** 取某 persona 的所有 active rules：每个 rule_id 仅取最高 version。 */
export function ruleQueryActiveByPersona(params: RuleByPersonaParams): Query<PersonaRuleRow, RuleByPersonaParams> {
  return { kind: RULE_QUERY_ACTIVE_BY_PERSONA, params };
}

/** 取某 persona 的所有规则版本（审计/回滚）。 */
export function ruleQueryByPersona(params: RuleByPersonaParams): Query<PersonaRuleRow, RuleByPersonaParams> {
  return { kind: RULE_QUERY_BY_PERSONA, params };
}

/** 取某 rule_id 的当前最高版本号（appendVersion 计算下一版本用）。 */
export function ruleQueryMaxVersion(params: RuleScopedParams): Query<PersonaRuleMaxVersionRow | null, RuleScopedParams> {
  return { kind: RULE_QUERY_MAX_VERSION, params };
}

/* ── Command 工厂 ── */

export function ruleCmdInsert(params: RuleInsertParams): Command<RuleInsertParams> {
  return { kind: RULE_CMD_INSERT, params };
}

/** 把数据库行转成领域视图。集中一处，store 复用。 */
export function personaRuleFromRow(row: PersonaRuleRow): PersonaRule {
  return {
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    ruleId: row.rule_id,
    condition: row.condition,
    action: row.action,
    weight: row.weight,
    description: row.description,
    artifactId: row.artifact_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 决策引擎只消费 RulePayload 形状，不暴露持久化元数据。 */
export function rulePayloadFromRow(row: PersonaRuleRow): RulePayload {
  return {
    ruleId: row.rule_id,
    condition: row.condition,
    action: row.action,
    weight: row.weight,
    ...(row.description === null ? {} : { description: row.description }),
  };
}
