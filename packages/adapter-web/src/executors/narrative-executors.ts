/**
 * Web adapter: narrative executors.
 *
 * K2(ADR-0056)：按 (tenant_id, persona_id) 寻址——同租户多 persona 各有独立自我叙事，互不覆盖
 * （与 SQLite executor ON CONFLICT(tenant_id, persona_id) 读写对称）。
 */

import {
  NARRATIVE_QUERY_GET,
  NARRATIVE_CMD_SET,
  type NarrativeGetParams,
  type NarrativeSetParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'narrative';

interface NarrativeRow {
  id: string;
  tenant_id: string;
  persona_id: string;
  content: string;
  updated_at: number;
}

export function registerNarrativeExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<string, NarrativeGetParams>(NARRATIVE_QUERY_GET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    /* 旧 web 快照行无 persona_id（hydrate 无 backfill）→ 视为 'default'，向后兼容旧本地数据。 */
    const row = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId && (r['persona_id'] ?? 'default') === p.personaId);
    return row ? String((row as unknown as NarrativeRow).content ?? '') : null;
  });

  registry.registerCommand<NarrativeSetParams>(NARRATIVE_CMD_SET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    /* 旧 web 快照行无 persona_id → 视为 'default'，让旧 default 行被 upsert 命中并补写 persona_id。 */
    const existing = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId && (r['persona_id'] ?? 'default') === p.personaId);
    /* id 含 persona——同租户不同 persona 不同行，互不覆盖。 */
    const id = existing?.['id'] !== undefined ? String(existing['id']) : `narr_${p.tenantId}_${p.personaId}`;
    tables.upsert(TABLE, {
      id,
      tenant_id: p.tenantId,
      persona_id: p.personaId,
      content: p.content,
      updated_at: p.updatedAt,
    });
    return { rowsAffected: 1 };
  });
}
