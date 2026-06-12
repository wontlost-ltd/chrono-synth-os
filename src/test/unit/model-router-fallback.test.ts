/**
 * ADR-0047 D2：ModelRouter 自动分层降级链（cloud → local → 调用方确定性档）。
 *
 * 用按 URL 路由的 fetch stub 模拟：主 provider（云端）不可用（网络错/5xx），
 * fallback（本地 ollama）可用 → 降级成功且记一次 llmMetrics.fallbacks。
 * 反向验证：主动拒绝（安全拒绝 / 配额耗尽）**不**降级。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, llmMetrics } from '../../intelligence/model-router.js';
import { QuotaExceededError } from '../../errors/index.js';

const originalFetch = globalThis.fetch;

/** 按 URL 子串决定每个端点的响应/失败行为。 */
interface UrlBehavior { status?: number; json?: unknown; throwNetwork?: boolean }
let behaviors: Record<string, UrlBehavior> = {};
let hits: string[] = [];

function installFetchStub(): void {
  hits = [];
  globalThis.fetch = (async (input: unknown, _init?: unknown) => {
    const url = String(input);
    hits.push(url);
    const key = Object.keys(behaviors).find((k) => url.includes(k));
    const b = key ? behaviors[key] : { status: 200, json: {} };
    if (b.throwNetwork) throw new Error('ECONNREFUSED: connection refused');
    const status = b.status ?? 200;
    const payload = b.json ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as typeof globalThis.fetch;
}

/** 云端 anthropic 主 + 本地 ollama fallback。 */
function routerWithFallback(): ModelRouter {
  return new ModelRouter({
    provider: 'anthropic',
    model: 'claude-x',
    embeddingModel: 'text-embedding-3-small',
    apiKey: 'cloud-key',
    baseUrl: 'https://api.anthropic.com',
    fallbacks: [
      { provider: 'ollama', model: 'llama3', embeddingModel: 'nomic-embed-text', baseUrl: 'http://localhost:11434' },
    ],
  });
}

describe('ModelRouter 分层降级链（ADR-0047 D2）', () => {
  beforeEach(() => { installFetchStub(); behaviors = {}; llmMetrics.fallbacks = 0; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('主 provider 5xx → 降级本地 ollama 成功，记一次 fallback', async () => {
    behaviors = {
      'api.anthropic.com': { status: 503, json: { error: 'overloaded' } },
      'localhost:11434': { status: 200, json: { message: { content: '本地兜底回复' } } },
    };
    const res = await routerWithFallback().chat([{ role: 'user', content: '你好' }]);
    assert.equal(res.content, '本地兜底回复');
    assert.equal(llmMetrics.fallbacks, 1, '应记一次降级');
    /* 两端都被打：先云端（失败），后本地（成功）。云端 requestJson 有重试，故 anthropic 命中≥1。 */
    assert.ok(hits.some((u) => u.includes('api.anthropic.com')), '应先尝试云端');
    assert.ok(hits.some((u) => u.includes('localhost:11434')), '应降级到本地');
  });

  it('主 provider 网络错（ECONNREFUSED）→ 降级本地成功', async () => {
    behaviors = {
      'api.anthropic.com': { throwNetwork: true },
      'localhost:11434': { status: 200, json: { message: { content: 'local' } } },
    };
    const res = await routerWithFallback().chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.content, 'local');
    assert.equal(llmMetrics.fallbacks, 1);
  });

  it('主可用 → 不降级（fallback 不被调用）', async () => {
    behaviors = {
      'api.anthropic.com': { status: 200, json: { content: [{ text: '云端回复' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      'localhost:11434': { status: 200, json: { message: { content: '不该被调到' } } },
    };
    const res = await routerWithFallback().chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.content, '云端回复');
    assert.equal(llmMetrics.fallbacks, 0, '主可用时不应降级');
    assert.ok(!hits.some((u) => u.includes('localhost:11434')), '本地不该被调用');
  });

  it('embed：主（anthropic 无 embed 能力）→ 降级本地 ollama embed', async () => {
    /* anthropic 在 dispatchEmbedOnce 直接抛「不支持嵌入」→ 视为可用性失败 → 降级。 */
    behaviors = {
      'localhost:11434': { status: 200, json: { embeddings: [[0.1, 0.2]] } },
    };
    const vecs = await routerWithFallback().embed(['x']);
    assert.deepEqual(vecs, [[0.1, 0.2]]);
    assert.equal(llmMetrics.fallbacks, 1);
  });

  it('全链失败 → 抛错（交由调用方落确定性档）', async () => {
    behaviors = {
      'api.anthropic.com': { status: 500, json: {} },
      'localhost:11434': { throwNetwork: true },
    };
    await assert.rejects(() => routerWithFallback().chat([{ role: 'user', content: 'q' }]));
  });

  it('主动拒绝不降级：配额耗尽（QuotaExceededError）直接抛，不碰 fallback', async () => {
    /* 配额门在调用 provider 之前，注入一个永远拒绝的 quotaManager。 */
    const denyingQuota = { consumeQuota: () => false } as unknown as ConstructorParameters<typeof ModelRouter>[0]['quotaManager'];
    const router = new ModelRouter({
      provider: 'anthropic', model: 'm', embeddingModel: 'e', apiKey: 'k', baseUrl: 'https://api.anthropic.com',
      fallbacks: [{ provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' }],
      quotaManager: denyingQuota,
    });
    behaviors = { 'localhost:11434': { status: 200, json: { message: { content: '不该被调到' } } } };
    await assert.rejects(() => router.chat([{ role: 'user', content: 'q' }]), QuotaExceededError);
    assert.equal(llmMetrics.fallbacks, 0, '配额耗尽是主动拒绝，不应降级');
    assert.ok(!hits.some((u) => u.includes('localhost:11434')), '主动拒绝时本地不该被调用');
  });

  it('无 fallbacks 配置 → 行为与单 provider 完全一致（向后兼容）', async () => {
    behaviors = { 'api.anthropic.com': { status: 500, json: {} } };
    const single = new ModelRouter({
      provider: 'anthropic', model: 'm', embeddingModel: 'e', apiKey: 'k', baseUrl: 'https://api.anthropic.com',
    });
    await assert.rejects(() => single.chat([{ role: 'user', content: 'q' }]));
    assert.equal(llmMetrics.fallbacks, 0, '无 fallback 不降级');
  });

  it('成本归因按实际服务档：降级到 ollama 后 record 记 ollama/llama3 而非主 anthropic（Codex 复审）', async () => {
    const recorded: Array<{ provider: string; model: string }> = [];
    const record = (_t: string, provider: string, model: string): void => { recorded.push({ provider, model }); };
    type CT = ConstructorParameters<typeof ModelRouter>[0]['costTracker'];
    const spyTracker = { record } as unknown as CT;
    const router = new ModelRouter({
      provider: 'anthropic', model: 'claude-x', embeddingModel: 'text-embedding-3-small',
      apiKey: 'k', baseUrl: 'https://api.anthropic.com', costTracker: spyTracker,
      fallbacks: [{ provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' }],
    });
    behaviors = {
      'api.anthropic.com': { status: 503, json: {} },
      'localhost:11434': { status: 200, json: { message: { content: 'ok' } } },
    };
    await router.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].provider, 'ollama', '成本应记实际服务的 ollama，不是主 anthropic');
    assert.equal(recorded[0].model, 'llama3');
  });
});
