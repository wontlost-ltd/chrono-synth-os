/**
 * 叙事存储 — 薄适配器，委托 kernel 领域服务
 */

import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getNarrative, setNarrative } from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork } from '@chrono/kernel';

export class NarrativeStore {
  private readonly tenantId: string;
  private readonly personaId: string;
  private readonly kernelClock: KernelClock;

  constructor(private readonly tx: SyncWriteUnitOfWork, clock: Clock, tenantId = 'default', personaId = 'default') {
    registerCoreSelfExecutors();
    this.tenantId = tenantId;
    this.personaId = personaId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取当前叙事 */
  get(): string {
    return getNarrative(this.tx, this.tenantId, this.personaId);
  }

  /** 设置叙事内容；返回旧叙事 */
  set(content: string): string {
    return setNarrative(this.tx, this.kernelClock, this.tenantId, content, this.personaId);
  }
}
