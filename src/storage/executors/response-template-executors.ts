/**
 * 响应模板 SQL 执行器（ADR-0047）。
 *
 * 版本化：同 (tenant, persona, intent) 按 version 多行并存。
 *   - insert：写入指定 version（version 由 store 用 maxVersion+1 算出）；
 *   - latestByIntent / maxVersion：ORDER BY version DESC 取最高版本；
 *   - byIntent / byPersona：列出（审计/回滚）。
 * 全部 tenant + persona scoped（对象级授权）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  ResponseTemplateRow,
  ResponseTemplateMaxVersionRow,
  RtScopedIntentParams,
  RtByPersonaParams,
  RtInsertParams,
} from '@chrono/kernel';
import {
  RT_QUERY_LATEST_BY_INTENT, RT_QUERY_BY_INTENT, RT_QUERY_BY_PERSONA, RT_QUERY_MAX_VERSION,
  RT_CMD_INSERT,
} from '@chrono/kernel';

export function registerResponseTemplateExecutors(): void {
  /* ── Queries ── */

  registerQuery<ResponseTemplateRow | null, RtScopedIntentParams>(RT_QUERY_LATEST_BY_INTENT, (db, p) => {
    return db.prepare<ResponseTemplateRow>(
      `SELECT * FROM response_templates
       WHERE tenant_id = ? AND persona_id = ? AND intent = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.intent) ?? null;
  });

  registerQuery<ResponseTemplateRow[], RtScopedIntentParams>(RT_QUERY_BY_INTENT, (db, p) => {
    return db.prepare<ResponseTemplateRow>(
      `SELECT * FROM response_templates
       WHERE tenant_id = ? AND persona_id = ? AND intent = ?
       ORDER BY version DESC`,
    ).all(p.tenantId, p.personaId, p.intent);
  });

  registerQuery<ResponseTemplateRow[], RtByPersonaParams>(RT_QUERY_BY_PERSONA, (db, p) => {
    return db.prepare<ResponseTemplateRow>(
      `SELECT * FROM response_templates
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY intent ASC, version DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<ResponseTemplateMaxVersionRow | null, RtScopedIntentParams>(RT_QUERY_MAX_VERSION, (db, p) => {
    return db.prepare<ResponseTemplateMaxVersionRow>(
      `SELECT MAX(version) AS max_version FROM response_templates
       WHERE tenant_id = ? AND persona_id = ? AND intent = ?`,
    ).get(p.tenantId, p.personaId, p.intent) ?? null;
  });

  /* ── Command ── */

  registerCommand<RtInsertParams>(RT_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO response_templates
       (tenant_id, persona_id, intent, template, version, artifact_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.tenantId, p.personaId, p.intent, p.template, p.version, p.artifactId, p.createdAt, p.updatedAt);
    return { rowsAffected: result.changes };
  });
}
