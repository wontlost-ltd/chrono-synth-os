/**
 * 决策风格存储 — 薄适配器，委托 kernel 领域服务
 */

import type { DecisionStyle } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import {
  getDecisionStyle, setDecisionStyle, decisionStyleGet,
  DEFAULT_DECISION_STYLE,
} from '@chrono/kernel';
import type { KernelClock, SyncWriteUnitOfWork, DecisionStyleRow } from '@chrono/kernel';

export { DEFAULT_DECISION_STYLE };

export class DecisionStyleStore {
  private readonly tenantId: string;
  private readonly personaId: string;
  private readonly kernelClock: KernelClock;

  constructor(private readonly tx: SyncWriteUnitOfWork, clock: Clock, tenantId = 'default', personaId = 'default') {
    registerCoreSelfExecutors();
    this.tenantId = tenantId;
    this.personaId = personaId;
    this.kernelClock = { now: () => clock.now() };
  }

  /** 获取决策风格（未设置时返回默认值） */
  get(): DecisionStyle {
    return getDecisionStyle(this.tx, this.tenantId, this.personaId);
  }

  /**
   * 是否已写过决策风格 row（≠懒默认）。供「出生未演化」判定——比看 updatedAt 可靠：
   * setDecisionStyle 用 clock.now() 写 updatedAt，时钟从 0 起时 updatedAt 仍是 0，用 updatedAt===0
   * 判「未演化」会误判已扰动的 persona（Codex 复审）。直接看 row 存在性，与时钟无关。
   */
  exists(): boolean {
    const row = this.tx.queryOne(decisionStyleGet(this.tenantId, this.personaId)) as DecisionStyleRow | null;
    return row !== null && !!row.styleJson;
  }

  /** 设置决策风格（合并更新） */
  set(patch: Partial<DecisionStyle>): DecisionStyle {
    return setDecisionStyle(this.tx, this.kernelClock, this.tenantId, patch, this.personaId);
  }
}
