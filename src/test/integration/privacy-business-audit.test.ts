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

  it('★POST /privacy/import/commit 无效 token → 403 + 写 privacy.import.failed 业务审计（F5 debt）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/privacy/import/commit',
      payload: { manifestJson: '{}', commitToken: 'bogus-token-not-issued' },
    });
    assert.equal(res.statusCode, 403, '无效 commit token → 403');
    const events = businessEvents('privacy.import.failed');
    assert.equal(events.length, 1, '应有 1 条 import.failed 业务审计');
    assert.equal(events[0].targetType, 'tenant_data');
  });

  it('★v2 portability import 同级审计★：POST /api/v2/portability/import 无效 token → 403 + import.failed（Codex 复审补：v2 不得绕过审计）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v2/portability/import',
      payload: { manifestJson: '{}', commitToken: 'bogus-token-not-issued' },
    });
    assert.equal(res.statusCode, 403, 'v2 无效 commit token → 403');
    /* v1 + v2 各一条 import.failed（同类操作都留审计，无绕过）。 */
    assert.equal(businessEvents('privacy.import.failed').length, 1, 'v2 也应写 import.failed 业务审计');
  });
});

/* 审计回归（前后端契约两侧对读）：ExportCard 为 partial 状态渲染下载入口，
 * 而 /export/:id/download 原先硬拒非 completed → 该按钮必得 409。
 *
 * 这个缺口是我修「completed 的 file:// 断链」时引入的：把「一律走同源端点」
 * 也套到了 partial 分支上，却没核对端点是否接受该状态。前端测试还把这个坏
 * href 断言成了预期行为，等于用测试把 bug 焊死。
 * 教训：前后端契约缺陷必须**两侧对读**，只验一侧的渲染不算验证。 */
describe('导出下载端点的状态机（partial 亦有产物）', () => {
  let os2: ChronoSynthOS;
  let app2: FastifyInstance;
  const cfg = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    os2 = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os2.start();
    app2 = await createApp({ os: os2, config: cfg });
  });
  afterEach(async () => { await app2.close(); os2.close(); });

  /** 直接插一行指定状态的导出任务（带内联 manifest 作为产物）。 */
  function seedJob(id: string, state: string): void {
    os2.getDatabase().prepare<void>(
      `INSERT INTO export_jobs (id, tenant_id, state, percent, created_at, completed_at, pack_json)
       VALUES (?, 'default', ?, 100, 1000, 2000, ?)`,
    ).run(id, state, JSON.stringify({ manifest: { schemaVersion: 'x' } }));
  }

  it('★partial 状态可下载（不得 409）——前端为它渲染了下载入口', async () => {
    seedJob('exp_partial', 'partial');
    const res = await app2.inject({ method: 'GET', url: '/api/v1/privacy/export/exp_partial/download' });
    assert.notEqual(res.statusCode, 409, 'partial 是终态且有产物，必须可取走已导出部分');
    assert.equal(res.statusCode, 200);
  });

  it('completed 状态可下载（回归保护）', async () => {
    seedJob('exp_done', 'completed');
    const res = await app2.inject({ method: 'GET', url: '/api/v1/privacy/export/exp_done/download' });
    assert.equal(res.statusCode, 200);
  });

  it('running / queued 仍拒（未完成确实无产物）', async () => {
    seedJob('exp_running', 'running');
    seedJob('exp_queued', 'queued');
    for (const id of ['exp_running', 'exp_queued']) {
      const res = await app2.inject({ method: 'GET', url: `/api/v1/privacy/export/${id}/download` });
      assert.equal(res.statusCode, 409, `${id} 未完成应拒`);
    }
  });

  it('failed 仍拒（无产物可取）', async () => {
    seedJob('exp_failed', 'failed');
    const res = await app2.inject({ method: 'GET', url: '/api/v1/privacy/export/exp_failed/download' });
    assert.equal(res.statusCode, 409);
  });
});
