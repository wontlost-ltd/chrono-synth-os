/**
 * 岗位人格模板 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  PTPL_QUERY_LIST, PTPL_QUERY_BY_ID,
  PTPL_CMD_UPSERT_BUILTIN, PTPL_CMD_INSERT, PTPL_CMD_UPDATE, PTPL_CMD_DELETE,
} from '@chrono/kernel';
import type {
  PtplRow, PtplListParams, PtplByIdParams,
  PtplUpsertBuiltinParams, PtplInsertParams, PtplUpdateParams, PtplDeleteParams,
} from '@chrono/kernel';

export function registerPersonaTemplateExecutors(): void {
  registerQuery<readonly PtplRow[], PtplListParams>(PTPL_QUERY_LIST, (db, p) => {
    return db.prepare<PtplRow>(
      `SELECT * FROM persona_templates
        WHERE tenant_id = ? OR tenant_id = ?
        ORDER BY is_builtin DESC, category ASC, label ASC`,
    ).all(p.tenantId, p.builtinTenantId);
  });

  registerQuery<PtplRow | null, PtplByIdParams>(PTPL_QUERY_BY_ID, (db, p) => {
    return db.prepare<PtplRow>(
      `SELECT * FROM persona_templates
        WHERE id = ? AND (tenant_id = ? OR tenant_id = ?)`,
    ).get(p.templateId, p.tenantId, p.builtinTenantId) ?? null;
  });

  registerCommand<PtplUpsertBuiltinParams>(PTPL_CMD_UPSERT_BUILTIN, (db, p) => {
    const result = db.prepare<void>(
      `INSERT OR REPLACE INTO persona_templates
        (id, tenant_id, category, label, description,
         default_values_json, default_narrative, behavior_boundaries_json,
         required_knowledge_categories_json, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.category, p.label, p.description,
      p.defaultValuesJson, p.defaultNarrative, p.behaviorBoundariesJson,
      p.requiredKnowledgeCategoriesJson, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PtplInsertParams>(PTPL_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_templates
        (id, tenant_id, category, label, description,
         default_values_json, default_narrative, behavior_boundaries_json,
         required_knowledge_categories_json, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.category, p.label, p.description,
      p.defaultValuesJson, p.defaultNarrative, p.behaviorBoundariesJson,
      p.requiredKnowledgeCategoriesJson, p.createdAt, p.updatedAt,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PtplUpdateParams>(PTPL_CMD_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_templates
          SET label = ?, description = ?,
              default_values_json = ?, default_narrative = ?,
              behavior_boundaries_json = ?, required_knowledge_categories_json = ?,
              updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(
      p.label, p.description,
      p.defaultValuesJson, p.defaultNarrative,
      p.behaviorBoundariesJson, p.requiredKnowledgeCategoriesJson,
      p.updatedAt, p.id, p.tenantId,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PtplDeleteParams>(PTPL_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM persona_templates WHERE id = ? AND tenant_id = ?',
    ).run(p.templateId, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
