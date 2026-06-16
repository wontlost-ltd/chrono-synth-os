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
  DISTILL_QUERY_COUNT_AUTO_COMPILED,
  DISTILL_CMD_INSERT, DISTILL_CMD_SET_STATUS,
  type DistillCountAutoCompiledParams,
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

  /* 数窗口内 auto-compiled 未验证工件——不确定性预算用，SQL COUNT 代替全表扫（性能债还清）。 */
  registerQuery<{ count: number }, DistillCountAutoCompiledParams>(DISTILL_QUERY_COUNT_AUTO_COMPILED, (db, p) => {
    const row = db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM distilled_artifacts
       WHERE tenant_id = ? AND persona_id = ? AND status = 'compiled' AND compiled_via = 'auto' AND compiled_at >= ?`,
    ).get(p.tenantId, p.personaId, p.since);
    return { count: row?.count ?? 0 };
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
    /* compiled_via 用 COALESCE：仅当本次传了（编译到 compiled 时）才写，其余转移保持原值不动。 */
    const result = db.prepare<void>(
      `UPDATE distilled_artifacts
       SET status = ?, reason = COALESCE(?, reason), compiled_at = ?, compiled_via = COALESCE(?, compiled_via)
       WHERE id = ? AND tenant_id = ? AND persona_id = ? AND status = ?`,
    ).run(p.status, p.reason, p.compiledAt, p.compiledVia ?? null, p.id, p.tenantId, p.personaId, p.expectedStatus);
    return { rowsAffected: result.changes };
  });
}
