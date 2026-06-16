/**
 * per-persona 治理策略 SQL 执行器（ADR-0048 治理可配化）。
 *
 * 策略是非 secret 配置（policy_json 内含 categoryRoutes / AML 阈值 / 预算等可覆盖字段）。
 * 一 persona 一行（tenant_id + persona_id 复合主键），upsert 覆盖。全部 tenant scoped。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  PersonaGovernanceRow,
  PersonaGovernanceByPersonaParams,
  PersonaGovernanceUpsertParams,
  PersonaGovernanceUpdateIfVersionParams,
} from '@chrono/kernel';
import {
  PERSONA_GOVERNANCE_QUERY_BY_PERSONA,
  PERSONA_GOVERNANCE_CMD_UPSERT,
  PERSONA_GOVERNANCE_CMD_UPDATE_IF_VERSION,
  PERSONA_GOVERNANCE_CMD_DELETE,
} from '@chrono/kernel';

export function registerPersonaGovernanceExecutors(): void {
  /* ── Queries ── */

  registerQuery<PersonaGovernanceRow | null, PersonaGovernanceByPersonaParams>(
    PERSONA_GOVERNANCE_QUERY_BY_PERSONA,
    (db, p) => {
      return db.prepare<PersonaGovernanceRow>(
        'SELECT * FROM persona_governance_policy WHERE tenant_id = ? AND persona_id = ?',
      ).get(p.tenantId, p.personaId) ?? null;
    },
  );

  /* ── Commands ── */

  registerCommand<PersonaGovernanceUpsertParams>(PERSONA_GOVERNANCE_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_governance_policy (tenant_id, persona_id, policy_json, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET
         policy_json = excluded.policy_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.personaId, p.policyJson, p.updatedBy, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  /* DB 级原子 CAS：仅当现有行 updated_at = expectedUpdatedAt 才写（rowsAffected=0 → 版本冲突）。
   * 读版本与写入条件在数据库里成为一个原子操作，消除 JS read-then-write 的 TOCTOU 窗口（Codex 复审 High）。 */
  registerCommand<PersonaGovernanceUpdateIfVersionParams>(PERSONA_GOVERNANCE_CMD_UPDATE_IF_VERSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_governance_policy
       SET policy_json = ?, updated_by = ?, updated_at = ?
       WHERE tenant_id = ? AND persona_id = ? AND updated_at = ?`,
    ).run(p.policyJson, p.updatedBy, p.now, p.tenantId, p.personaId, p.expectedUpdatedAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<PersonaGovernanceByPersonaParams>(PERSONA_GOVERNANCE_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM persona_governance_policy WHERE tenant_id = ? AND persona_id = ?',
    ).run(p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });
}
