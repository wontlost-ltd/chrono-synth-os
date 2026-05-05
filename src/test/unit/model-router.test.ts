import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../intelligence/model-router.js';
import { TokenBudget } from '../../intelligence/token-budget.js';
import { CostTracker } from '../../intelligence/cost-tracker.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { QuotaExceededError } from '../../errors/index.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

describe('ModelRouter (Mock Provider)', () => {
  const router = new ModelRouter({
    provider: 'mock',
    model: 'test-model',
    embeddingModel: 'test-embed',
  });

  describe('chat', () => {
    it('TASK:ALTERNATIVES 返回备选项 JSON', async () => {
      const res = await router.chat([
        { role: 'system', content: 'TASK:ALTERNATIVES' },
        { role: 'user', content: '决策描述' },
      ], { responseFormat: 'json' });

      const parsed = JSON.parse(res.content);
      assert.ok(Array.isArray(parsed.alternatives));
      assert.ok(parsed.alternatives.length >= 2);
    });

    it('TASK:SIMULATE 返回模拟结果 JSON', async () => {
      const res = await router.chat([
        { role: 'system', content: 'TASK:SIMULATE' },
        { role: 'user', content: '模拟输入' },
      ], { responseFormat: 'json' });

      const parsed = JSON.parse(res.content);
      assert.ok(Array.isArray(parsed.outcomes));
      assert.ok(parsed.valueAlignment);
      assert.ok(Array.isArray(parsed.constraintViolations));
      assert.equal(typeof parsed.riskScore, 'number');
      assert.equal(typeof parsed.confidence, 'number');
    });

    it('TASK:EXPLAIN 返回解释 JSON', async () => {
      const res = await router.chat([
        { role: 'system', content: 'TASK:EXPLAIN' },
        { role: 'user', content: '解释输入' },
      ], { responseFormat: 'json' });

      const parsed = JSON.parse(res.content);
      assert.equal(typeof parsed.summary, 'string');
      assert.ok(Array.isArray(parsed.evidence));
      assert.ok(Array.isArray(parsed.counterfactuals));
    });

    it('未匹配的消息返回 json 时为 {}', async () => {
      const res = await router.chat([
        { role: 'user', content: '普通消息' },
      ], { responseFormat: 'json' });
      assert.equal(res.content, '{}');
    });

    it('未匹配的消息返回 text 时为 OK', async () => {
      const res = await router.chat([
        { role: 'user', content: '普通消息' },
      ]);
      assert.equal(res.content, 'OK');
    });
  });

  describe('embed', () => {
    it('生成确定性归一化向量', async () => {
      const vecs = await router.embed(['hello', 'world']);
      assert.equal(vecs.length, 2);

      for (const vec of vecs) {
        assert.ok(vec.length > 0);
        /* 验证归一化：向量范数约等于 1 */
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        assert.ok(Math.abs(norm - 1) < 0.001);
      }
    });

    it('相同输入产生相同向量', async () => {
      const [a] = await router.embed(['deterministic']);
      const [b] = await router.embed(['deterministic']);
      assert.deepEqual(a, b);
    });

    it('不同输入产生不同向量', async () => {
      const [a] = await router.embed(['hello']);
      const [b] = await router.embed(['world']);
      assert.notDeepEqual(a, b);
    });
  });

  describe('不支持的提供商', () => {
    it('chat 抛出错误', async () => {
      const bad = new ModelRouter({
        provider: 'invalid' as never,
        model: 'x',
        embeddingModel: 'x',
      });
      await assert.rejects(() => bad.chat([{ role: 'user', content: 'test' }]), /不支持/);
    });

    it('embed 抛出错误', async () => {
      const bad = new ModelRouter({
        provider: 'invalid' as never,
        model: 'x',
        embeddingModel: 'x',
      });
      await assert.rejects(() => bad.embed(['test']), /不支持/);
    });

    it('Anthropic embed 抛出不支持错误', async () => {
      const anthropic = new ModelRouter({
        provider: 'anthropic',
        model: 'claude-3',
        embeddingModel: 'none',
      });
      await assert.rejects(() => anthropic.embed(['test']), /不支持嵌入/);
    });
  });

  describe('TokenBudget 集成', () => {
    let db: IDatabase;

    beforeEach(() => {
      db = createMemoryDatabase();
      runMigrations(db);
    });

    it('预算充足时正常调用', async () => {
      const tokenBudget = new TokenBudget({ monthlyTokenLimit: 1_000_000, dailyTokenLimit: 100_000, alertThreshold: 0.8 }, db);
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        tokenBudget,
        tenantId: 'tenant-1',
      });

      const res = await r.chat([{ role: 'user', content: '普通消息' }]);
      assert.equal(res.content, 'OK');
    });

    it('预算不足时抛出 QuotaExceededError', async () => {
      const tokenBudget = new TokenBudget({ monthlyTokenLimit: 10, dailyTokenLimit: 10, alertThreshold: 0.8 }, db);
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        tokenBudget,
        tenantId: 'tenant-1',
        maxTokens: 100,
      });

      await assert.rejects(
        () => r.chat([{ role: 'user', content: 'test' }]),
        (err: unknown) => err instanceof QuotaExceededError && /Token 预算不足/.test((err as Error).message),
      );
    });

    it('embed 预算不足时抛出 QuotaExceededError', async () => {
      const tokenBudget = new TokenBudget({ monthlyTokenLimit: 1, dailyTokenLimit: 1, alertThreshold: 0.8 }, db);
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        tokenBudget,
        tenantId: 'tenant-1',
      });

      await assert.rejects(
        () => r.embed(['a long text that will exceed the tiny budget limit set above']),
        (err: unknown) => err instanceof QuotaExceededError,
      );
    });
  });

  describe('CostTracker 集成', () => {
    let db: IDatabase;

    beforeEach(() => {
      db = createMemoryDatabase();
      runMigrations(db);
    });

    it('chat 后 CostTracker 写入 llm_usage 记录', async () => {
      const costTracker = new CostTracker(db);
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        costTracker,
        tenantId: 'tenant-1',
      });

      await r.chat([{ role: 'user', content: '普通消息' }]);

      /* mock 不返回 usage，所以 inputTokens/outputTokens 为 0，但应有写入记录 */
      const summary = costTracker.getMonthlySummary('tenant-1');
      assert.equal(summary.totalCalls, 1);
    });
  });

  describe('QuotaManager 集成', () => {
    let db: IDatabase;

    beforeEach(() => {
      db = createMemoryDatabase();
      runMigrations(db);
    });

    it('llm_tokens 配额充足时正常调用', async () => {
      const quotaManager = new QuotaManager(db);
      quotaManager.setLimit('tenant-1', 'llm_tokens', 100_000, 3_600_000);

      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        quotaManager,
        tenantId: 'tenant-1',
      });

      const res = await r.chat([{ role: 'user', content: '普通消息' }]);
      assert.equal(res.content, 'OK');
    });

    it('llm_tokens 配额耗尽时 chat 抛出 QuotaExceededError', async () => {
      const quotaManager = new QuotaManager(db);
      quotaManager.setLimit('tenant-1', 'llm_tokens', 100, 3_600_000);

      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        quotaManager,
        tenantId: 'tenant-1',
        maxTokens: 4096,
      });

      await assert.rejects(
        () => r.chat([{ role: 'user', content: 'test' }]),
        (err: unknown) => err instanceof QuotaExceededError && /配额已用尽/.test((err as Error).message),
      );
    });

    it('llm_tokens 配额耗尽时 embed 抛出 QuotaExceededError', async () => {
      const quotaManager = new QuotaManager(db);
      quotaManager.setLimit('tenant-1', 'llm_tokens', 1, 3_600_000);

      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        quotaManager,
        tenantId: 'tenant-1',
      });

      await assert.rejects(
        () => r.embed(['this text has enough characters to exceed the tiny 1-token quota']),
        (err: unknown) => err instanceof QuotaExceededError,
      );
    });

    it('无 QuotaManager 时不做配额检查', async () => {
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        tenantId: 'tenant-1',
      });

      const res = await r.chat([{ role: 'user', content: '普通消息' }]);
      assert.equal(res.content, 'OK');
    });
  });

  describe('UsageTracker 集成', () => {
    let db: IDatabase;

    beforeEach(() => {
      db = createMemoryDatabase();
      runMigrations(db);
    });

    it('chat 后 UsageTracker 记录 llm_tokens 用量', async () => {
      const usageTracker = new UsageTracker(db);
      const r = new ModelRouter({
        provider: 'mock',
        model: 'mock',
        embeddingModel: 'mock',
        usageTracker,
        tenantId: 'tenant-1',
      });

      /* mock 不返回 usage → totalTokens = 0 → 不记录 */
      await r.chat([{ role: 'user', content: '普通消息' }]);
      const summary = usageTracker.getSummary('tenant-1');
      assert.equal(summary.llm_tokens ?? 0, 0);
    });
  });
});
