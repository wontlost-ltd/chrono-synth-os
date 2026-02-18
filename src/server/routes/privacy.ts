/**
 * 隐私与信任控制路由 (GDPR / 数据可移植性)
 * POST /api/v1/privacy/export — 导出租户所有数据
 * DELETE /api/v1/privacy/data — 删除租户所有数据 (Right to Erasure)
 * GET /api/v1/privacy/audit-trail — 审计日志
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { IDatabase, SqlValue } from '../../storage/database.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { generatePrefixedId } from '../../utils/id-generator.js';
import { compilePersonaState } from '../../intelligence/persona-state.js';

/** 直接按 tenant_id 查询的表（外键依赖顺序：子表在前） */
const TENANT_TABLES = [
  'decision_feedbacks', 'decision_runs', 'decision_cases',
  'onboarding_sessions', 'llm_usage',
  'life_simulations',
  'memory_edges', 'memory_embeddings', 'working_memory', 'memory_nodes',
  'pending_updates',
  'core_values', 'survival_anchors', 'persona_versions', 'conflicts',
  'snapshots', 'evolution_records',
  'narrative', 'decision_style', 'cognitive_model',
  'tasks', 'quota_usage', 'quota_limits',
  'usage_records', 'subscriptions',
  'audit_log',
] as const;

/** 需要子查询关联的表 */
const RELATED_TABLES: Array<{
  name: string;
  exportSql: string;
  deleteSql: string;
  params: (tenantId: string) => SqlValue[];
}> = [
  {
    name: 'life_simulation_paths',
    exportSql: 'SELECT p.* FROM life_simulation_paths p INNER JOIN life_simulations s ON p.simulation_id = s.id WHERE s.tenant_id = ?',
    deleteSql: 'DELETE FROM life_simulation_paths WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'shared_simulations',
    exportSql: 'SELECT * FROM shared_simulations WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?) OR owner_user_id IN (SELECT id FROM users WHERE tenant_id = ?) OR shared_with_user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    deleteSql: 'DELETE FROM shared_simulations WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?) OR owner_user_id IN (SELECT id FROM users WHERE tenant_id = ?) OR shared_with_user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    params: (t) => [t, t, t],
  },
  {
    name: 'refresh_tokens',
    exportSql: 'SELECT id, user_id, is_revoked, expires_at, created_at FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    deleteSql: 'DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'users',
    exportSql: 'SELECT id, email, role, tenant_id, created_at, updated_at FROM users WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM users WHERE tenant_id = ?',
    params: (t) => [t],
  },
];

function safeDelete(db: IDatabase, table: string, tenantId: string): number {
  try {
    return db.prepare<void>(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId).changes;
  } catch {
    return 0;
  }
}

function safeDeleteQuery(db: IDatabase, sql: string, params: SqlValue[]): number {
  try {
    return db.prepare<void>(sql).run(...params).changes;
  } catch {
    return 0;
  }
}

function exportTable(db: IDatabase, table: string, tenantId: string): unknown[] {
  try {
    return db.prepare<Record<string, unknown>>(`SELECT * FROM ${table} WHERE tenant_id = ?`).all(tenantId);
  } catch {
    return [];
  }
}

function exportQuery(db: IDatabase, sql: string, params: SqlValue[]): unknown[] {
  try {
    return db.prepare<Record<string, unknown>>(sql).all(...params);
  } catch {
    return [];
  }
}

export function registerPrivacyRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory?: TenantOSFactory,
): void {
  function getOS(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  /* POST /api/v1/privacy/export — 完整租户数据导出 */
  app.post('/api/v1/privacy/export', async (request) => {
    const tenantId = request.tenantId;
    const exportId = generatePrefixedId('exp');
    const db = os.getDatabase();
    const tenantOS = getOS(tenantId);
    const persona = compilePersonaState(tenantOS.core);

    const tables: Record<string, unknown[]> = {};
    for (const table of TENANT_TABLES) {
      const rows = exportTable(db, table, tenantId);
      if (rows.length > 0) tables[table] = rows;
    }
    for (const rel of RELATED_TABLES) {
      const rows = exportQuery(db, rel.exportSql, rel.params(tenantId));
      if (rows.length > 0) tables[rel.name] = rows;
    }

    return {
      data: {
        exportId,
        tenantId,
        format: 'json' as const,
        exportedAt: tenantOS.getClock().now(),
        content: {
          persona: {
            L0: persona.L0,
            L1: [...persona.L1.values()],
            L2: persona.L2,
            L3: {
              beliefs: Object.fromEntries(persona.L3.beliefs),
              biasWeights: Object.fromEntries(persona.L3.biasWeights),
              attributionStyle: persona.L3.attributionStyle,
              growthMindset: persona.L3.growthMindset,
            },
            L4: {
              narrative: persona.L4.narrative,
              memoryCount: persona.L4.memories.size,
            },
          },
          tables,
        },
      },
    };
  });

  /* DELETE /api/v1/privacy/data — GDPR Right to Erasure */
  app.delete('/api/v1/privacy/data', async (request) => {
    const tenantId = request.tenantId;
    const db = os.getDatabase();
    const deletedCounts: Record<string, number> = {};

    db.transaction(() => {
      /* 关联表优先（子查询依赖父表数据） */
      for (const rel of RELATED_TABLES) {
        const count = safeDeleteQuery(db, rel.deleteSql, rel.params(tenantId));
        if (count > 0) deletedCounts[rel.name] = count;
      }
      for (const table of TENANT_TABLES) {
        const count = safeDelete(db, table, tenantId);
        if (count > 0) deletedCounts[table] = count;
      }
    });

    /* 驱逐缓存中的租户 OS 实例，防止内存残留 */
    if (tenantFactory) {
      tenantFactory.evict(tenantId);
    }

    return {
      data: {
        deleted: true,
        tenantId,
        timestamp: os.getClock().now(),
        tablesAffected: deletedCounts,
      },
    };
  });

  /* GET /api/v1/privacy/audit-trail — 租户审计日志（分页） */
  app.get('/api/v1/privacy/audit-trail', async (request) => {
    const tenantId = request.tenantId;
    const { page, pageSize } = request.query as { page?: string; pageSize?: string };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const ps = Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20));
    const offset = (p - 1) * ps;

    const db = os.getDatabase();
    const total = db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log WHERE tenant_id = ?',
    ).get(tenantId)?.count ?? 0;
    const rows = db.prepare<Record<string, unknown>>(
      'SELECT id, timestamp, method, path, request_id, status_code, latency_ms, api_key_hash FROM audit_log WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
    ).all(tenantId, ps, offset);
    return {
      data: rows,
      pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) || 1 },
    };
  });
}
