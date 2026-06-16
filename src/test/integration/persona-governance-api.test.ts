/**
 * 集成测试：per-persona 治理策略配置 API（ADR-0048 治理可配化，PR-B）。
 *
 * GET/PUT/DELETE /api/v1/persona-core/:personaId/governance/policy — owner-only。
 * 证明：读回 effective+override、PUT sanitize 落库、非法 → 400、DELETE 恢复默认、owner 门控。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { registerEarningRoutes } from '../../server/routes/earning.js';
import { DEFAULT_EARNING_POLICY } from '@chrono/kernel';
import type { IDatabase } from '../../storage/index.js';
import type { PersonaEarningService } from '../../intelligence/persona-earning-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';

const OWNED = 'persona_owned';
const URL = `/api/v1/persona-core/${OWNED}/governance/policy`;

/** stub personaCore：仅 OWNED persona 对 user_1 可见（assertOwner 据此判 owner）。 */
function stubPersonaCore(): PersonaCoreService {
  return {
    getPersonaDetail: (_t: string, ownerUserId: string, personaId: string) =>
      ownerUserId === 'user_1' && personaId === OWNED ? { id: OWNED, marketplaceTasks: [] } : null,
  } as unknown as PersonaCoreService;
}

async function buildApp(db: IDatabase, user: { sub: string } = { sub: 'user_1' }): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const app = fastify();
  app.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: user.sub, planId: 'free', role: 'user' };
    (req as { tenantId?: string }).tenantId = 'default';
  });
  registerEarningRoutes(app, {
    earning: {} as unknown as PersonaEarningService,
    personaCore: stubPersonaCore(),
    db,
  });
  await app.ready();
  return app;
}

describe('per-persona 治理策略 API（ADR-0048 PR-B）', () => {
  let db: IDatabase;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    app = await buildApp(db);
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('GET 无覆盖 → override=null, effective=DEFAULT', async () => {
    const res = await app.inject({ method: 'GET', url: URL });
    assert.equal(res.statusCode, 200, res.body);
    const { data } = res.json();
    assert.equal(data.override, null);
    assert.equal(data.meta, null, '无覆盖时 meta=null');
    assert.equal(data.effective.maxAutonomousReward, DEFAULT_EARNING_POLICY.maxAutonomousReward);
  });

  it('PUT 合法覆盖 → 200，落库，effective 反映覆盖', async () => {
    const res = await app.inject({
      method: 'PUT', url: URL,
      payload: { maxAutonomousReward: 120, categoryRoutes: { coding: 'autonomous' } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { data } = res.json();
    assert.equal(data.override.maxAutonomousReward, 120);
    assert.equal(data.effective.maxAutonomousReward, 120);
    assert.deepEqual(data.effective.categoryRoutes, { coding: 'autonomous' });
    /* PUT 响应也带 meta（Codex 复审 Medium：保存后 last-updated 不消失）。 */
    assert.equal(data.meta.updatedBy, 'user_1');
    assert.ok(data.meta.updatedAt > 0);
    /* GET 再读应持久 + meta 反映谁改的。 */
    const get = await app.inject({ method: 'GET', url: URL });
    assert.equal(get.json().data.override.maxAutonomousReward, 120);
    assert.equal(get.json().data.meta.updatedBy, 'user_1', 'meta 记录改动者');
    assert.ok(get.json().data.meta.updatedAt > 0, 'meta 记录改动时间');
  });

  it('PUT 非法值 → 400 ValidationError（不落库）', async () => {
    const res = await app.inject({ method: 'PUT', url: URL, payload: { maxConcurrentTasks: 0 } });
    assert.equal(res.statusCode, 400, res.body);
    /* 未落库：GET 仍 override=null。 */
    assert.equal((await app.inject({ method: 'GET', url: URL })).json().data.override, null);
  });

  it('PUT 未知字段被丢弃（不落库脏数据）', async () => {
    const res = await app.inject({ method: 'PUT', url: URL, payload: { maxAutonomousReward: 60, bogus: 'x' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.override, { maxAutonomousReward: 60 });
  });

  it('DELETE → 恢复默认（override=null, effective=DEFAULT）', async () => {
    await app.inject({ method: 'PUT', url: URL, payload: { maxAutonomousReward: 120 } });
    const res = await app.inject({ method: 'DELETE', url: URL });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.override, null);
    assert.equal(res.json().data.meta, null, 'DELETE 后 meta=null');
    assert.equal(res.json().data.effective.maxAutonomousReward, DEFAULT_EARNING_POLICY.maxAutonomousReward);
  });

  it('乐观并发：If-Match 版本匹配 → 200；过期版本 → 409（防盲覆盖）', async () => {
    /* 第 1 次 PUT 建立 override + 拿到版本（updatedAt）。 */
    const first = await app.inject({ method: 'PUT', url: URL, payload: { maxAutonomousReward: 100 } });
    const version1 = first.json().data.meta.updatedAt;
    /* 用正确版本再 PUT → 200。 */
    const ok = await app.inject({ method: 'PUT', url: URL, headers: { 'if-match': String(version1) }, payload: { maxAutonomousReward: 110 } });
    assert.equal(ok.statusCode, 200, ok.body);
    const version2 = ok.json().data.meta.updatedAt;
    /* 用过期版本（version1）再 PUT → 409 冲突（别人已把它推进到 version2）。 */
    const stale = await app.inject({ method: 'PUT', url: URL, headers: { 'if-match': String(version1) }, payload: { maxAutonomousReward: 120 } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.match(stale.json().error, /version mismatch/);
    /* 冲突未落库：override 仍是 version2 时的值（110），不是冲突尝试的 120。 */
    const get = await app.inject({ method: 'GET', url: URL });
    assert.equal(get.json().data.override.maxAutonomousReward, 110, '冲突的 120 未落库');
    /* 用最新版本（version2）→ 200（证明拿到最新后能继续保存）。 */
    const retry = await app.inject({ method: 'PUT', url: URL, headers: { 'if-match': String(version2) }, payload: { maxAutonomousReward: 130 } });
    assert.equal(retry.statusCode, 200, retry.body);
  });

  it('不带 If-Match → last-write-wins（向后兼容，无版本检查）', async () => {
    await app.inject({ method: 'PUT', url: URL, payload: { maxAutonomousReward: 100 } });
    /* 不带 If-Match 直接 PUT → 200 覆盖（旧客户端/无并发场景不受影响）。 */
    const res = await app.inject({ method: 'PUT', url: URL, payload: { maxAutonomousReward: 200 } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.override.maxAutonomousReward, 200);
  });

  it('If-Match 非数值 → 400', async () => {
    const res = await app.inject({ method: 'PUT', url: URL, headers: { 'if-match': 'not-a-number' }, payload: { maxAutonomousReward: 100 } });
    assert.equal(res.statusCode, 400, res.body);
  });

  it('owner 门控：非 owner persona → 404（不泄露存在性，与 earning 同款）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/persona-core/not_owned/governance/policy' });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('owner 门控：不同 user → 404', async () => {
    const other = await buildApp(db, { sub: 'user_2' });
    const res = await other.inject({ method: 'GET', url: URL });
    assert.equal(res.statusCode, 404, res.body);
    await other.close();
  });
});
