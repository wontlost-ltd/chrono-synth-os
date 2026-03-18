/**
 * 更新闸门 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { PendingUpdateRow, UgateProposeParams, UgateSetStatusParams } from '@chrono/kernel';
import {
  UGATE_QUERY_BY_ID, UGATE_QUERY_PENDING,
  UGATE_CMD_PROPOSE, UGATE_CMD_SET_STATUS,
} from '@chrono/kernel';

export function registerUpdateGateExecutors(): void {
  /* ── Queries ── */

  registerQuery<PendingUpdateRow | null, string>(UGATE_QUERY_BY_ID, (db, id) => {
    return db.prepare<PendingUpdateRow>(
      'SELECT * FROM pending_updates WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<PendingUpdateRow, string>(UGATE_QUERY_PENDING, (db, status) => {
    return db.prepare<PendingUpdateRow>(
      'SELECT * FROM pending_updates WHERE status = ? ORDER BY created_at',
    ).all(status) as unknown as PendingUpdateRow;
  });

  /* ── Commands ── */

  registerCommand<UgateProposeParams>(UGATE_CMD_PROPOSE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO pending_updates
      (id, layer, trigger_type, target_id, current_value, proposed_value, delta, reason, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.layer, p.triggerType, p.targetId, p.currentValue, p.proposedValue, p.delta, p.reason, p.createdAt, p.status);
    return { rowsAffected: result.changes };
  });

  registerCommand<UgateSetStatusParams>(UGATE_CMD_SET_STATUS, (db, p) => {
    const result = db.prepare<void>(
      "UPDATE pending_updates SET status = ? WHERE id = ? AND status = 'pending'",
    ).run(p.status, p.id);
    return { rowsAffected: result.changes };
  });
}
