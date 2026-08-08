/**
 * 批量导入 worker 的载荷守卫（审计 Warning B4-13）。
 *
 * 原实现把队列载荷 `JSON.parse` 后直接 `as BulkImportProcessInput` 断言，
 * 随后原样交给 service。两个后果：
 *   ① **租户越界**：payload.tenantId 是载荷自述，与队列行的 task.tenantId 无任何
 *      比对。载荷被篡改或入队方写错时，知识会被写进**另一个租户**；
 *   ② **形状谎言**：`as` 只是编译期断言，运行时任何形状都放行——缺 personaId 会让
 *      下游按 undefined 定位人格，sources 非数组会在遍历时抛难以定位的 TypeError。
 *
 * 队列行是唯一可信来源（入队时由服务端写入，worker 也以它开 runWithTenant 上下文）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerBulkImportHandler, BULK_IMPORT_HANDLER_TIMEOUT_MS } from '../../knowledge/bulk-import-worker.js';
import { BULK_IMPORT_TASK_TYPE, type BulkImportService } from '../../knowledge/bulk-import-service.js';
import type { TaskHandler } from '../../queue/task-worker.js';
import type { TaskWorker } from '../../queue/task-worker.js';
import type { TaskRecord } from '../../queue/task-queue.js';
import type { Logger } from '../../utils/logger.js';

/** 捕获 register 进来的 handler，直接驱动它（不起真队列）。 */
function captureHandler(processed: unknown[]): TaskHandler {
  let captured: TaskHandler | undefined;
  const worker = {
    register: (_type: string, h: TaskHandler, _timeout: number) => { captured = h; },
  } as unknown as TaskWorker;
  const service = {
    processBatch: async (input: unknown) => { processed.push(input); },
  } as unknown as BulkImportService;
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

  registerBulkImportHandler(worker, service, logger);
  assert.ok(captured, 'handler 应已注册');
  return captured;
}

function makeTask(tenantId: string, payload: unknown): TaskRecord {
  return {
    id: 'task_1', tenantId, type: BULK_IMPORT_TASK_TYPE,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    status: 'running', result: null, error: null,
    retryCount: 0, maxRetries: 3, createdAt: 0, updatedAt: 0,
    availableAt: 0, claimedBy: 'w1', claimedAt: 0,
  };
}

const VALID = {
  jobId: 'job_1', tenantId: 'tenant_a', personaId: 'persona_1',
  ownerUserId: 'user_1', sources: [], deduplicateStrategy: 'skip',
};

describe('BulkImportWorker 载荷守卫', () => {
  it('租户一致 → 正常执行', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    await handler(makeTask('tenant_a', VALID), new AbortController().signal);
    assert.equal(processed.length, 1, '应交给 service 处理');
  });

  it('载荷 tenantId 与队列行不符 → 拒绝执行（防跨租户写入）', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    await assert.rejects(
      () => handler(makeTask('tenant_a', { ...VALID, tenantId: 'tenant_victim' }), new AbortController().signal),
      /租户不符/,
    );
    assert.equal(processed.length, 0, '绝不能交给 service 执行');
  });

  it('缺 personaId → 拒绝', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    const { personaId: _drop, ...rest } = VALID;
    await assert.rejects(
      () => handler(makeTask('tenant_a', rest), new AbortController().signal),
      /缺少必填字段: personaId/,
    );
    assert.equal(processed.length, 0);
  });

  it('sources 非数组 → 拒绝（防下游遍历时抛难定位的 TypeError）', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    await assert.rejects(
      () => handler(makeTask('tenant_a', { ...VALID, sources: 'not-an-array' }), new AbortController().signal),
      /sources 必须是数组/,
    );
    assert.equal(processed.length, 0);
  });

  it('载荷非对象（如裸字符串 JSON）→ 拒绝', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    await assert.rejects(
      () => handler(makeTask('tenant_a', '"just-a-string"'), new AbortController().signal),
      /payload 非对象/,
    );
    assert.equal(processed.length, 0);
  });

  it('非法 JSON → 拒绝并带出解析错误', async () => {
    const processed: unknown[] = [];
    const handler = captureHandler(processed);
    await assert.rejects(
      () => handler(makeTask('tenant_a', '{not json'), new AbortController().signal),
      /payload 解析失败/,
    );
    assert.equal(processed.length, 0);
  });

  it('超时常量按 600s 注册（回归保护）', () => {
    assert.equal(BULK_IMPORT_HANDLER_TIMEOUT_MS, 600_000);
  });
});
