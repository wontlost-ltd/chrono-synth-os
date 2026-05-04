/**
 * 对话审计发布器（P1-C 加固 12）
 *
 * 设计原则：
 *   1. 同步写入审计表 —— SQLite 同进程插入仅 ~0.5ms，比异步出 outbox 更可靠
 *   2. 序列化 + DB 写入包裹 try/catch，绝不让审计失败传播为 500
 *   3. 写入失败回退到 logger.error 记录到日志侧通道，便于事后追溯
 *
 * 之前 ConversationService 直调 recordBusinessAuditLog；现在改为通过此 publisher，
 * 集中处理 PII payload 截断、错误隔离与未来切换到真正异步 outbox 的扩展点。
 */

import type { IDatabase } from '../storage/database.js';
import { unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import type { Logger } from '../utils/logger.js';
import { recordBusinessAuditLog, type BusinessAuditInput } from '../audit/audit-log-store.js';

const PAYLOAD_VALUE_MAX = 1024;

export class ConversationAuditPublisher {
  private readonly db: IDatabase | null;

  constructor(
    uowOrDb: UowOrDb,
    private readonly logger: Logger,
  ) {
    this.db = unwrapDb(uowOrDb);
  }

  publish(event: BusinessAuditInput): void {
    const safe: BusinessAuditInput = {
      ...event,
      payload: event.payload ? truncatePayloadValues(event.payload, PAYLOAD_VALUE_MAX) : event.payload,
    };
    if (!this.db) {
      this.logger.warn(
        'ConversationAuditPublisher',
        `[uow-mode] 跳过审计写入 actionType=${event.actionType} target=${event.targetId}`,
      );
      return;
    }
    try {
      recordBusinessAuditLog(this.db, safe);
    } catch (err) {
      this.logger.error(
        'ConversationAuditPublisher',
        `审计写入失败 actionType=${event.actionType} target=${event.targetId}`,
        err,
      );
    }
  }
}

function truncatePayloadValues(payload: Record<string, unknown>, max: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > max) {
      out[k] = `${v.slice(0, max)}…[truncated ${v.length - max} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
