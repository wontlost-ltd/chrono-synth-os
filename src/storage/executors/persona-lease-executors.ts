/**
 * PersonaLease SQL 执行器（ADR-0047 + ADR-0048）。
 *
 * acquire：INSERT ... ON CONFLICT(tenant_id,persona_id,purpose) DO UPDATE ...
 *   WHERE persona_leases.expires_at <= :now —— 原子 CAS：无锁则插入，锁已过期则抢占，
 *   被他人持有且未过期则 DO UPDATE 的 WHERE 不命中 → rowsAffected=0（没抢到）。
 *   复用 quota_consume 已验证的双库（SQLite ≥3.24 / Postgres）写法。
 * release：DELETE WHERE 主键 + holder_token 匹配 —— 只能释放自己持有的锁。
 * refresh：UPDATE expires_at WHERE 主键 + holder_token 匹配且未过期 —— 续租自己的锁。
 *
 * 释放/续租按 holder_token 匹配（乐观并发，参考 distilled_artifacts 的按期望值更新），
 * 杜绝 A 释放/续租 B 的锁（ABA 防护）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  PersonaLeaseRow,
  PersonaLeaseGetParams,
  PersonaLeaseAcquireParams,
  PersonaLeaseReleaseParams,
  PersonaLeaseRefreshParams,
} from '@chrono/kernel';
import {
  PERSONA_LEASE_QUERY_GET,
  PERSONA_LEASE_CMD_ACQUIRE,
  PERSONA_LEASE_CMD_RELEASE,
  PERSONA_LEASE_CMD_REFRESH,
} from '@chrono/kernel';

export function registerPersonaLeaseExecutors(): void {
  /* ── Query ── */

  registerQuery<PersonaLeaseRow | null, PersonaLeaseGetParams>(PERSONA_LEASE_QUERY_GET, (db, p) => {
    return db.prepare<PersonaLeaseRow>(
      'SELECT * FROM persona_leases WHERE tenant_id = ? AND persona_id = ? AND purpose = ?',
    ).get(p.tenantId, p.personaId, p.purpose) ?? null;
  });

  /* ── Commands ── */

  /* 原子获取/抢占：仅当无现有行（INSERT）或现有行已过期（DO UPDATE WHERE expires_at <= now）
   * 才成功。rowsAffected===1 表示拿到锁；0 表示被未过期的他人持有。 */
  registerCommand<PersonaLeaseAcquireParams>(PERSONA_LEASE_CMD_ACQUIRE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_leases (tenant_id, persona_id, purpose, holder_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id, purpose) DO UPDATE SET
         holder_token = excluded.holder_token,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE persona_leases.expires_at <= ?`,
    ).run(p.tenantId, p.personaId, p.purpose, p.holderToken, p.acquiredAt, p.expiresAt, p.now);
    return { rowsAffected: result.changes };
  });

  /* 释放：仅删除本持有者的锁。rowsAffected===1 表示成功释放。 */
  registerCommand<PersonaLeaseReleaseParams>(PERSONA_LEASE_CMD_RELEASE, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM persona_leases
       WHERE tenant_id = ? AND persona_id = ? AND purpose = ? AND holder_token = ?`,
    ).run(p.tenantId, p.personaId, p.purpose, p.holderToken);
    return { rowsAffected: result.changes };
  });

  /* 续租：仅当锁仍由本持有者持有且未过期才延长 expires_at。 */
  registerCommand<PersonaLeaseRefreshParams>(PERSONA_LEASE_CMD_REFRESH, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_leases
       SET expires_at = ?
       WHERE tenant_id = ? AND persona_id = ? AND purpose = ? AND holder_token = ? AND expires_at > ?`,
    ).run(p.expiresAt, p.tenantId, p.personaId, p.purpose, p.holderToken, p.now);
    return { rowsAffected: result.changes };
  });
}
