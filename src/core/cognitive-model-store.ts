/**
 * 认知模型存储 — 薄适配器，委托 kernel 领域服务
 */

import type { CognitiveModel } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getCognitiveModel, setCognitiveModel } from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork } from '@chrono/kernel';

export class CognitiveModelStore {
  private readonly tenantId: string;
  private readonly kernelClock: KernelClock;

  constructor(private readonly tx: SyncWriteUnitOfWork, clock: Clock, tenantId = 'default') {
    registerCoreSelfExecutors();
    this.tenantId = tenantId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取认知模型（未设置时返回默认值） */
  get(): CognitiveModel {
    return getCognitiveModel(this.tx, this.tenantId);
  }

  /** 设置认知模型（合并更新） */
  set(patch: Partial<CognitiveModel>): CognitiveModel {
    return setCognitiveModel(this.tx, this.kernelClock, this.tenantId, patch);
  }
}
