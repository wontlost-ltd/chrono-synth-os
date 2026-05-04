/**
 * Persona 知识条目检索 SQL 执行器
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import { KRTV_QUERY_BY_PERSONA } from '@chrono/kernel';
import type { KrtvKnowledgeRow, KrtvByPersonaParams } from '@chrono/kernel';

export function registerKnowledgeRetrieverExecutors(): void {
  registerQuery<readonly KrtvKnowledgeRow[], KrtvByPersonaParams>(KRTV_QUERY_BY_PERSONA, (db, p) => {
    return db.prepare<KrtvKnowledgeRow>(
      `SELECT id, title, content, confidence, fingerprint
         FROM persona_knowledge_items
        WHERE tenant_id = ? AND persona_id = ?`,
    ).all(p.tenantId, p.personaId);
  });
}
