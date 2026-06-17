/**
 * 决策风格 SQL 执行器
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import { DECISION_STYLE_QUERY_GET, DECISION_STYLE_QUERY_LIST_ALL, DECISION_STYLE_CMD_SET } from '@chrono/kernel';
import type {
  DecisionStyleGetParams, DecisionStyleSetParams, DecisionStyleRow, DecisionStyleAllRow,
} from '@chrono/kernel';

interface StyleDbRow {
  style_json: string;
  updated_at: number;
}

interface StyleAllDbRow {
  tenant_id: string;
  style_json: string;
}

export function registerDecisionStyleExecutors(): void {
  registerQuery<DecisionStyleRow | null, DecisionStyleGetParams>(DECISION_STYLE_QUERY_GET, (db: IDatabase, params) => {
    const row = db.prepare<StyleDbRow>(
      'SELECT style_json, updated_at FROM decision_style WHERE tenant_id = ?',
    ).get(params.tenantId);
    if (!row) return null;
    return { styleJson: row.style_json, updatedAt: row.updated_at };
  });

  /* 跨租户平台聚合：列出所有租户决策风格（合法全局统计，见 kernel decisionStyleListAll 注释）。 */
  registerQuery<readonly DecisionStyleAllRow[], Record<string, never>>(DECISION_STYLE_QUERY_LIST_ALL, (db: IDatabase) => {
    const rows = db.prepare<StyleAllDbRow>(
      'SELECT tenant_id, style_json FROM decision_style',
    ).all();
    return rows.map((r) => ({ tenantId: r.tenant_id, styleJson: r.style_json }));
  });

  registerCommand<DecisionStyleSetParams>(DECISION_STYLE_CMD_SET, (db: IDatabase, p) => {
    db.prepare<void>(
      `INSERT INTO decision_style (tenant_id, style_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET style_json = excluded.style_json, updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.styleJson, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
