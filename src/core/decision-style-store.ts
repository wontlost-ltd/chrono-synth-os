/**
 * 决策风格存储 — 薄适配器，委托 kernel 领域服务
 */

import type { IDatabase } from '../storage/database.js';
import type { DecisionStyle } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import {
  getDecisionStyle, setDecisionStyle,
  DEFAULT_DECISION_STYLE,
} from '@chrono/kernel';
import type { KernelClock } from '@chrono/kernel';

export { DEFAULT_DECISION_STYLE };

export class DecisionStyleStore {
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

  /** 获取决策风格（未设置时返回默认值） */
  get(): DecisionStyle {
    const tx = directUnitOfWork(this.db);
    return getDecisionStyle(tx, this.tenantId);
  }

  /** 设置决策风格（合并更新） */
  set(patch: Partial<DecisionStyle>): DecisionStyle {
    const tx = directUnitOfWork(this.db);
    return setDecisionStyle(tx, this.kernelClock, this.tenantId, patch);
  }
}
