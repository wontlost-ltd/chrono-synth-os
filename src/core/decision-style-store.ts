/**
 * 决策风格存储 — 薄适配器，委托 kernel 领域服务
 */

import type { DecisionStyle } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import {
  getDecisionStyle, setDecisionStyle,
  DEFAULT_DECISION_STYLE,
} from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork } from '@chrono/kernel';

export { DEFAULT_DECISION_STYLE };

export class DecisionStyleStore {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly tenantId: string;
  private readonly kernelClock: KernelClock;

  constructor(uowOrDb: UowOrDb, clock: Clock, tenantId = 'default') {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.tenantId = tenantId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取决策风格（未设置时返回默认值） */
  get(): DecisionStyle {
    return getDecisionStyle(this.tx, this.tenantId);
  }

  /** 设置决策风格（合并更新） */
  set(patch: Partial<DecisionStyle>): DecisionStyle {
    return setDecisionStyle(this.tx, this.kernelClock, this.tenantId, patch);
  }
}
