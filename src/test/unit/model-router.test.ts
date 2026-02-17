import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../intelligence/model-router.js';

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
});
