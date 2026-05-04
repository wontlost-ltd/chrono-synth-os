import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('端到端工作流', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('完整流程：创建价值 → 分叉人格 → 模拟 → 调控 → 演化 → 快照 → 修改 → 恢复 → 验证', async () => {
    /* 1. 创建核心价值 */
    const createValueRes = await app.inject({
      method: 'POST',
      url: '/api/v1/values',
      payload: { label: '诚实', weight: 0.8 },
    });
    assert.equal(createValueRes.statusCode, 201);
    JSON.parse(createValueRes.body).data;

    const createValue2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/values',
      payload: { label: '勇气', weight: 0.6 },
    });
    assert.equal(createValue2Res.statusCode, 201);

    /* 2. 更新叙事 */
    const narrativeRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/narrative',
      payload: { content: '追求真理的数字人格' },
    });
    assert.equal(narrativeRes.statusCode, 200);

    /* 3. 分叉人格 */
    const forkRes = await app.inject({
      method: 'POST',
      url: '/api/v1/personas/fork',
      payload: { label: '探索者', resourceQuota: 0.3 },
    });
    assert.equal(forkRes.statusCode, 201);
    const persona = JSON.parse(forkRes.body).data;

    /* 4. 运行模拟 */
    const simRes = await app.inject({
      method: 'POST',
      url: '/api/v1/personas/simulate',
      payload: {
        personaId: persona.id,
        scenario: { id: 'test-scenario', description: '测试场景', params: {} },
      },
    });
    assert.equal(simRes.statusCode, 200);
    const simResult = JSON.parse(simRes.body).data;
    assert.ok(typeof simResult.fitnessScore === 'number');

    /* 5. 完成人格 */
    const statusRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/personas/${persona.id}/status`,
      payload: { status: 'completed' },
    });
    assert.equal(statusRes.statusCode, 200);

    /* 6. 运行调控 */
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/regulation/run',
      payload: { strategy: 'equal' },
    });
    assert.equal(regRes.statusCode, 200);

    /* 7. 运行演化 */
    const evoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/evolution/run',
    });
    assert.equal(evoRes.statusCode, 200);
    const evoResult = JSON.parse(evoRes.body).data;
    assert.ok(typeof evoResult.mergedCount === 'number');

    /* 8. 创建快照 */
    const snapRes = await app.inject({
      method: 'POST',
      url: '/api/v1/snapshots',
      payload: { reason: 'manual' },
    });
    assert.equal(snapRes.statusCode, 201);
    const snapshot = JSON.parse(snapRes.body).data;

    /* 9. 修改状态（应被恢复覆盖） */
    await app.inject({
      method: 'PUT',
      url: '/api/v1/narrative',
      payload: { content: '修改后的叙事' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/values',
      payload: { label: '新增价值', weight: 0.5 },
    });

    /* 验证修改已生效 */
    const narCheck = await app.inject({ method: 'GET', url: '/api/v1/narrative' });
    assert.equal(JSON.parse(narCheck.body).data.content, '修改后的叙事');

    /* 10. 从快照恢复 */
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/v1/snapshots/${snapshot.id}/restore`,
    });
    assert.equal(restoreRes.statusCode, 200);

    /* 11. 验证状态回滚 */
    const narAfter = await app.inject({ method: 'GET', url: '/api/v1/narrative' });
    assert.equal(JSON.parse(narAfter.body).data.content, '追求真理的数字人格');

    const valuesAfter = await app.inject({ method: 'GET', url: '/api/v1/values' });
    const valuesData = JSON.parse(valuesAfter.body).data;
    /* 恢复后应只有快照时的 2 个价值，不包含新增的 */
    assert.equal(Object.keys(valuesData).length, 2);

    /* 12. 获取快照列表确认存在 */
    const snapList = await app.inject({ method: 'GET', url: '/api/v1/snapshots' });
    const snaps = JSON.parse(snapList.body).data;
    assert.ok(snaps.length >= 1);

    /* 13. 验证冲突列表可用 */
    const conflictsRes = await app.inject({ method: 'GET', url: '/api/v1/conflicts' });
    assert.equal(conflictsRes.statusCode, 200);

    /* 14. 验证指标端点可用 */
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(metricsRes.statusCode, 200);
    const metrics = JSON.parse(metricsRes.body);
    assert.ok(metrics.requests.total > 0);
  });
});
