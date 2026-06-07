/**
 * 蒸馏工件 SQL 执行器（ADR-0047）
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  DistilledArtifactRow,
  DistillInsertParams,
  DistillSetStatusParams,
  DistillByPersonaParams,
  DistillByStatusParams,
  DistillByIdScopedParams,
} from '@chrono/kernel';
import {
  DISTILL_QUERY_BY_ID, DISTILL_QUERY_BY_PERSONA, DISTILL_QUERY_BY_STATUS,
  DISTILL_CMD_INSERT, DISTILL_CMD_SET_STATUS,
} from '@chrono/kernel';

export function registerDistilledArtifactExecutors(): void {
  /* ── Queries ── */

  /* 对象级授权：id 必须同时匹配 tenant + persona，防 IDOR 越权 */
  registerQuery<DistilledArtifactRow | null, DistillByIdScopedParams>(DISTILL_QUERY_BY_ID, (db, p) => {
    return db.prepare<DistilledArtifactRow>(
      'SELECT * FROM distilled_artifacts WHERE id = ? AND tenant_id = ? AND persona_id = ?',
    ).get(p.id, p.tenantId, p.personaId) ?? null;
  });

  registerQuery<DistilledArtifactRow[], DistillByPersonaParams>(DISTILL_QUERY_BY_PERSONA, (db, p) => {
    return db.prepare<DistilledArtifactRow>(
      'SELECT * FROM distilled_artifacts WHERE tenant_id = ? AND persona_id = ? ORDER BY created_at DESC',
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<DistilledArtifactRow[], DistillByStatusParams>(DISTILL_QUERY_BY_STATUS, (db, p) => {
    return db.prepare<DistilledArtifactRow>(
      'SELECT * FROM distilled_artifacts WHERE tenant_id = ? AND persona_id = ? AND status = ? ORDER BY created_at DESC',
    ).all(p.tenantId, p.personaId, p.status);
  });

  /* ── Commands ── */

  registerCommand<DistillInsertParams>(DISTILL_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO distilled_artifacts
      (id, tenant_id, persona_id, kind, source, payload, confidence, evidence, status, reason, created_at, compiled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(p.id, p.tenantId, p.personaId, p.kind, p.source, p.payload, p.confidence, p.evidence, p.status, p.reason, p.createdAt);
    return { rowsAffected: result.changes };
  });

  /* 乐观并发：仅当 (id, tenant_id, status=expectedStatus) 命中才推进，
   * 防止并发审批/编译导致状态机被绕过（D3 安全契约）。 */
  registerCommand<DistillSetStatusParams>(DISTILL_CMD_SET_STATUS, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE distilled_artifacts
       SET status = ?, reason = COALESCE(?, reason), compiled_at = ?
       WHERE id = ? AND tenant_id = ? AND persona_id = ? AND status = ?`,
    ).run(p.status, p.reason, p.compiledAt, p.id, p.tenantId, p.personaId, p.expectedStatus);
    return { rowsAffected: result.changes };
  });
}
