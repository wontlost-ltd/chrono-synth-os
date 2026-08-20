/**
 * 审计 P0 回归：/metrics 的跨租户聚合必须只对**平台凭据**开放。
 *
 * 此前的行为：仅当 `metricsApiKeys` 非空时才收紧；**未配置时放行**（向后兼容）。
 * 后果是默认部署下任何租户的 JWT / API Key 都能读到 `/metrics`，而该端点输出
 * 逐租户用量与租户 ID —— 跨租户信息泄漏。
 *
 * 现在：未配置任何平台凭据 → fail-closed 403；配置了 metricsApiKeys 或
 * platformOperatorKeys → 仅这两类凭据可读。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { registerAuth } from '../../server/plugins/auth.js';
import { loadConfig } from '../../config/schema.js';

type Hook = (req: FastifyRequest, reply: FastifyReply, done: () => void) => unknown;

/** 装配 auth 插件并捕获它注册的 onRequest 钩子。 */
function captureHook(authOverrides: Record<string, unknown>): Hook {
  /* ⚠️ registerAuth 现在注册**两个** onRequest hook：先 metrics 门，
   * 再（可选的）通用 API-Key 认证。这里要的是**第一个**（metrics 门）——
   * 取最后一个会拿到 API-Key hook，断言全部失真。 */
  const hooks: Hook[] = [];
  const fakeApp = {
    addHook: (_name: string, fn: unknown) => { hooks.push(fn as Hook); },
    log: { warn: () => { /* noop */ } },
  } as unknown as Parameters<typeof registerAuth>[0];
  const config = loadConfig({
    auth: { enabled: true, apiKeys: [], metricsApiKeys: [], requireDbKeys: false, ...authOverrides },
  });
  registerAuth(fakeApp, config);
  const hook = hooks[0];
  if (!hook) throw new Error('registerAuth 未注册 onRequest hook');
  return hook;
}

/** 向 /metrics 发一次请求，返回 { statusCode, passed }。passed 表示放行到下游。 */
function callMetrics(hook: Hook, headers: Record<string, string>): {
  statusCode?: number; passed: boolean;
} {
  let statusCode: number | undefined;
  let passed = false;
  const req = {
    url: '/metrics', method: 'GET', headers, query: {},
  } as unknown as FastifyRequest;
  const reply = {
    status: (code: number) => { statusCode = code; return { send: () => reply }; },
  } as unknown as FastifyReply;
  hook(req, reply, () => { passed = true; });
  return { statusCode, passed };
}

describe('审计 P0 — /metrics 平台凭据门', () => {
  it('未配置任何平台凭据 → 持**有效租户静态 key** 也读不到（fail-closed）', () => {
    /* ⚠️ 这条断言必须用一把**合法的**租户 key，否则毫无意义：
     * 用随便一个无效 key 时，即便漏洞还在（fail-open），请求也会在下游
     * API-Key 校验处因「key 无效」被 403 —— 测试假通过。实测确认过这一点：
     * 最初写的无效 key 版本，在还原漏洞后依然是绿的。
     * 这里让 key 本身合法（apiKeys 里有它），于是唯一能拦住它的就是 metrics 门。 */
    const hook = captureHook({ apiKeys: ['valid-tenant-key'] });
    const r = callMetrics(hook, { 'x-api-key': 'valid-tenant-key' });
    assert.equal(r.passed, false, '未配置平台凭据时，合法租户 key 也不得读到跨租户指标');
    assert.equal(r.statusCode, 403);
  });

  it('配置 metricsApiKeys → 仅该 scrape key 可读', () => {
    const hook = captureHook({ metricsApiKeys: ['scrape-key'] });
    assert.equal(callMetrics(hook, { 'x-api-key': 'scrape-key' }).passed, true, 'scrape key 应放行');
    const wrong = callMetrics(hook, { 'x-api-key': 'tenant-key' });
    assert.equal(wrong.passed, false, '租户 key 必须被拒');
    assert.equal(wrong.statusCode, 403);
  });

  it('配置 platformOperatorKeys → 平台运营密钥也可读（免去再配一把 scrape key）', () => {
    const hook = captureHook({ platformOperatorKeys: ['platform-key'] });
    assert.equal(callMetrics(hook, { 'x-api-key': 'platform-key' }).passed, true);
    assert.equal(callMetrics(hook, { 'x-api-key': 'tenant-key' }).passed, false);
  });

  it('⚠️ auth.enabled=false 时门仍然生效（此前整个 hook 不注册 → 指标裸奔）', async () => {
    /* 交叉审查发现：metrics 门原先挂在 `registerAuth` 里，而该函数开头就
     * `if (!config.auth.enabled) return`。于是 auth 关闭的部署下 /metrics
     * **无任何凭据即 200**——实测确认过。现在门独立注册，不受该开关影响。 */
    const { ChronoSynthOS } = await import('../../chrono-synth-os.js');
    const { createApp } = await import('../../server/index.js');
    const { SilentLogger } = await import('../../utils/logger.js');
    const { TestClock } = await import('../../utils/clock.js');
    const cfg = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      auth: { enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false },
      jwt: { enabled: false, secret: 'x'.repeat(40), issuer: 'test' },
    });
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const app = await createApp({ os, config: cfg });
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(res.statusCode, 403, `auth 关闭时也必须 fail-closed，实际 ${res.statusCode}`);
    } finally { await app.close(); os.close(); }
  });

  it('Bearer 形式的平台凭据同样接受（Prometheus 常用 bearer_token）', () => {
    const hook = captureHook({ metricsApiKeys: ['scrape-key'] });
    const r = callMetrics(hook, { authorization: 'Bearer scrape-key' });
    assert.equal(r.passed, true, 'Bearer scrape key 应放行');
  });
});
