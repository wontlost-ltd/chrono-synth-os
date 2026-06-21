/** 决策风格 Query/Command kind 常量与工厂 */
import type { Query, Command } from '../../ports/query.js';

export const DECISION_STYLE_QUERY_GET = 'decision-style.get' as const;
export const DECISION_STYLE_QUERY_LIST_ALL = 'decision-style.list-all' as const;
export const DECISION_STYLE_CMD_SET = 'decision-style.set' as const;

export interface DecisionStyleGetParams { readonly tenantId: string; readonly personaId: string }
export interface DecisionStyleSetParams {
  readonly tenantId: string;
  readonly personaId: string;
  readonly styleJson: string;
  readonly updatedAt: number;
}

/** 查询原始行数据：{ styleJson: string | null, updatedAt: number } */
export interface DecisionStyleRow {
  readonly styleJson: string | null;
  readonly updatedAt: number;
}

export function decisionStyleGet(tenantId: string, personaId: string): Query<DecisionStyleRow | null, DecisionStyleGetParams> {
  return { kind: DECISION_STYLE_QUERY_GET, params: { tenantId, personaId } };
}

/** 平台级聚合行：跨租户列出所有决策风格（仅供平台多样性度量等全局聚合，绕过租户隔离的合法用途）。 */
export interface DecisionStyleAllRow {
  readonly tenantId: string;
  readonly styleJson: string | null;
}

/**
 * 列出所有决策风格行（**跨租户平台聚合**，无 tenant_id/persona_id 谓词）。
 * K2(ADR-0056)后每 (tenant, persona) 一行——人群多样性度量按**人格实例**统计（一个租户多 persona 各计一份）。
 * 仅用于平台运营者视角的人群多样性度量等合法全局统计，不得用于租户业务路径。
 * 经 queryMany 返回逐行 DecisionStyleAllRow。
 */
export function decisionStyleListAll(): Query<DecisionStyleAllRow, Record<string, never>> {
  return { kind: DECISION_STYLE_QUERY_LIST_ALL, params: {} };
}

export function decisionStyleSetCmd(params: DecisionStyleSetParams): Command<DecisionStyleSetParams> {
  return { kind: DECISION_STYLE_CMD_SET, params };
}
