/**
 * earn→distill 闭环端到端（WP-0）：完成市场任务 → 经路由回调 → earningDistiller 蒸馏 →
 * 蒸馏门 → core value 候选/编译。锁住「挣钱完成会经蒸馏门影响核心人格，而非绕过」。
 *
 * 之前的 autonomous-earning-e2e 只验证「能 apply 任务」；这里补上「完成后自动蒸馏进内核」这一段。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const TENANT = 'default';

function sign(app: FastifyInstance, payload: Record<string, unknown>): string {
  return (app as unknown as { jwt: { sign: (p: Record<string, unknown>) => string } }).jwt.sign(payload);
}

describe('earn→distill 闭环（WP-0）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    const db = os.getDatabase();
    const now = Date.now();
    /* worker owner + publisher 两个用户（避免自接自发）。 */
    db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('u_worker', 'w@e.com', 'h', 'admin', TENANT, now, now);
    db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('u_pub', 'p@e.com', 'h', 'admin', TENANT, now, now);
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  function workerHeaders() {
    return { authorization: `Bearer ${sign(app, { sub: 'u_worker', tenantId: TENANT, role: 'admin' })}`, 'x-tenant-id': TENANT };
  }
  function pubHeaders() {
    return { authorization: `Bearer ${sign(app, { sub: 'u_pub', tenantId: TENANT, role: 'admin' })}`, 'x-tenant-id': TENANT };
  }

  it('完成高质量任务 → core value 经蒸馏门被强化（不绕过门）', async () => {
    /* 0. 给 tenant core-self 播一个价值（新建 OS 默认无 values；resolver 兜底强化它）。 */
    const seeded = os.core.addValue('research', 0.5);

    /* 1. worker 建 persona。 */
    const pRes = await app.inject({
      method: 'POST', url: '/api/v1/persona-core', headers: workerHeaders(),
      payload: { displayName: 'Worker', profile: { mission: 'research' } },
    });
    assert.equal(pRes.statusCode, 201, pRes.body);
    const personaId = JSON.parse(pRes.body).data.id as string;

    /* 2. 记下 core 蒸馏前的状态。 */
    const before = [...os.core.values.getAll().values()];
    assert.ok(before.some((v) => v.id === seeded.id), 'seeded value 应在 core');
    const candidatesBefore = os.distillation.listCandidates(personaId).length;

    /* 3. publisher 发任务 → worker 接 → 完成（高质量 0.95 → 强信号，应自动编译进核心）。 */
    const tRes = await app.inject({
      method: 'POST', url: '/api/v1/marketplace/tasks', headers: pubHeaders(),
      payload: { title: 'Research gig', description: 'analyze', category: 'research', reward: 50 },
    });
    assert.equal(tRes.statusCode, 201, tRes.body);
    const taskId = JSON.parse(tRes.body).data.id as string;

    await app.inject({
      method: 'POST', url: `/api/v1/marketplace/tasks/${taskId}/accept`, headers: workerHeaders(),
      payload: { personaId },
    });
    const cRes = await app.inject({
      method: 'POST', url: `/api/v1/marketplace/tasks/${taskId}/complete`, headers: workerHeaders(),
      payload: { qualityScore: 0.95 },
    });
    assert.equal(cRes.statusCode, 200, cRes.body);

    /* 4. 闭环断言：蒸馏被触发——要么某 core value 权重上升（强信号自动编译），要么产生了候选。
     *    关键是「挣钱完成确实经蒸馏门作用到了核心人格」，不是只动 marketplace 标量。 */
    const after = [...os.core.values.getAll().values()];
    const candidatesAfter = os.distillation.listCandidates(personaId).length;
    const someWeightRose = after.some((v) => {
      const prev = before.find((b) => b.id === v.id);
      return prev !== undefined && v.weight > prev.weight;
    });
    assert.ok(
      someWeightRose || candidatesAfter > candidatesBefore,
      `earn→distill 应触发：core 权重上升或产生候选。before=${before.map((v) => v.weight)} after=${after.map((v) => v.weight)} cand ${candidatesBefore}→${candidatesAfter}`,
    );
  });

  it('完成低质量任务（<0.5）→ 不产成长候选（不奖励烂活）', async () => {
    const pRes = await app.inject({
      method: 'POST', url: '/api/v1/persona-core', headers: workerHeaders(),
      payload: { displayName: 'Worker2', profile: { mission: 'research' } },
    });
    const personaId = JSON.parse(pRes.body).data.id as string;
    const candBefore = os.distillation.listCandidates(personaId).length;

    const tRes = await app.inject({
      method: 'POST', url: '/api/v1/marketplace/tasks', headers: pubHeaders(),
      payload: { title: 'Low gig', description: 'x', category: 'research', reward: 10 },
    });
    const taskId = JSON.parse(tRes.body).data.id as string;
    await app.inject({ method: 'POST', url: `/api/v1/marketplace/tasks/${taskId}/accept`, headers: workerHeaders(), payload: { personaId } });
    const cRes = await app.inject({
      method: 'POST', url: `/api/v1/marketplace/tasks/${taskId}/complete`, headers: workerHeaders(),
      payload: { qualityScore: 0.3 },
    });
    assert.equal(cRes.statusCode, 200, cRes.body);

    /* 低质量：distiller 内部 <0.5 直接 return，不产候选。 */
    assert.equal(os.distillation.listCandidates(personaId).length, candBefore, '低质量不应产成长候选');
  });
});
