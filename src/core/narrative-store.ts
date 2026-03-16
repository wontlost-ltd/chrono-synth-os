/**
 * 叙事存储 — 薄适配器，委托 kernel 领域服务
 */

import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { getNarrative, setNarrative } from '@chrono/kernel';
import type { KernelClock } from '@chrono/kernel';

export class NarrativeStore {
  private readonly tenantId: string;
  private readonly kernelClock: KernelClock;

  constructor(
    private readonly db: IDatabase,
    clock: Clock,
    tenantId = 'default',
  ) {
    registerCoreSelfExecutors();
    this.tenantId = tenantId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取当前叙事 */
  get(): string {
    const tx = directUnitOfWork(this.db);
    return getNarrative(tx, this.tenantId);
  }

  /** 设置叙事内容；返回旧叙事 */
  set(content: string): string {
    const tx = directUnitOfWork(this.db);
    return setNarrative(tx, this.kernelClock, this.tenantId, content);
  }
}
