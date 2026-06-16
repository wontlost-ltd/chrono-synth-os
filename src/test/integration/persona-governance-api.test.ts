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
    assert.equal(res.json().data.effective.maxAutonomousReward, DEFAULT_EARNING_POLICY.maxAutonomousReward);
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
