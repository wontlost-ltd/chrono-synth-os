/**
 * 叙事存储 — 薄适配器，委托 kernel 领域服务
 */

import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { getNarrative, setNarrative } from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork } from '@chrono/kernel';

export class NarrativeStore {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly tenantId: string;
  private readonly kernelClock: KernelClock;

  constructor(uowOrDb: UowOrDb, clock: Clock, tenantId = 'default') {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.tenantId = tenantId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取当前叙事 */
  get(): string {
    return getNarrative(this.tx, this.tenantId);
  }

  /** 设置叙事内容；返回旧叙事 */
  set(content: string): string {
    return setNarrative(this.tx, this.kernelClock, this.tenantId, content);
  }
}
