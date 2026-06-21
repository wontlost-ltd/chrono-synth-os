/**
 * 认知模型 SQL 执行器
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import { COGNITIVE_MODEL_QUERY_GET, COGNITIVE_MODEL_CMD_SET } from '@chrono/kernel';
import type { CognitiveModelGetParams, CognitiveModelSetParams, CognitiveModelRow } from '@chrono/kernel';

interface ModelDbRow {
  model_json: string;
  updated_at: number;
}

export function registerCognitiveModelExecutors(): void {
  registerQuery<CognitiveModelRow | null, CognitiveModelGetParams>(COGNITIVE_MODEL_QUERY_GET, (db: IDatabase, params) => {
    const row = db.prepare<ModelDbRow>(
      'SELECT model_json, updated_at FROM cognitive_model WHERE tenant_id = ? AND persona_id = ?',
    ).get(params.tenantId, params.personaId);
    if (!row) return null;
    return { modelJson: row.model_json, updatedAt: row.updated_at };
  });

  registerCommand<CognitiveModelSetParams>(COGNITIVE_MODEL_CMD_SET, (db: IDatabase, p) => {
    db.prepare<void>(
      `INSERT INTO cognitive_model (tenant_id, persona_id, model_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET model_json = excluded.model_json, updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.personaId, p.modelJson, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
