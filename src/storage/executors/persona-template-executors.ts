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
    /* 用 ANSI ON CONFLICT 而非 SQLite 专用的 INSERT OR REPLACE：
     * 后者在 PostgreSQL 上是语法错误（"OR" 处报错），导致跨 driver
     * 启动失败。SQLite 自 3.24 起也支持 ON CONFLICT 语法，所以同一
     * SQL 在两个后端都能跑。created_at 在冲突时不覆盖（保留首次写入值）。
     * 详情见 P1.6 perf 烟测 run 25371013311 暴露的 syntax error。 */
    const result = db.prepare<void>(
      `INSERT INTO persona_templates
        (id, tenant_id, category, label, description,
         default_values_json, default_narrative, behavior_boundaries_json,
         required_knowledge_categories_json, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         category = excluded.category,
         label = excluded.label,
         description = excluded.description,
         default_values_json = excluded.default_values_json,
         default_narrative = excluded.default_narrative,
         behavior_boundaries_json = excluded.behavior_boundaries_json,
         required_knowledge_categories_json = excluded.required_knowledge_categories_json,
         is_builtin = excluded.is_builtin,
         updated_at = excluded.updated_at`,
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
