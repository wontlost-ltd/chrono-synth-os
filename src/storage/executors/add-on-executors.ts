/**
 * 附加组件 SQL 执行器
 */

import type { SqlValue } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  ADDON_QUERY_BY_CODE, ADDON_QUERY_BY_ID, ADDON_QUERY_LIST_ACTIVE,
  ADDON_QUERY_LIST_ALL, ADDON_QUERY_CODE_EXISTS,
  ADDON_CMD_SEED, ADDON_CMD_CREATE, ADDON_CMD_UPDATE, ADDON_CMD_DEACTIVATE,
} from '@chrono/kernel';
import type {
  AddOnRow, AddOnIdRow,
  AddOnSeedParams, AddOnCreateParams, AddOnUpdateParams, AddOnDeactivateParams,
} from '@chrono/kernel';

export function registerAddOnExecutors(): void {
  /* ── Queries ── */

  registerQuery<AddOnRow | null, string>(ADDON_QUERY_BY_CODE, (db, code) => {
    return db.prepare<AddOnRow>('SELECT * FROM add_ons WHERE code = ?').get(code) ?? null;
  });

  registerQuery<AddOnRow | null, string>(ADDON_QUERY_BY_ID, (db, id) => {
    return db.prepare<AddOnRow>('SELECT * FROM add_ons WHERE id = ?').get(id) ?? null;
  });

  registerQuery<readonly AddOnRow[], void>(ADDON_QUERY_LIST_ACTIVE, (db) => {
    return db.prepare<AddOnRow>('SELECT * FROM add_ons WHERE is_active = TRUE ORDER BY code').all();
  });

  registerQuery<readonly AddOnRow[], void>(ADDON_QUERY_LIST_ALL, (db) => {
    return db.prepare<AddOnRow>('SELECT * FROM add_ons ORDER BY code').all();
  });

  registerQuery<AddOnIdRow | null, string>(ADDON_QUERY_CODE_EXISTS, (db, code) => {
    return db.prepare<AddOnIdRow>('SELECT id FROM add_ons WHERE code = ?').get(code) ?? null;
  });

  /* ── Commands ── */

  registerCommand<AddOnSeedParams>(ADDON_CMD_SEED, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO add_ons (id, code, name, description, stripe_price_id, resource, quota_amount, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, TRUE, ?, ?)`,
    ).run(p.id, p.code, p.name, p.description, p.resource, p.quotaAmount, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AddOnCreateParams>(ADDON_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO add_ons (id, code, name, description, stripe_price_id, resource, quota_amount, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
    ).run(p.id, p.code, p.name, p.description, p.stripePriceId, p.resource, p.quotaAmount, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AddOnUpdateParams>(ADDON_CMD_UPDATE, (db, p) => {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [p.now];
    if (p.name !== undefined) { sets.push('name = ?'); params.push(p.name); }
    if (p.description !== undefined) { sets.push('description = ?'); params.push(p.description); }
    if (p.stripePriceId !== undefined) { sets.push('stripe_price_id = ?'); params.push(p.stripePriceId); }
    if (p.quotaAmount !== undefined) { sets.push('quota_amount = ?'); params.push(p.quotaAmount); }
    params.push(p.id);
    const result = db.prepare<void>(`UPDATE add_ons SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<AddOnDeactivateParams>(ADDON_CMD_DEACTIVATE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE add_ons SET is_active = FALSE, updated_at = ? WHERE id = ?',
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });
}
