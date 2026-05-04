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

export function registerBulkImportHandler(
  worker: TaskWorker,
  service: BulkImportService,
  logger: Logger,
): void {
  const handler: TaskHandler = async (task) => {
    let payload: BulkImportProcessInput;
    try {
      payload = JSON.parse(task.payload) as BulkImportProcessInput;
    } catch (err) {
      throw new Error(`bulk_knowledge_import payload 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    await service.processBatch(payload);
    logger.info('BulkImportWorker', `processBatch 完成 jobId=${payload.jobId}`);
  };

  worker.register(BULK_IMPORT_TASK_TYPE, handler, BULK_IMPORT_HANDLER_TIMEOUT_MS);
}
