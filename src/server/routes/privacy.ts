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

  /* DELETE /api/v1/privacy/data */
  app.delete('/api/v1/privacy/data', async () => {
    const db = os.getDatabase();
    db.transaction(() => {
      db.exec('DELETE FROM memory_edges');
      db.exec('DELETE FROM memory_embeddings');
      db.exec('DELETE FROM working_memory');
      db.exec('DELETE FROM memory_nodes');
      db.exec('DELETE FROM core_values');
      db.exec('DELETE FROM narrative');
      db.exec('DELETE FROM survival_anchors');
      db.exec('DELETE FROM decision_style');
      db.exec('DELETE FROM cognitive_model');
      db.exec('DELETE FROM persona_versions');
      db.exec('DELETE FROM conflicts');
      db.exec('DELETE FROM snapshots');
      db.exec('DELETE FROM evolution_records');
      db.exec('DELETE FROM audit_log');
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
