/**
 * Web adapter: decision-style executors.
 *
 * K2(ADR-0056)：按 (tenant_id, persona_id) 寻址——同租户多 persona 各有独立决策风格，互不覆盖
 * （与 SQLite executor ON CONFLICT(tenant_id, persona_id) 读写对称）。
 * Returns null when not yet set, mirroring the SQLite executor's "first-call" semantics.
 */

import {
  DECISION_STYLE_QUERY_GET,
  DECISION_STYLE_CMD_SET,
  type DecisionStyleGetParams,
  type DecisionStyleRow,
  type DecisionStyleSetParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'decision_style';

export function registerDecisionStyleExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<DecisionStyleRow, DecisionStyleGetParams>(
    DECISION_STYLE_QUERY_GET,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      /* 旧 web 快照行无 persona_id（hydrate 无 backfill）→ 视为 'default'，向后兼容旧本地数据。 */
      const row = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId && (r['persona_id'] ?? 'default') === p.personaId);
      if (!row) return null;
      return {
        styleJson: row['style_json'] === null || row['style_json'] === undefined ? null : String(row['style_json']),
        updatedAt: Number(row['updated_at'] ?? 0),
      };
    },
  );

  registry.registerCommand<DecisionStyleSetParams>(DECISION_STYLE_CMD_SET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    /* 旧 web 快照行无 persona_id → 视为 'default'，让旧 default 行被 upsert 命中并补写 persona_id。 */
    const existing = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId && (r['persona_id'] ?? 'default') === p.personaId);
    /* id 含 persona——同租户不同 persona 不同行，互不覆盖。 */
    const id = existing?.['id'] !== undefined ? String(existing['id']) : `ds_${p.tenantId}_${p.personaId}`;
    tables.upsert(TABLE, {
      id,
      tenant_id: p.tenantId,
      persona_id: p.personaId,
      style_json: p.styleJson,
      updated_at: p.updatedAt,
    });
    return { rowsAffected: 1 };
  });
}
