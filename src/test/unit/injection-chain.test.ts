/**
 * 注入链行为验（分片 Phase 0 · Plan 1 · Task 2）：真验 app→route→子服务共享**同一个** resolver 实例。
 *
 * 与 metering-subservices-sharding.test.ts（只证子服务本身 shard-ready）不同，本测试经**真实 createApp
 * 注册链** + 真实 HTTP 请求，断言 route 内的子服务确实经穿进的共享 resolver 按 tenantId 路由到正确 shard。
 *
 * 主代表链 = POST /api/v1/companion/me/chat（**零-LLM 确定性**，无外部依赖）
 *   → quotaManager.consumeQuota(tenantId, 'companion_chat')（chat.ts，QuotaManager.fromResolver 子服务）
 *   → 无限额时 recordUsage → 写 quota_usage(tenant_id, resource, window_start)。
 * 忘穿 resolver（route 内回退内联 new SingleDbResolver(sharedDb)）→ A/B 的 quota_usage 会串到同一 host db，
 * 反向断言（s1 无 A / s0 无 B）红——这是「resolver 真穿透」的变异自证锚点。
 *
 * 4 实现细节（Codex 复审非阻断）：
 *   ① fake resolver 映射键用**注册后返回的真实 tenantId**（非显示标签 "A"/"B"）；
 *   ② identity spy 在**真实 route 注册边界**采集 resolver（createApp 的 captureResolvers 回调），非 buildTestApp 回显；
 *   ③ guard 测按 MultiShardRuntimeNotReadyError 类型断言 + 副作用（worker/timer/route 注册）计数 0；
 *   ④ 双 shard 测用 try/finally 关 app+三库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { FakeMultiShardResolver, type FakeShardConfig } from '../support/fake-multi-shard-resolver.js';
import { createApp } from '../../server/index.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { loadConfig, type AppConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { MultiShardRuntimeNotReadyError } from '../../storage/build-resolver.js';
import type { IDatabase } from '../../storage/database.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

/** 建带全表（quota_usage 等）的内存 db。 */
function migratedDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 幂等关闭：os.close() 会关掉它持有的 db，测试 finally 再关同一实例会抛 ERR_INVALID_STATE——吞掉重复关闭。 */
function safeClose(db: IDatabase): void {
  try { db.close(); } catch { /* 已关闭：os.close() 关过它 */ }
}

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    queue: { enabled: false },
    ...overrides,
  });
}

/** 注册用户，返回真实 tenantId + accessToken（照 companion-chat-api.test.ts 夹具）。 */
async function registerTenant(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

test('注入链行为验[companion-chat]：A→shard0/B→shard1，A 的 quota_usage 只在 shard0、shard1 无（正反断言，真实 tenantId）', async () => {
  const s0 = migratedDb();
  const s1 = migratedDb();
  const coord = migratedDb();
  /* tenantToShard 用可变 record：先建 app + 注册拿真实 tenantId，再填映射后发 chat 请求。
   * defaultShardId='coordAsShard'：register（Plan 1c Task 5）为全新随机 tenantId 立即 dbForTenant 落 shard，
   * 而映射在注册**后**才知 tenantId——故未映射时回退到 coordinator 库（把 coord 也作为一个 shard 暴露），
   * 模拟真实 ShardRouter「新租户即可路由、永不因未知抛错」。register 的 user/token 落 coord（与旧 host 行为等价），
   * chat 的 quota 经映射后的 s0/s1（本测真正断言的路由）。 */
  const tenantToShard: Record<string, string> = {};
  const fake = new FakeMultiShardResolver({
    coordinator: coord, shards: { s0, s1, coordAsShard: coord }, tenantToShard, defaultShardId: 'coordAsShard',
  });
  /* OS 用 coordinator db（registerAuthRoutes 经共享 resolver：新租户回退 coord；chat 的 quota 经共享 resolver 走 shard）。 */
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), db: coord });
  os.start();
  const app = await createApp({ os, config: baseConfig(), resolver: fake });
  try {
    const a = await registerTenant(app, 'inject-a@example.com');
    const b = await registerTenant(app, 'inject-b@example.com');
    /* ① 真实 tenantId 作 fake 映射键（非 "A"/"B"）。 */
    tenantToShard[a.tenantId] = 's0';
    tenantToShard[b.tenantId] = 's1';

    const authFor = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
    const rA = await app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers: authFor(a.accessToken), payload: { message: '你好' } });
    assert.equal(rA.statusCode, 200, rA.body); /* 先断言成功，防 401/403 让反向断言误导 */
    const rB = await app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers: authFor(b.accessToken), payload: { message: '你好' } });
    assert.equal(rB.statusCode, 200, rB.body);

    /* 正断言：A 的 companion_chat 用量落 s0；反断言：s1 无 A、s0 无 B（子服务经共享 resolver 按 tenantId 路由）。 */
    assert.ok(
      s0.prepare(`SELECT 1 FROM quota_usage WHERE tenant_id = ? AND resource = 'companion_chat'`).get(a.tenantId),
      'A 的 quota_usage 应落 shard0',
    );
    assert.equal(
      s1.prepare(`SELECT 1 FROM quota_usage WHERE tenant_id = ?`).get(a.tenantId),
      undefined,
      'shard1 不应有 A 的 quota_usage（串 shard=resolver 未穿透）',
    );
    assert.ok(
      s1.prepare(`SELECT 1 FROM quota_usage WHERE tenant_id = ? AND resource = 'companion_chat'`).get(b.tenantId),
      'B 的 quota_usage 应落 shard1',
    );
    assert.equal(
      s0.prepare(`SELECT 1 FROM quota_usage WHERE tenant_id = ?`).get(b.tenantId),
      undefined,
      'shard0 不应有 B 的 quota_usage',
    );
  } finally {
    await app.close();
    os.close();       /* 关 coord（os 持有它） */
    safeClose(s0);
    safeClose(s1);
    safeClose(coord); /* 幂等：os.close 已关，吞重复 */
  }
});

test('identity 补充：各 route/factory 注入点拿到的是**同一个**共享 resolver 实例（真边界 spy，非回显）', async () => {
  const coord = migratedDb();
  const fake = new FakeMultiShardResolver({ coordinator: coord, shards: { s0: coord }, tenantToShard: {} } as FakeShardConfig);
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), db: coord });
  os.start();
  /* captureResolvers 回调在 createApp 内**真实**把 resolver 交给 factory/route 处采集——非测试回显传入的 fake。 */
  const captured: { site: string; resolver: TenantDbResolver }[] = [];
  const app = await createApp({
    os,
    config: baseConfig(),
    resolver: fake,
    captureResolvers: (resolver, site) => { captured.push({ site, resolver }); },
  });
  try {
    assert.ok(captured.length > 0, 'createApp 应在注入点采集到 resolver');
    for (const c of captured) {
      assert.equal(c.resolver, fake, `注入点 ${c.site} 未拿到共享 resolver 实例`);
    }
  } finally {
    await app.close();
    os.close();       /* 关 coord（os 持有它） */
    safeClose(coord); /* 幂等 */
  }
});

test('createApp seam 不解除 config guard：config.db.shards 非空 + 注入 fake → 在任何 worker/timer/route 注册副作用前抛（MultiShardRuntimeNotReadyError，计数 0）', async () => {
  const coord = migratedDb();
  const fake = new FakeMultiShardResolver({ coordinator: coord, shards: { s0: coord }, tenantToShard: {} } as FakeShardConfig);
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), db: coord });
  os.start();
  const multiShardConfig = baseConfig({ db: { shards: { s0: { connectionString: 'postgres://h' } } } });
  /* 副作用计数 spy：assertShardingActivationAllowed 在任何注册前调，deps.resolver 绕不过 config guard。 */
  let sideEffectCount = 0;
  try {
    await assert.rejects(
      () => createApp({
        os,
        config: multiShardConfig,
        resolver: fake,
        captureResolvers: () => { sideEffectCount += 1; },
      }),
      MultiShardRuntimeNotReadyError,
    );
    assert.equal(sideEffectCount, 0, 'guard 应在任何 route/factory 注入（副作用）前抛出');
  } finally {
    os.close();       /* 关 coord（os 持有它） */
    safeClose(coord); /* 幂等 */
  }
});
