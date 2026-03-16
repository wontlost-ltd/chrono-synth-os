/**
 * 叙事 SQL 执行器
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import { NARRATIVE_QUERY_GET, NARRATIVE_CMD_SET } from '@chrono/kernel';
import type { NarrativeGetParams, NarrativeSetParams } from '@chrono/kernel';

interface NarrativeRow {
  content: string;
}

export function registerNarrativeExecutors(): void {
  registerQuery<string, NarrativeGetParams>(NARRATIVE_QUERY_GET, (db: IDatabase, params) => {
    const row = db.prepare<NarrativeRow>(
      'SELECT content FROM narrative WHERE tenant_id = ?',
    ).get(params.tenantId);
    return row?.content ?? '';
  });

  registerCommand<NarrativeSetParams>(NARRATIVE_CMD_SET, (db: IDatabase, p) => {
    db.prepare<void>(
      `INSERT INTO narrative (tenant_id, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.content, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
