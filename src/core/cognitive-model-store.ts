/**
 * 认知模型存储 — 薄适配器，委托 kernel 领域服务
 */

import type { IDatabase } from '../storage/database.js';
import type { CognitiveModel } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { getCognitiveModel, setCognitiveModel } from '@chrono/kernel';
import type { KernelClock } from '@chrono/kernel';

export class CognitiveModelStore {
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

  /** 获取认知模型（未设置时返回默认值） */
  get(): CognitiveModel {
    const tx = directUnitOfWork(this.db);
    return getCognitiveModel(tx, this.tenantId);
  }

  /** 设置认知模型（合并更新） */
  set(patch: Partial<CognitiveModel>): CognitiveModel {
    const tx = directUnitOfWork(this.db);
    return setCognitiveModel(tx, this.kernelClock, this.tenantId, patch);
  }
}
