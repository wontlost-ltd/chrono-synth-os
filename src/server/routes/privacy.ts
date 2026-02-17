/**
 * 隐私与信任控制路由
 * POST /api/v1/privacy/export — 导出所有数据
 * DELETE /api/v1/privacy/data — 删除所有数据 (GDPR)
 * GET /api/v1/privacy/audit-trail — 审计日志
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { generatePrefixedId } from '../../utils/id-generator.js';
import { compilePersonaState } from '../../intelligence/persona-state.js';

export function registerPrivacyRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* POST /api/v1/privacy/export */
  app.post('/api/v1/privacy/export', async () => {
    const exportId = generatePrefixedId('exp');
    const persona = compilePersonaState(os.core);
    const snapshot = os.createSnapshot('manual');

    return {
      data: {
        exportId,
        format: 'json' as const,
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
          snapshotId: snapshot.id,
          exportedAt: os.getClock().now(),
        },
      },
    };
  });

  /* DELETE /api/v1/privacy/data — 按租户删除 */
  app.delete('/api/v1/privacy/data', async (request) => {
    const tenantId = request.tenantId;
    const db = os.getDatabase();
    const tenantTables = [
      'memory_edges', 'memory_embeddings', 'working_memory', 'memory_nodes',
      'core_values', 'survival_anchors', 'persona_versions', 'conflicts',
      'snapshots', 'evolution_records', 'audit_log',
    ] as const;
    const singletonTables = ['narrative', 'decision_style', 'cognitive_model'] as const;
    db.transaction(() => {
      for (const table of tenantTables) {
        db.prepare<void>(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
      }
      for (const table of singletonTables) {
        db.prepare<void>(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
      }
      /* 队列表（v008 迁移后存在） */
      try { db.prepare<void>('DELETE FROM tasks WHERE tenant_id = ?').run(tenantId); } catch { /* 表可能不存在 */ }
      try { db.prepare<void>('DELETE FROM quota_usage WHERE tenant_id = ?').run(tenantId); } catch { /* 表可能不存在 */ }
      try { db.prepare<void>('DELETE FROM quota_limits WHERE tenant_id = ?').run(tenantId); } catch { /* 表可能不存在 */ }
    });
    return { data: { deleted: true, timestamp: os.getClock().now() } };
  });

  /* GET /api/v1/privacy/audit-trail */
  app.get('/api/v1/privacy/audit-trail', async () => {
    const db = os.getDatabase();
    const rows = db.prepare<{
      id: string;
      timestamp: number;
      method: string;
      path: string;
      request_id: string;
      status_code: number;
      latency_ms: number;
      api_key_hash: string | null;
    }>('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 100').all();
    return { data: rows };
  });
}
