/**
 * Integration test for the P2.7 dashboards endpoint.
 *
 * Locks down the JSON shape that chrono-synth-web's PersonaHealth
 * scaffold reads. Real aggregation (d7 / d30 historical comparison)
 * lands in a follow-up PR; this test pins the contract against the
 * stub so the frontend doesn't break when historical data arrives.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('GET /api/v1/admin/dashboards/persona/:personaId', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    auth: { enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('returns the full PersonaHealth shape with all 5 series for an unknown persona', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboards/persona/unknown-persona-id',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      data: {
        personaId: string;
        values: unknown[];
        decisionTrend: unknown[];
        memoryStack: unknown[];
        toolMix: unknown[];
        driftTimeline: unknown[];
        generatedAt: number;
      };
    };

    assert.equal(body.data.personaId, 'unknown-persona-id');
    assert.ok(Array.isArray(body.data.values), 'values is array');
    assert.ok(Array.isArray(body.data.decisionTrend), 'decisionTrend is array');
    assert.ok(Array.isArray(body.data.memoryStack), 'memoryStack is array');
    assert.ok(Array.isArray(body.data.toolMix), 'toolMix is array');
    assert.ok(Array.isArray(body.data.driftTimeline), 'driftTimeline is array');
    assert.equal(typeof body.data.generatedAt, 'number');
    assert.ok(body.data.generatedAt > 0);
  });

  /* 审计 Critical：buildMemoryStack 忽略 _tenantId/_personaId，SQL 只按时间过滤，
   * 租户 A 请求 dashboard 会看到含租户 B 记忆的统计。 */
  it('memoryStack 必须按租户+persona 过滤（跨租户泄漏回归）', async () => {
    const db = os.getDatabase();
    /* 用真实当下时间：路由按 Date.now() 算 30 天窗口，1970 的时间戳会落在窗口外。 */
    const now = Date.now();
    /* 直接落两条记忆：一条属 default/persona-x，一条属他租户。 */
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, tenant_id, persona_id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m-own', 'default', 'persona-x', 'episodic', '本租户记忆', 0, 0.5, now, now, 0, 0.0001, now);
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, tenant_id, persona_id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m-other', 'tenant-other', 'persona-y', 'episodic', '他租户记忆', 0, 0.5, now, now, 0, 0.0001, now);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboards/persona/persona-x',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { data: { memoryStack: Array<{ episodic: number }> } };

    const totalEpisodic = body.data.memoryStack.reduce((sum, p) => sum + p.episodic, 0);
    assert.equal(totalEpisodic, 1, `只应统计本租户本 persona 的 1 条记忆，实际 ${totalEpisodic}（>1 即跨租户泄漏）`);
  });
});