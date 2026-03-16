/**
 * 叙事领域服务 — 纯业务逻辑
 */

import type { KernelClock } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import { narrativeGet, narrativeSetCmd } from './narrative-queries.js';

/** 获取当前叙事（未设置时返回空字符串） */
export function getNarrative(tx: SyncReadUnitOfWork, tenantId: string): string {
  const result = tx.queryOne(narrativeGet(tenantId));
  return (result as string | null) ?? '';
}

/** 设置叙事内容，返回旧叙事 */
export function setNarrative(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  tenantId: string,
  content: string,
): string {
  const previous = getNarrative(tx, tenantId);
  tx.execute(narrativeSetCmd({ tenantId, content, updatedAt: clock.now() }));
  return previous;
}
