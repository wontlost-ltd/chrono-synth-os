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
function setup(overrideConfig?: (config: ReturnType<typeof loadConfig>) => void) {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const clock = new TestClock(1000);
  const logger = new SilentLogger();
  const factory = new TenantOSFactory(new SingleDbResolver(db), clock, logger);
  const personaCoreService = PersonaCoreService.fromUnitOfWork(db);
  const config = loadConfig();
  overrideConfig?.(config);
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

  /* 暴露 os，供测试断言「未为被拒 persona 建 core」（fail-closed 顺序防假绿，见下方 M-1 测试）。 */
  const os = factory.getTenantOS('t1');

  return { service, seedPersona, seedMemory, idOf, os };
}

test('未知 personaId → NotFoundError NOT_FOUND_PERSONA（不静默产空核）', () => {
  const { service, os } = setup();
  assert.throws(
    () => service.analyze('t1', 'user_1', ['does-not-exist'], { question: 'q' }),
    (e: unknown) => e instanceof NotFoundError && /不存在或调用者非 owner/.test((e as Error).message),
  );
  /* fail-closed 顺序防假绿：校验须先于 getCore，被拒 persona 绝不应留下已建的核实例。
   * 若校验被挪到 getCore 之后，这里会因 listPersonaCores 含 'does-not-exist' 而失败。 */
  assert.ok(!os.listPersonaCores().includes('does-not-exist'));
});

test('跨 owner persona：owner=user_2 请求 user_1 的 persona → NotFoundError（不泄露存在性）', () => {
  /* 注意：用 seedPersona（非 seedMemory）——seedMemory 会先 getCore() 建核作种子写入，
   * 若用它，realId 的核在 analyze() 调用前就已存在，下面「未建核」断言会对正确实现也失败。
   * seedPersona 只建 persona 行，不触碰核，核的建立时机完全由 analyze() 内部决定。 */
  const { service, seedPersona, os } = setup();
  const realId = seedPersona('t1', 'user_1', 'pa');
  assert.throws(
    () => service.analyze('t1', 'user_2', [realId], { question: 'q' }),
    (e: unknown) => e instanceof NotFoundError,
  );
  /* 被拒（跨 owner）persona 不应被建核——即便它在本租户是真实存在的 id。 */
  assert.ok(!os.listPersonaCores().includes(realId));
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

test('always-enabled RuleEngine：租户 config 关了 ruleEngine 仍强制 enabled，不受 config 影响', () => {
  /* 真实回归形态：忘了强制 enabled + 租户 config 关了 ruleEngine。默认 loadConfig() 的
   * ruleEngine.enabled 本就是 true，「去掉 override」在默认配置下等价无操作、测不出问题；
   * 这里手工把 config.ruleEngine.enabled 改成 false，才能让「强制 enabled:true」这行代码
   * 真正被测试需要——若实现漏了 override，autonomous 决策会因 ruleEngine disabled 而抛错。 */
  const { service, seedMemory, idOf } = setup((config) => {
    config.ruleEngine.enabled = false;
  });
  seedMemory('t1', 'user_1', 'pa', '投资 预算 约束');
  const id = idOf('t1', 'user_1', 'pa');
  const req = { question: '投资 预算够吗', alternatives: ['继续投资', '暂缓投资'] };
  const r = service.analyze('t1', 'user_1', [id], req);
  assert.equal(r.perspectives[0].kind, 'knowledge_grounded');
  assert.equal(r.perspectives[0].rankedAlternatives?.length, 2);
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
  assert.equal(r1.question, '投资 预算够吗');   // question 端到端回显（pin 输入透传）
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
