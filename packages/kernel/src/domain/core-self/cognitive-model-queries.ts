/** 认知模型 Query/Command kind 常量与工厂 */
import type { Query, Command } from '../../ports/query.js';

export const COGNITIVE_MODEL_QUERY_GET = 'cognitive-model.get' as const;
export const COGNITIVE_MODEL_CMD_SET = 'cognitive-model.set' as const;

export interface CognitiveModelGetParams { readonly tenantId: string }
export interface CognitiveModelSetParams {
  readonly tenantId: string;
  readonly modelJson: string;
  readonly updatedAt: number;
}

/** 查询原始行数据 */
export interface CognitiveModelRow {
  readonly modelJson: string | null;
  readonly updatedAt: number;
}

export function cognitiveModelGet(tenantId: string): Query<CognitiveModelRow | null, CognitiveModelGetParams> {
  return { kind: COGNITIVE_MODEL_QUERY_GET, params: { tenantId } };
}

export function cognitiveModelSetCmd(params: CognitiveModelSetParams): Command<CognitiveModelSetParams> {
  return { kind: COGNITIVE_MODEL_CMD_SET, params };
}
