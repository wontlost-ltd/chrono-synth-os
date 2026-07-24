/**
 * 协作服务 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  COLLAB_QUERY_SIMULATION_TENANT, COLLAB_QUERY_EXISTING_SHARE,
  COLLAB_QUERY_SHARE_COUNT, COLLAB_QUERY_SHARED_LIST, COLLAB_QUERY_SHARE_OWNER,
  COLLAB_QUERY_SHARES_FOR_SIMULATION,
  COLLAB_CMD_UPDATE_PERMISSION, COLLAB_CMD_CREATE_SHARE, COLLAB_CMD_DELETE_SHARE,
} from '@chrono/kernel';
import type {
  CollabSimTenantRow, CollabExistingShareRow, CollabShareCountRow,
  CollabSharedRow, CollabShareOwnerRow, CollabShareForSimulationRow,
  CollabExistingShareParams, CollabShareCountParams, CollabSharedListParams, CollabSharesForSimulationParams,
  CollabUpdatePermissionParams, CollabCreateShareParams, CollabDeleteShareParams,
} from '@chrono/kernel';

export function registerCollaborationExecutors(): void {
  registerQuery<CollabSimTenantRow | null, string>(COLLAB_QUERY_SIMULATION_TENANT, (db, simulationId) => {
    return db.prepare<CollabSimTenantRow>(
      'SELECT tenant_id, owner_user_id FROM life_simulations WHERE id = ?',
    ).get(simulationId) ?? null;
  });

  registerQuery<CollabExistingShareRow | null, CollabExistingShareParams>(COLLAB_QUERY_EXISTING_SHARE, (db, p) => {
    return db.prepare<CollabExistingShareRow>(
      'SELECT id, owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(p.simulationId, p.targetUserId) ?? null;
  });

  registerQuery<CollabShareCountRow | null, CollabShareCountParams>(COLLAB_QUERY_SHARE_COUNT, (db, p) => {
    /* shared_simulations 无 tenant_id 列 → 经 life_simulations 父归属做 tenant predicate
     * （JOIN ls ON ss.simulation_id=ls.id WHERE ls.tenant_id=?），防同库跨租户读到别租户的 share。 */
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) as count FROM shared_simulations ss
       JOIN life_simulations ls ON ss.simulation_id = ls.id
       WHERE ss.shared_with_user_id = ? AND ls.tenant_id = ?`,
    ).get(p.userId, p.tenantId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly CollabSharedRow[], CollabSharedListParams>(COLLAB_QUERY_SHARED_LIST, (db, p) => {
    /* 同 count：JOIN life_simulations 父归属 + WHERE ls.tenant_id=? 隔离租户。 */
    return db.prepare<CollabSharedRow>(
      `SELECT ss.id, ss.simulation_id, ss.owner_user_id, ss.permission, ss.created_at
       FROM shared_simulations ss
       JOIN life_simulations ls ON ss.simulation_id = ls.id
       WHERE ss.shared_with_user_id = ? AND ls.tenant_id = ?
       ORDER BY ss.created_at DESC LIMIT ? OFFSET ?`,
    ).all(p.userId, p.tenantId, p.limit, p.offset);
  });

  registerQuery<CollabShareOwnerRow | null, CollabExistingShareParams>(COLLAB_QUERY_SHARE_OWNER, (db, p) => {
    return db.prepare<CollabShareOwnerRow>(
      'SELECT owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(p.simulationId, p.targetUserId) ?? null;
  });

  registerQuery<readonly CollabShareForSimulationRow[], CollabSharesForSimulationParams>(COLLAB_QUERY_SHARES_FOR_SIMULATION, (db, p) => {
    return db.prepare<CollabShareForSimulationRow>(
      'SELECT id, shared_with_user_id, permission, created_at FROM shared_simulations WHERE simulation_id = ? ORDER BY created_at DESC',
    ).all(p.simulationId);
  });

  registerCommand<CollabUpdatePermissionParams>(COLLAB_CMD_UPDATE_PERMISSION, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE shared_simulations SET permission = ?, updated_at = ? WHERE id = ?',
    ).run(p.permission, p.now, p.shareId);
    return { rowsAffected: result.changes };
  });

  registerCommand<CollabCreateShareParams>(COLLAB_CMD_CREATE_SHARE, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO shared_simulations (id, simulation_id, owner_user_id, shared_with_user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(p.id, p.simulationId, p.ownerUserId, p.targetUserId, p.permission, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<CollabDeleteShareParams>(COLLAB_CMD_DELETE_SHARE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).run(p.simulationId, p.targetUserId);
    return { rowsAffected: result.changes };
  });
}
