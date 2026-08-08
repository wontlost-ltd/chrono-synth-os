/**
 * 批量知识导入 TaskWorker handler 工厂（P1-B）
 *
 * 通过 TaskWorker.register 注册到现有的任务队列分发框架，避免与其他 worker
 * 抢占 dequeue。timeout 设置为 600s（500 条 source 上限 × ~1s/source URL fetch
 * 最坏情况）。
 */

import type { TaskWorker, TaskHandler } from '../queue/task-worker.js';
import type { BulkImportService, BulkImportProcessInput } from './bulk-import-service.js';
import { BULK_IMPORT_TASK_TYPE } from './bulk-import-service.js';
import type { Logger } from '../utils/logger.js';

export const BULK_IMPORT_HANDLER_TIMEOUT_MS = 600_000;

/**
 * 校验 JSON.parse 出来的载荷形状。
 *
 * 原实现直接 `as BulkImportProcessInput` 断言——那只是编译期谎言，运行时任何形状
 * 都会被放行：缺 personaId 会让下游按 undefined 定位人格，sources 非数组会在遍历时
 * 抛出难以定位的 TypeError。队列载荷是**跨进程边界**的外部输入，必须真校验。
 */
function assertBulkImportPayload(value: unknown): BulkImportProcessInput {
  if (value === null || typeof value !== 'object') {
    throw new Error('bulk_knowledge_import payload 非对象');
  }
  const p = value as Record<string, unknown>;
  for (const key of ['jobId', 'tenantId', 'personaId', 'ownerUserId'] as const) {
    if (typeof p[key] !== 'string' || (p[key] as string).length === 0) {
      throw new Error(`bulk_knowledge_import payload 缺少必填字段: ${key}`);
    }
  }
  if (!Array.isArray(p.sources)) {
    throw new Error('bulk_knowledge_import payload.sources 必须是数组');
  }
  return value as BulkImportProcessInput;
}

export function registerBulkImportHandler(
  worker: TaskWorker,
  service: BulkImportService,
  logger: Logger,
): void {
  const handler: TaskHandler = async (task) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(task.payload);
    } catch (err) {
      throw new Error(`bulk_knowledge_import payload 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = assertBulkImportPayload(parsed);

    /* 租户绑定：payload 里的 tenantId 是**载荷自述**，而 task.tenantId 来自队列行
     * （入队时由服务端写入，worker 也以它开 runWithTenant 上下文）。二者不一致意味着
     * 载荷被篡改或入队方写错——此时按载荷 tenantId 执行会把知识写进**另一个租户**。
     * 队列行是唯一可信来源，故不一致一律拒绝，绝不"以载荷为准"。 */
    if (payload.tenantId !== task.tenantId) {
      throw new Error(
        `bulk_knowledge_import 租户不符，拒绝执行：队列=${task.tenantId} 载荷=${payload.tenantId}`,
      );
    }

    await service.processBatch(payload);
    logger.info('BulkImportWorker', `processBatch 完成 jobId=${payload.jobId}`);
  };

  worker.register(BULK_IMPORT_TASK_TYPE, handler, BULK_IMPORT_HANDLER_TIMEOUT_MS);
}
