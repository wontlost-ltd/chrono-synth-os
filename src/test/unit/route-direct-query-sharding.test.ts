/**
 * 租户分片 Phase 0 · Plan 2 · Task 6 —— route 内联直查下沉 `resolver.dbForTenant(tenantId)` 的
 * **2-shard 落对 shard** 行为验证。
 *
 * 与 injection-chain.test.ts（子服务经共享 resolver 分流）同款手法：`FakeMultiShardResolver` 注独立
 * coordinator + 2 独立 shard db，经**真实 createApp 注册链** + 真实 HTTP 请求，断言 route 内的
 * tenant-scoped 直查（decision_cases/decision_runs/onboarding_sessions/tenant_key_versions）确实经穿进
 * 的共享 resolver 按 request.tenantId 路由到正确 shard（s1），host db（s0）无该租户行。
 *
 * 租户识别：不启用 JWT，tenant hook 回退 `x-tenant-id` header 填 request.tenantId（tenant.ts）。
 * 租户 A → s1；os 用 s0 作 host（=coordinator，模拟旧 host 行为）。忘下沉（route 仍用 sharedDb=host db）
 * → 行落 s0、s1 无 → 反向断言红（这是「resolver 真穿透」的变异自证锚点）。
 *
 * onboarding-v2 的 `POST /agent` 曾有一条 persona_versions INSERT，目标列与迁移渲染的表完全不匹配
 * （端点必抛）。**该 INSERT 已在审计 P2 中删除**——agentId 只写进 onboarding 会话自身、无人从
 * persona_versions 读回，那是一行写了没人看的数据。故本文件不再对其做端到端落 shard 断言：
 * 不是「无法与行落错 shard 区分」，而是**已经没有这条直查了**。
 * inventory 该 edge 仍为 planned（对应的是 route 的 db 参数，非已删的 INSERT）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { createApp } from '../../server/index.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { loadConfig, type AppConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带全表（decision_cases/onboarding_sessions/tenant_key_versions 等）的内存 db。 */
function migratedDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 幂等关闭：os.close() 会关掉它持有的 db，finally 再关同一实例会抛 ERR_INVALID_STATE——吞掉重复关闭。 */
function safeClose(db: IDatabase): void {
  try { db.close(); } catch { /* 已关闭：os.close() 关过它 */ }
}

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    queue: { enabled: false },
    /* 不启用 JWT：tenant hook 走 x-tenant-id header 填 request.tenantId；requireRole('admin')
     * 在 JWT 未启用 + 非生产环境下透传（rbac.ts），故 admin-deployment 端点无需真登录。 */
    intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
    ...overrides,
  });
}

/** 起一个 2-shard app：host=s0（os 持有），租户 A → s1；返回 app + 三库 + 关闭器。 */
async function make2ShardApp(config: AppConfig = baseConfig()): Promise<{
  app: FastifyInstance;
  os: ChronoSynthOS;
  s0: IDatabase;
  s1: IDatabase;
  close: () => Promise<void>;
}> {
  const s0 = migratedDb();
  const s1 = migratedDb();
  /* 租户 A → s1；default（内部/未识别）→ s0（host）。coordinator=s0（本 task 无平台级直查断言）。 */
  const resolver = new FakeMultiShardResolver({
    coordinator: s0,
    shards: { s0, s1 },
    tenantToShard: { tenantA: 's1' },
    defaultShardId: 's0',
  });
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), db: s0 });
  os.start();
  const app = await createApp({ os, config, resolver });
  return {
    app, os, s0, s1,
    close: async () => {
      await app.close();
      os.close();       /* 关 s0（os 持有它） */
      safeClose(s0);    /* 幂等 */
      safeClose(s1);
    },
  };
}

const TENANT_A = { 'x-tenant-id': 'tenantA' } as const;

test('decisions：POST /api/v1/decisions → decision_case 落 s1（dbForTenant tenantA）、s0 无；GET 列表经 s1 读回', async () => {
  const { app, s0, s1, close } = await make2ShardApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: TENANT_A,
      payload: { title: '职业选择', description: '是否换工作', alternatives: ['留', '走'], constraints: ['收入不降'] },
    });
    assert.equal(res.statusCode, 201, res.body); /* 先断成功，防错误码让反向断言误导 */
    const caseId = JSON.parse(res.body).data.id as string;
    assert.ok(caseId.startsWith('dec_'));

    /* 正断言：decision_case 落 s1（tenantA 映射的 shard）。 */
    const onS1 = s1.prepare(`SELECT tenant_id, title FROM decision_cases WHERE id = ?`).get(caseId) as
      | { tenant_id: string; title: string } | undefined;
    assert.ok(onS1, 'decision_case 应落 shard s1');
    assert.equal(onS1!.tenant_id, 'tenantA');
    assert.equal(onS1!.title, '职业选择');
    /* 反断言：s0（host）无该行（忘下沉=串到 host db → 此断言红）。 */
    assert.equal(
      s0.prepare(`SELECT 1 FROM decision_cases WHERE id = ?`).get(caseId),
      undefined,
      'host s0 不应有 tenantA 的 decision_case（串 shard=resolver 未穿透）',
    );

    /* GET 列表经 s1 读回（读路径同样下沉）。 */
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/decisions', headers: TENANT_A });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const list = JSON.parse(listRes.body) as { data: Array<{ id: string }>; pagination: { total: number } };
    assert.equal(list.pagination.total, 1, 'GET 列表应读回 s1 的 1 行');
    assert.equal(list.data[0]?.id, caseId);
  } finally {
    await close();
  }
});

test('onboarding：POST /api/v1/onboarding/start → onboarding_session 落 s1、s0 无', async () => {
  const { app, s0, s1, close } = await make2ShardApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start', headers: TENANT_A });
    assert.equal(res.statusCode, 201, res.body);
    const sessionId = JSON.parse(res.body).data.id as string;
    assert.ok(sessionId.startsWith('onb_'));

    /* 正断言：onboarding_session 落 s1。 */
    const onS1 = s1.prepare(`SELECT tenant_id FROM onboarding_sessions WHERE id = ?`).get(sessionId) as
      | { tenant_id: string } | undefined;
    assert.ok(onS1, 'onboarding_session 应落 shard s1');
    assert.equal(onS1!.tenant_id, 'tenantA');
    /* 反断言：s0 无。 */
    assert.equal(
      s0.prepare(`SELECT 1 FROM onboarding_sessions WHERE id = ?`).get(sessionId),
      undefined,
      'host s0 不应有 tenantA 的 onboarding_session',
    );

    /* status 读回也经 s1（服务重启回退 DB 读路径同样下沉）。 */
    const statusRes = await app.inject({
      method: 'GET', url: `/api/v1/onboarding/status/${sessionId}`, headers: TENANT_A,
    });
    assert.equal(statusRes.statusCode, 200, statusRes.body);
    assert.equal(JSON.parse(statusRes.body).data.id, sessionId);
  } finally {
    await close();
  }
});

test('admin-deployment：POST /api/v1/admin/vault/keys/:keyRef/rotate → tenant_key_versions 落/读 s1、s0 无', async () => {
  const { app, s0, s1, close } = await make2ShardApp();
  try {
    /* 前置：向 s1 seed 一个已有 v1 active key（验 rotate 读既有 provider/version 也经 s1）。 */
    s1.prepare<void>(
      `INSERT INTO tenant_key_versions (id, tenant_id, key_ref, provider, version, status, created_at)
       VALUES (?, ?, ?, 'anthropic', 1, 'active', ?)`,
    ).run(randomUUID(), 'tenantA', 'primary', 1000);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/vault/keys/primary/rotate', headers: TENANT_A,
    });
    assert.equal(res.statusCode, 200, res.body);
    const created = JSON.parse(res.body).data as { keyRef: string; version: number; status: string };
    assert.equal(created.keyRef, 'primary');
    assert.equal(created.version, 2, 'rotate 读 s1 既有 v1 → 新版本 v2（provider 继承）');
    assert.equal(created.status, 'active');

    /* 正断言：s1 现有两个版本（seed v1 + rotate v2），v2 继承 provider=anthropic。 */
    const s1Rows = s1.prepare<{ version: number; provider: string }>(
      `SELECT version, provider FROM tenant_key_versions WHERE tenant_id = ? AND key_ref = ? ORDER BY version`,
    ).all('tenantA', 'primary');
    assert.deepEqual(s1Rows.map((r) => r.version), [1, 2], 's1 应有 v1+v2');
    assert.equal(s1Rows[1].provider, 'anthropic', 'v2 继承 s1 上既有 provider（读也经 s1）');
    /* 反断言：s0 无该租户任何 key 版本。 */
    assert.equal(
      s0.prepare(`SELECT 1 FROM tenant_key_versions WHERE tenant_id = ?`).get('tenantA'),
      undefined,
      'host s0 不应有 tenantA 的 tenant_key_versions',
    );

    /* GET /keys 列表经 s1 读回（读路径同样下沉）。 */
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/admin/vault/keys', headers: TENANT_A });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const keys = JSON.parse(listRes.body).data as Array<{ keyRef: string; version: number }>;
    assert.equal(keys.length, 2, 'GET /keys 应读回 s1 的两个版本');
  } finally {
    await close();
  }
});
