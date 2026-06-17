/**
 * 认知模型存储 — 薄适配器，委托 kernel 领域服务
 */

import type { CognitiveModel } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getCognitiveModel, setCognitiveModel, cognitiveModelGet } from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork, CognitiveModelRow } from '@chrono/kernel';

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

  /**
   * 是否已写过认知模型 row（≠懒默认）。供「出生未演化 / 租户纯净」判定——看 row 存在性而非
   * updatedAt（setCognitiveModel 用 clock.now() 写 updatedAt，TestClock(0) 下 updatedAt 仍 0，
   * 用 updatedAt 会误判已写模型为未写）。与 DecisionStyleStore.exists() 同构。
   */
  exists(): boolean {
    const row = this.tx.queryOne(cognitiveModelGet(this.tenantId)) as CognitiveModelRow | null;
    return row !== null && !!row.modelJson;
  }

  /** 设置认知模型（合并更新） */
  set(patch: Partial<CognitiveModel>): CognitiveModel {
    return setCognitiveModel(this.tx, this.kernelClock, this.tenantId, patch);
  }
}
