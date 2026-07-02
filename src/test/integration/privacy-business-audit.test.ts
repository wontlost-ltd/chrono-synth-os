/**
 * F5（全维度评审）——privacy export/erase 的**业务审计留痕**（GDPR Art.12 知情权 + SOC2 CC6.1 证据链）。
 *
 * 修复前：POST /privacy/export、DELETE /privacy/data 只有通用 request 级审计（actionType='privacy'，无
 * target/payload/结果），缺可证明「谁在何时对哪些数据做了什么、结果如何」的业务审计事件。
 * 修复=路由层对这些关键操作调 recordBusinessAuditLog 写不可篡改 hash-chain 审计链，payload 仅放非敏感元数据。
 * 本测起真实 app、调端点，断言审计链里出现对应 business 事件。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { queryAuditLog } from '../../audit/audit-log-store.js';

describe('F5 privacy export/erase 业务审计留痕', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });
  afterEach(async () => { await app.close(); os.close(); });

  function businessEvents(actionType: string) {
    return queryAuditLog(os.getDatabase(), { tenantId: 'default', eventKind: 'business', actionType });
  }

  it('★DELETE /privacy/data → 写 privacy.erase.completed 业务审计（含删除计数元数据）', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/privacy/data' });
    assert.equal(res.statusCode, 200);
    const events = businessEvents('privacy.erase.completed');
    assert.equal(events.length, 1, '应有 1 条 erase 业务审计');
    assert.equal(events[0].eventKind, 'business');
    assert.equal(events[0].targetType, 'tenant_data');
    assert.equal(events[0].actorType, 'user');
  });

  it('★POST /privacy/export → 写 privacy.export.completed 业务审计（含 exportId/tableCount）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/privacy/export' });
    assert.equal(res.statusCode, 200);
    const events = businessEvents('privacy.export.completed');
    assert.equal(events.length, 1, '应有 1 条 export 业务审计');
    assert.equal(events[0].targetType, 'tenant_data');
    /* targetId = exportId（exp_ 前缀），可与响应体的 exportId 对上。 */
    const body = res.json() as { data: { exportId: string } };
    assert.equal(events[0].targetId, body.data.exportId, '审计 targetId = 导出 id');
  });

  it('★POST /privacy/export/start → 写 privacy.export.started 业务审计', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/privacy/export/start' });
    assert.equal(res.statusCode, 200);
    assert.equal(businessEvents('privacy.export.started').length, 1, '应有 1 条 export.started 业务审计');
  });
});
