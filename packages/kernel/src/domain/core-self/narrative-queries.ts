/** 叙事 Query/Command kind 常量与工厂 */
import type { Query, Command } from '../../ports/query.js';

export const NARRATIVE_QUERY_GET = 'narrative.get' as const;
export const NARRATIVE_CMD_SET = 'narrative.set' as const;

export interface NarrativeGetParams { readonly tenantId: string }
export interface NarrativeSetParams {
  readonly tenantId: string;
  readonly content: string;
  readonly updatedAt: number;
}

export function narrativeGet(tenantId: string): Query<string, NarrativeGetParams> {
  return { kind: NARRATIVE_QUERY_GET, params: { tenantId } };
}

export function narrativeSetCmd(params: NarrativeSetParams): Command<NarrativeSetParams> {
  return { kind: NARRATIVE_CMD_SET, params };
}
