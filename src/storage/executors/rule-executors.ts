/**
 * persona_rules SQL 执行器（ADR-0047）。
 *
 * 版本化：同 (tenant, persona, rule_id) 按 version 多行并存。
 *   - insert：写入指定 version（version 由 store 用 maxVersion+1 算出）；
 *   - activeByPersona：每个 rule_id 只取最高版本，供 RuleEngine 消费；
 *   - byPersona / maxVersion：审计与追加版本。
 * 全部 tenant + persona scoped（对象级授权）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  PersonaRuleRow,
  PersonaRuleMaxVersionRow,
  RuleScopedParams,
  RuleByPersonaParams,
  RuleInsertParams,
} from '@chrono/kernel';
import {
  RULE_QUERY_ACTIVE_BY_PERSONA, RULE_QUERY_BY_PERSONA, RULE_QUERY_MAX_VERSION,
  RULE_CMD_INSERT,
} from '@chrono/kernel';

export function registerRuleExecutors(): void {
  /* ── Queries ── */

  registerQuery<PersonaRuleRow[], RuleByPersonaParams>(RULE_QUERY_ACTIVE_BY_PERSONA, (db, p) => {
    return db.prepare<PersonaRuleRow>(
      `SELECT r.* FROM persona_rules r
       WHERE r.tenant_id = ? AND r.persona_id = ?
         AND r.version = (
           SELECT MAX(r2.version) FROM persona_rules r2
           WHERE r2.tenant_id = r.tenant_id
             AND r2.persona_id = r.persona_id
             AND r2.rule_id = r.rule_id
         )
       ORDER BY r.rule_id ASC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<PersonaRuleRow[], RuleByPersonaParams>(RULE_QUERY_BY_PERSONA, (db, p) => {
    return db.prepare<PersonaRuleRow>(
      `SELECT * FROM persona_rules
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY rule_id ASC, version DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<PersonaRuleMaxVersionRow | null, RuleScopedParams>(RULE_QUERY_MAX_VERSION, (db, p) => {
    return db.prepare<PersonaRuleMaxVersionRow>(
      `SELECT MAX(version) AS max_version FROM persona_rules
       WHERE tenant_id = ? AND persona_id = ? AND rule_id = ?`,
    ).get(p.tenantId, p.personaId, p.ruleId) ?? null;
  });

  /* ── Command ── */

  registerCommand<RuleInsertParams>(RULE_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_rules
       (tenant_id, persona_id, rule_id, condition, action, weight, description, artifact_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.tenantId, p.personaId, p.ruleId, p.condition, p.action, p.weight,
      p.description, p.artifactId, p.version, p.createdAt, p.updatedAt,
    );
    return { rowsAffected: result.changes };
  });
}
