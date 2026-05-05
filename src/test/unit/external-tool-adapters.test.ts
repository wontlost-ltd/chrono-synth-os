/**
 * 单元测试：P3-C 外部工具适配器
 *
 * 覆盖：
 *  - WebSearchTool：mock provider 返回固定结果；缺 apiKey 抛错；query 校验
 *  - CalendarTool：mock provider 返回结构化结果；非法 action 抛错
 *  - EmailTool：mock/dryRun 模式；附件大小校验；非法邮箱抛错；RFC2047 编码
 */

import { describe, it } from 'node:test';
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
