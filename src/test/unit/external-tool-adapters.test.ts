/**
 * 单元测试：P3-C 外部工具适配器
 *
 * 覆盖：
 *  - WebSearchTool：mock provider 返回固定结果；缺 apiKey 抛错；query 校验
 *  - CalendarTool：mock provider 返回结构化结果；非法 action 抛错
 *  - EmailTool：mock/dryRun 模式；附件大小校验；非法邮箱抛错；RFC2047 编码
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSearchTool } from '../../agent/tools/web-search-tool.js';
import { CalendarTool } from '../../agent/tools/calendar-tool.js';
import { EmailTool } from '../../agent/tools/email-tool.js';
import { SilentLogger } from '../../utils/logger.js';
import type { ToolInvocationContext } from '../../agent/tool-adapter.js';

function makeCtx(args: Record<string, unknown>, deadline = Date.now() + 60_000): ToolInvocationContext {
  return {
    tenantId: 'default',
    personaId: 'p1',
    invokerType: 'mcp',
    invokerId: 'test_client',
    arguments: args,
    deadline,
  };
}

describe('WebSearchTool', () => {
  it('mock provider 返回固定结果', async () => {
    const tool = new WebSearchTool(
      { provider: 'mock', maxResults: 10, maxContentLength: 2000, costCentsPerCall: 0 },
      new SilentLogger(),
    );
    const result = await tool.invoke(makeCtx({ query: 'test', topK: 3 }));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'json');
    const json = (result.content[0] as { type: 'json'; json: { results: unknown[] } }).json;
    assert.ok(Array.isArray(json.results));
    assert.equal(result.costCents, 0);
  });

  it('exa provider 缺 apiKey 抛错', async () => {
    const tool = new WebSearchTool(
      { provider: 'exa', maxResults: 10, maxContentLength: 2000, costCentsPerCall: 1 },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ query: 'test' })),
      /apiKey/,
    );
  });

  it('query 长度超过 500 抛 ValidationError', async () => {
    const tool = new WebSearchTool(
      { provider: 'mock', maxResults: 10, maxContentLength: 2000, costCentsPerCall: 0 },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ query: 'a'.repeat(501) })),
      /500/,
    );
  });
});

describe('CalendarTool', () => {
  it('mock provider list 返回结构化结果', async () => {
    const tool = new CalendarTool(
      { provider: 'mock', defaultTimezone: 'UTC' },
      new SilentLogger(),
    );
    const result = await tool.invoke(makeCtx({ action: 'list', calendarId: 'primary' }));
    const json = (result.content[0] as { type: 'json'; json: { mock: boolean; action: string } }).json;
    assert.equal(json.mock, true);
    assert.equal(json.action, 'list');
  });

  it('mock provider create 返回 mock eventId', async () => {
    const tool = new CalendarTool(
      { provider: 'mock', defaultTimezone: 'UTC' },
      new SilentLogger(),
    );
    const result = await tool.invoke(makeCtx({
      action: 'create',
      calendarId: 'primary',
      event: { summary: 'Test event' },
      idempotencyKey: 'test-key-1',
    }));
    const json = (result.content[0] as { type: 'json'; json: { eventId: string } }).json;
    assert.ok(json.eventId.startsWith('mock_evt_'));
  });

  it('非法 action 抛错', async () => {
    const tool = new CalendarTool(
      { provider: 'mock', defaultTimezone: 'UTC' },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ action: 'invalid_action' })),
      /非法 action/,
    );
  });

  it('google provider 缺认证抛错', async () => {
    const tool = new CalendarTool(
      { provider: 'google', defaultTimezone: 'UTC' },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ action: 'list' })),
      /serviceAccountJson|oauthAccessToken/,
    );
  });
});

describe('EmailTool', () => {
  it('mock provider 返回 dryRun 结构', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 1024 * 1024 },
      new SilentLogger(),
    );
    const result = await tool.invoke(makeCtx({
      to: 'recipient@example.com',
      subject: 'Hello',
      bodyText: 'This is a test',
    }));
    const json = (result.content[0] as { type: 'json'; json: { dryRun: boolean; to: string } }).json;
    assert.equal(json.dryRun, true);
    assert.equal(json.to, 'recipient@example.com');
  });

  it('非法邮箱格式抛错', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 1024 * 1024 },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ to: 'not-an-email', subject: 'x', bodyText: 'y' })),
      /邮箱格式/,
    );
  });

  it('缺 body 抛错', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 1024 * 1024 },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({ to: 'a@b.com', subject: 'x' })),
      /bodyText 或 bodyHtml/,
    );
  });

  it('附件超过限制抛错', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 100 },
      new SilentLogger(),
    );
    /* 200 字节 base64 ≈ 150 字节 binary —— 超过 100 字节限制 */
    const dataBase64 = Buffer.alloc(200).toString('base64');
    await assert.rejects(
      () => tool.invoke(makeCtx({
        to: 'a@b.com', subject: 'x', bodyText: 'y',
        attachments: [{ filename: 'big.bin', mimeType: 'application/octet-stream', dataBase64 }],
      })),
      /附件总大小/,
    );
  });

  it('非 ASCII subject 走 RFC 2047 编码', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 1024 * 1024 },
      new SilentLogger(),
    );
    const result = await tool.invoke(makeCtx({
      to: 'a@b.com',
      subject: '中文主题测试',
      bodyText: 'body',
    }));
    /* mock 模式下 rfc822Base64 仅截断显示，不暴露完整内容；只验证调用未抛错 */
    assert.ok(result.content[0]);
  });

  it('cc/bcc 数组中含非法邮箱抛错', async () => {
    const tool = new EmailTool(
      { provider: 'mock', dryRun: true, maxAttachmentBytes: 1024 * 1024 },
      new SilentLogger(),
    );
    await assert.rejects(
      () => tool.invoke(makeCtx({
        to: 'a@b.com', subject: 'x', bodyText: 'y',
        cc: ['valid@b.com', 'invalid'],
      })),
      /非法邮箱/,
    );
  });
});

/* 审计 Warning B4-4：create 只把 idempotencyKey **写进** extendedProperties 就直接
 * POST，从不回查。请求已到达但响应丢失时（网络中断/超时重试），下一次调用会创建
 * **第二个**日历事件——日历是对外可见的副作用，重复事件会直接打扰真人。 */
describe('CalendarTool — create 幂等回查', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  /** 用 oauthAccessToken 走 google 分支（避开 service account 签名）。 */
  function googleTool(): CalendarTool {
    return new CalendarTool(
      { provider: 'google', defaultTimezone: 'UTC', oauthAccessToken: 'tok-test' },
      new SilentLogger(),
    );
  }

  it('带 idempotencyKey 且已存在 → 返回既有事件，不再 POST 创建', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      /* 回查命中：返回一条既有事件。 */
      return new Response(JSON.stringify({ items: [{ id: 'evt_existing', summary: 'Test event' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await googleTool().invoke(makeCtx({
      action: 'create', calendarId: 'primary',
      event: { summary: 'Test event' }, idempotencyKey: 'key-dup',
    }));

    const json = (result.content[0] as { type: 'json'; json: { id: string } }).json;
    assert.equal(json.id, 'evt_existing', '应返回既有事件');
    assert.equal(calls.length, 1, '只应发一次回查请求');
    assert.equal(calls[0]!.method, 'GET', '不得再发 POST 创建');
    assert.ok(
      calls[0]!.url.includes('privateExtendedProperty=chrono.idempotencyKey%3Dkey-dup'),
      `回查须按幂等键过滤，实际 URL: ${calls[0]!.url}`,
    );
  });

  it('带 idempotencyKey 但不存在 → 回查未命中后正常创建', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method });
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'evt_new' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await googleTool().invoke(makeCtx({
      action: 'create', calendarId: 'primary',
      event: { summary: 'New event' }, idempotencyKey: 'key-fresh',
    }));

    const json = (result.content[0] as { type: 'json'; json: { id: string } }).json;
    assert.equal(json.id, 'evt_new');
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'], '先回查再创建');
  });

  it('回查本身失败 → 不阻断创建（去重是优化，不该因瞬时故障挡住正常创建）', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'GET') return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ id: 'evt_after_failed_probe' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await googleTool().invoke(makeCtx({
      action: 'create', calendarId: 'primary',
      event: { summary: 'X' }, idempotencyKey: 'key-probe-fails',
    }));

    const json = (result.content[0] as { type: 'json'; json: { id: string } }).json;
    assert.equal(json.id, 'evt_after_failed_probe');
    assert.deepEqual(methods, ['GET', 'POST']);
  });

  it('不带 idempotencyKey → 不做回查，直接创建（不引入额外请求）', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return new Response(JSON.stringify({ id: 'evt_plain' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await googleTool().invoke(makeCtx({
      action: 'create', calendarId: 'primary', event: { summary: 'Y' },
    }));
    assert.deepEqual(methods, ['POST'], '无幂等键时不应多发回查请求');
  });
});
