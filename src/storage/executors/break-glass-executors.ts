/**
 * Break-glass JTI 消费账本 SQL 执行器
 *
 * 使用 ON CONFLICT (tenant_id, jti) DO NOTHING 而非 SQLite 专用的
 * INSERT OR IGNORE，保持 SQLite/Postgres 同一份语句；SQLite 自
 * 3.24 起即支持该 ANSI 语法（IDatabase 已在构造时校验最低版本）。
 *
 * 命令返回 rowsAffected：1 = 首次写入（消费成功），0 = 冲突（重放）。
 */

import { registerCommand } from '../legacy-sync-bridge.js';
import {
  BG_CMD_INSERT_CONSUMPTION,
  BG_CMD_PRUNE_CONSUMPTIONS,
} from '@chrono/kernel';
import type {
  BreakGlassInsertConsumptionParams,
  BreakGlassPruneConsumptionsParams,
} from '@chrono/kernel';

export function registerBreakGlassExecutors(): void {
  registerCommand<BreakGlassInsertConsumptionParams>(BG_CMD_INSERT_CONSUMPTION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO break_glass_jti_consumptions
         (id, tenant_id, jti, token_scope, consumed_at, consumed_by, request_ip, audit_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, jti) DO NOTHING`,
    ).run(
      p.id,
      p.tenantId,
      p.jti,
      p.scope,
      p.consumedAt,
      p.consumedBy,
      p.requestIp,
      p.auditSeq,
    );
    return { rowsAffected: Number(result.changes) };
  });

  registerCommand<BreakGlassPruneConsumptionsParams>(BG_CMD_PRUNE_CONSUMPTIONS, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM break_glass_jti_consumptions WHERE consumed_at < ?',
    ).run(p.before);
    return { rowsAffected: Number(result.changes) };
  });
}
