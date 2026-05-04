/**
 * Persona 知识条目检索 Query kind 常量与参数类型
 * （供对话检索器使用）
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const KRTV_QUERY_BY_PERSONA = 'knowledgeRetriever.byPersona' as const;

/* ── 行类型 ── */

export interface KrtvKnowledgeRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly fingerprint: string | null;
}

/* ── 参数类型 ── */

export interface KrtvByPersonaParams {
  tenantId: string;
  personaId: string;
}

/* ── Query 工厂 ── */

export function krtvQueryByPersona(params: KrtvByPersonaParams): Query<readonly KrtvKnowledgeRow[], KrtvByPersonaParams> {
  return { kind: KRTV_QUERY_BY_PERSONA, params };
}
