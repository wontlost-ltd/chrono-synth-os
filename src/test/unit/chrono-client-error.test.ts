/**
 * G2（全维度评审）——ChronoClient SDK 错误提取不裸传服务端响应体。
 *
 * 修复前：`throw new Error(\`API 错误 ${status}: ${await res.text()}\`)` 把原始响应体（可能含服务端
 * 内部串）二次传播给 SDK 应用层。修复=extractErrorMessage：5xx 一律通用文案（绝不回显 body），
 * 4xx 取结构化 {error|message} 并截断到 200 字符，非 JSON 回退截断文本。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoClient } from '../../sdk/chrono-client.js';

describe('G2 ChronoClient 错误提取（不裸传响应体）', () => {
  /** 造一个返回指定 status/body 的假 fetch。 */
  function clientReturning(status: number, body: string): ChronoClient {
    const fakeFetch = (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
    return new ChronoClient({ baseUrl: 'http://x', fetch: fakeFetch });
  }

  it('★5xx 一律通用文案★：绝不回显服务端 500 响应体（含内部串）', async () => {
    const client = clientReturning(500, 'Error: Cannot read property xyz of undefined at /app/src/db.ts:42');
    await assert.rejects(
      () => client.getValues(),
      (err: Error) => {
        assert.match(err.message, /API 错误 500: server error/);
        assert.doesNotMatch(err.message, /db\.ts|undefined|xyz/, '5xx 不得泄漏任何服务端内部串');
        return true;
      },
    );
  });

  it('★4xx 取结构化 error 字段★：业务错误对客户端有意义，回显 {error}', async () => {
    const client = clientReturning(400, JSON.stringify({ error: '参数 valueId 非法' }));
    await assert.rejects(
      () => client.getValues(),
      (err: Error) => {
        assert.match(err.message, /API 错误 400: 参数 valueId 非法/);
        return true;
      },
    );
  });

  it('★4xx 超长 body 截断★：防超长/日志污染（≤200 字符）', async () => {
    const longMsg = 'x'.repeat(500);
    const client = clientReturning(400, JSON.stringify({ message: longMsg }));
    await assert.rejects(
      () => client.getValues(),
      (err: Error) => {
        /* 提取的 message 部分不超过 200 字符（前缀 "API 错误 400: " 之外）。 */
        const extracted = err.message.replace(/^API 错误 400: /, '');
        assert.ok(extracted.length <= 200, `截断到 ≤200，实得 ${extracted.length}`);
        return true;
      },
    );
  });

  it('★4xx 非 JSON body 回退截断文本★', async () => {
    const client = clientReturning(404, 'Not Found plain text');
    await assert.rejects(
      () => client.getValues(),
      (err: Error) => {
        assert.match(err.message, /API 错误 404: Not Found plain text/);
        return true;
      },
    );
  });
});
