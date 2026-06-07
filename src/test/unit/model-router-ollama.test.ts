/**
 * ADR-0047 Ollama layer-2：ModelRouter 的 ollama provider HTTP 协议测试。
 * stub globalThis.fetch 验证 chat 走 /api/chat、embed 走 /api/embed，无 apiKey 时不带 auth 头，
 * 默认 baseUrl http://localhost:11434，并正确解析 Ollama 响应形状。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../intelligence/model-router.js';

interface CapturedReq { url: string; method: string; headers: Record<string, string>; body: unknown }

const originalFetch = globalThis.fetch;
let captured: CapturedReq[] = [];
let nextResponse: unknown = {};
let nextStatus = 200;

function installFetchStub(): void {
  captured = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      json: async () => nextResponse,
      text: async () => JSON.stringify(nextResponse),
    };
  }) as typeof globalThis.fetch;
}

describe('ModelRouter ollama provider (ADR-0047 layer-2)', () => {
  beforeEach(() => { installFetchStub(); nextStatus = 200; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function router(baseUrl?: string): ModelRouter {
    return new ModelRouter({ provider: 'ollama', model: 'llama3', embeddingModel: 'nomic-embed-text', baseUrl });
  }

  it('chat → POST /api/chat（默认 baseUrl，含 model/messages/stream:false/options，无 apiKey 不带 auth）', async () => {
    nextResponse = { message: { content: '本地模型回复' } };
    const res = await router().chat(
      [{ role: 'user', content: '你好' }],
      { temperature: 0.3, maxTokens: 256 },
    );
    assert.equal(res.content, '本地模型回复');

    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.equal(req.url, 'http://localhost:11434/api/chat');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    /* 本地 provider 无 apiKey → 不应带 Authorization / x-api-key */
    assert.ok(!('authorization' in req.headers) && !('Authorization' in req.headers));
    assert.ok(!('x-api-key' in req.headers));
    const body = req.body as Record<string, unknown>;
    assert.equal(body.model, 'llama3');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
    const opts = body.options as Record<string, unknown>;
    assert.equal(opts.temperature, 0.3);
    assert.equal(opts.num_predict, 256);
  });

  it('embed → POST /api/embed（含 model=embeddingModel/input=texts），解析 embeddings', async () => {
    nextResponse = { embeddings: [[0.1, 0.2], [0.3, 0.4]] };
    const vecs = await router().embed(['a', 'b']);
    assert.deepEqual(vecs, [[0.1, 0.2], [0.3, 0.4]]);

    const req = captured[0];
    assert.equal(req.url, 'http://localhost:11434/api/embed');
    assert.equal(req.method, 'POST');
    const body = req.body as Record<string, unknown>;
    assert.equal(body.model, 'nomic-embed-text');
    assert.deepEqual(body.input, ['a', 'b']);
  });

  it('自定义 baseUrl 生效', async () => {
    nextResponse = { message: { content: 'x' } };
    await router('http://ollama.internal:11434').chat([{ role: 'user', content: 'hi' }]);
    assert.equal(captured[0].url, 'http://ollama.internal:11434/api/chat');
  });

  it('缺失字段安全降级：message.content 缺失 → 空串；embeddings 缺失 → 空数组', async () => {
    nextResponse = {};
    assert.equal((await router().chat([{ role: 'user', content: 'q' }])).content, '');
    nextResponse = {};
    assert.deepEqual(await router().embed(['x']), []);
  });

  it('chat 非 2xx 响应 → 抛错（不静默返回空）', async () => {
    nextStatus = 500;
    nextResponse = { error: 'model not found' };
    await assert.rejects(router().chat([{ role: 'user', content: 'q' }]));
  });

  it('embed 非 2xx 响应 → 抛错（不静默返回空）', async () => {
    nextStatus = 500;
    nextResponse = { error: 'embed model not found' };
    await assert.rejects(router().embed(['q']));
  });
});
