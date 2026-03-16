/** 决策风格 Query/Command kind 常量与工厂 */
import type { Query, Command } from '../../ports/query.js';

export const DECISION_STYLE_QUERY_GET = 'decision-style.get' as const;
export const DECISION_STYLE_CMD_SET = 'decision-style.set' as const;

export interface DecisionStyleGetParams { readonly tenantId: string }
export interface DecisionStyleSetParams {
  readonly tenantId: string;
  readonly styleJson: string;
  readonly updatedAt: number;
}

/** 查询原始行数据：{ styleJson: string | null, updatedAt: number } */
export interface DecisionStyleRow {
  readonly styleJson: string | null;
  readonly updatedAt: number;
}

export function decisionStyleGet(tenantId: string): Query<DecisionStyleRow | null, DecisionStyleGetParams> {
  return { kind: DECISION_STYLE_QUERY_GET, params: { tenantId } };
}

export function decisionStyleSetCmd(params: DecisionStyleSetParams): Command<DecisionStyleSetParams> {
  return { kind: DECISION_STYLE_CMD_SET, params };
}
