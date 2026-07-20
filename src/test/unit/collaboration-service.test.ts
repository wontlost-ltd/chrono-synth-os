import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborativeAnalysisService } from '../../collaboration/collaborative-analysis-service.js';
import { MultiPerspectiveAggregation } from '../../collaboration/modes/multi-perspective-aggregation.js';
import { NotFoundError } from '../../errors/index.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

/**
 * 真实夹具：共享 in-memory sqlite + TenantOSFactory + PersonaCoreService（照
 * persona-core-service.test.ts / persona-core-isolation-k1.test.ts 建库惯例）。
 *
 * setup() 不配任何 LLM provider——service 内部用 NoOpEmbeddingIndex + llm=undefined，
 * 构造链无 LLMProvider，零-LLM 是结构性保证。
 *
 * seedPersona(alias) 用 createPersona 建真 persona（id 由服务生成），存 alias→真 id 映射；
 * seedMemory 把记忆写进对应 persona 的认知内核（getCore(真 id).addMemory），确保
 * retrieveMemoriesDeterministic 命得中、evidence 非空——堵「空集假绿」。
 */
function setup() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const clock = new TestClock(1000);
  const logger = new SilentLogger();
  const factory = new TenantOSFactory(new SingleDbResolver(db), clock, logger);
  const personaCoreService = PersonaCoreService.fromUnitOfWork(db);
  const config = loadConfig();
  const service = new CollaborativeAnalysisService({
    factory,
    personaCoreService,
    mode: new MultiPerspectiveAggregation(),
    config,
  });

  const now = Date.now();
  const ensureUser = (tenantId: string, userId: string): void => {
    const exists = db.prepare<{ id: string }>(`SELECT id FROM users WHERE id = ?`).get(userId);
    if (exists) return;
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, `${userId}@example.com`, 'hash', 'member', tenantId, now, now);
  };

  /* alias（测试里的稳定名）→ 真实 persona id 映射（createPersona 自动生成 id）。 */
  const aliasToId = new Map<string, string>();

  const seedPersona = (tenantId: string, ownerUserId: string, alias: string): string => {
    ensureUser(tenantId, ownerUserId);
    const existing = aliasToId.get(`${tenantId}:${ownerUserId}:${alias}`);
    if (existing) return existing;
    const persona = personaCoreService.createPersona({
      tenantId,
      ownerUserId,
      displayName: alias,
      profile: { narrative: `我是 ${alias}`, behaviorBoundaries: [] },
    });
    aliasToId.set(`${tenantId}:${ownerUserId}:${alias}`, persona.id);
    return persona.id;
  };

  const seedMemory = (tenantId: string, ownerUserId: string, alias: string, content: string): string => {
    const personaId = seedPersona(tenantId, ownerUserId, alias);
    const core = factory.getTenantOS(tenantId).getCore(personaId);
    core.addMemory('semantic', content, 0, 0.9);
    return personaId;
  };

  const idOf = (tenantId: string, ownerUserId: string, alias: string): string =>
    aliasToId.get(`${tenantId}:${ownerUserId}:${alias}`) ?? alias;

  return { service, seedPersona, seedMemory, idOf };
}

test('未知 personaId → NotFoundError NOT_FOUND_PERSONA（不静默产空核）', () => {
  const { service } = setup();
  assert.throws(
    () => service.analyze('t1', 'user_1', ['does-not-exist'], { question: 'q' }),
    (e: unknown) => e instanceof NotFoundError && /不存在或调用者非 owner/.test((e as Error).message),
  );
});

test('跨 owner persona：owner=user_2 请求 user_1 的 persona → NotFoundError（不泄露存在性）', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '投资 预算');
  const realId = idOf('t1', 'user_1', 'pa');
  assert.throws(
    () => service.analyze('t1', 'user_2', [realId], { question: 'q' }),
    (e: unknown) => e instanceof NotFoundError,
  );
});

test('per-persona 隔离：两 persona 均 grounded、evidence 非空、memoryId 集不相交、A 内容不入 B', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '投资 扩张 关键词ALPHA');
  seedMemory('t1', 'user_1', 'pb', '投资 收紧 关键词BETA');
  const ids = ['pa', 'pb'].map((a) => idOf('t1', 'user_1', a));
  const report = service.analyze('t1', 'user_1', ids, { question: '投资 怎么看' });
  const [va, vb] = ids.map((id) => report.perspectives.find((p) => p.personaId === id)!);
  assert.equal(va.kind, 'knowledge_grounded');
  assert.equal(vb.kind, 'knowledge_grounded');
  assert.ok(va.evidence.length > 0 && vb.evidence.length > 0);
  const aIds = new Set(va.evidence.map((e) => e.memoryId));
  const bIds = new Set(vb.evidence.map((e) => e.memoryId));
  assert.ok([...aIds].every((id) => !bIds.has(id)));
  assert.ok(!vb.evidence.some((e) => e.excerpt.includes('ALPHA')));
  assert.ok(!va.evidence.some((e) => e.excerpt.includes('BETA')));
});

test('多视角真不同：两 persona 学不同内容 → 均 grounded、keyPoints 不同、memoryId 不相交', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '投资 扩张 有利 市场');
  seedMemory('t1', 'user_1', 'pb', '投资 风险 收紧 谨慎');
  const ids = ['pa', 'pb'].map((a) => idOf('t1', 'user_1', a));
  const report = service.analyze('t1', 'user_1', ids, { question: '投资 要不要扩张' });
  const [va, vb] = ids.map((id) => report.perspectives.find((p) => p.personaId === id)!);
  assert.equal(va.kind, 'knowledge_grounded');
  assert.equal(vb.kind, 'knowledge_grounded');
  assert.ok(va.evidence.length > 0 && vb.evidence.length > 0);
  const aIds = new Set(va.evidence.map((e) => e.memoryId));
  assert.ok(!vb.evidence.some((e) => aIds.has(e.memoryId)));
  assert.notDeepEqual([...va.keyPoints].sort(), [...vb.keyPoints].sort());
});

test('零-LLM：构造链无 LLMProvider，带 alternatives 真走 DecisionEngine + 确定性', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '投资 预算 约束');
  const id = idOf('t1', 'user_1', 'pa');
  const req = { question: '投资 预算够吗', alternatives: ['继续投资', '暂缓投资'] };
  const r1 = service.analyze('t1', 'user_1', [id], req);
  const r2 = service.analyze('t1', 'user_1', [id], req);
  assert.equal(r1.perspectives[0].kind, 'knowledge_grounded');
  assert.equal(r1.perspectives[0].rankedAlternatives?.length, 2);
  assert.deepEqual(r1, r2);
});

test('单 persona：正常产报告，commonTopics/rankingDivergences 空', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '预算 约束');
  const id = idOf('t1', 'user_1', 'pa');
  const r = service.analyze('t1', 'user_1', [id], { question: '预算够吗' });
  assert.deepEqual(r.commonTopics, []);
  assert.deepEqual(r.rankingDivergences, []);
});

test('空 personaIds → 校验错；空 question → 校验错；重复去重', () => {
  const { service, seedMemory, idOf } = setup();
  seedMemory('t1', 'user_1', 'pa', '投资 预算');
  const id = idOf('t1', 'user_1', 'pa');
  assert.throws(() => service.analyze('t1', 'user_1', [], { question: 'q' }));
  assert.throws(() => service.analyze('t1', 'user_1', [id], { question: '  ' }));
  const r = service.analyze('t1', 'user_1', [id, id], { question: '投资 预算' });
  assert.equal(r.perspectives.length, 1);
});
