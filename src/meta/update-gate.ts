/**
 * 更新闸门：L0/L1 更新确认机制
 */

import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export type UpdateTrigger = 'emotional_event' | 'statistical_drift' | 'user_confirmation' | 'system_integration';

export interface UpdateGateConfig {
  l0RequiresConfirmation: boolean;
  l1ConfirmationThreshold: number;
  driftWindowMs: number;
  driftSignificanceThreshold: number;
}

export interface PendingUpdate {
  readonly id: string;
  readonly layer: 'L0' | 'L1';
  readonly trigger: UpdateTrigger;
  readonly targetId: string;
  readonly currentValue: string;
  readonly proposedValue: string;
  readonly delta: number;
  readonly reason: string;
  readonly createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

const DEFAULT_CONFIG: UpdateGateConfig = {
  l0RequiresConfirmation: true,
  l1ConfirmationThreshold: 0.15,
  driftWindowMs: 86_400_000,
  driftSignificanceThreshold: 0.3,
};

interface PendingUpdateRow {
  id: string;
  layer: 'L0' | 'L1';
  trigger_type: UpdateTrigger;
  target_id: string;
  current_value: string | null;
  proposed_value: string | null;
  delta: number;
  reason: string | null;
  created_at: number;
  status: 'pending' | 'approved' | 'rejected';
}

const LAYER = 'UpdateGate';

export class UpdateGate {
  private readonly config: UpdateGateConfig;

  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    config?: Partial<UpdateGateConfig>,
    private readonly logger?: Logger,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  requiresConfirmation(layer: 'L0' | 'L1', delta: number): boolean {
    if (layer === 'L0') return this.config.l0RequiresConfirmation;
    return Math.abs(delta) > this.config.l1ConfirmationThreshold;
  }

  propose(update: Omit<PendingUpdate, 'id' | 'createdAt' | 'status'>): PendingUpdate {
    const id = generatePrefixedId('upd');
    const createdAt = this.clock.now();
    const pending: PendingUpdate = {
      ...update,
      id,
      createdAt,
      status: 'pending',
    };

    this.db.prepare<void>(
      `INSERT INTO pending_updates
      (id, layer, trigger_type, target_id, current_value, proposed_value, delta, reason, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pending.id,
      pending.layer,
      pending.trigger,
      pending.targetId,
      pending.currentValue,
      pending.proposedValue,
      pending.delta,
      pending.reason,
      pending.createdAt,
      pending.status,
    );

    this.logger?.info(LAYER, `提案已创建: ${pending.id} [${pending.layer}] ${pending.targetId} delta=${pending.delta.toFixed(4)}`);
    return pending;
  }

  approve(id: string): PendingUpdate | undefined {
    const result = this.db.prepare<void>(
      "UPDATE pending_updates SET status = ? WHERE id = ? AND status = 'pending'",
    ).run('approved', id);
    if (result.changes === 0) return undefined;
    this.logger?.info(LAYER, `提案已批准: ${id}`);
    return this.getById(id);
  }

  reject(id: string): PendingUpdate | undefined {
    const result = this.db.prepare<void>(
      "UPDATE pending_updates SET status = ? WHERE id = ? AND status = 'pending'",
    ).run('rejected', id);
    if (result.changes === 0) return undefined;
    this.logger?.info(LAYER, `提案已拒绝: ${id}`);
    return this.getById(id);
  }

  getPending(): PendingUpdate[] {
    const rows = this.db.prepare<PendingUpdateRow>(
      'SELECT * FROM pending_updates WHERE status = ? ORDER BY created_at',
    ).all('pending');
    return rows.map(row => this.toPending(row));
  }

  /**
   * 便捷方法：评估变更是否需要确认，自动应用或挂起
   * - 不需要确认 → 直接调用 applyFn → { applied: true }
   * - 需要确认 → 创建 pending_update → { applied: false, pendingUpdate }
   */
  tryApply(
    layer: 'L0' | 'L1',
    trigger: UpdateTrigger,
    targetId: string,
    currentValue: string,
    proposedValue: string,
    delta: number,
    reason: string,
    applyFn: () => void,
  ): { applied: boolean; pendingUpdate?: PendingUpdate } {
    if (!this.requiresConfirmation(layer, delta)) {
      try {
        applyFn();
      } catch (err) {
        this.logger?.warn(LAYER, `变更应用失败: [${layer}] ${targetId}`, err);
        throw err;
      }
      this.logger?.info(LAYER, `变更已直接应用: [${layer}] ${targetId} delta=${delta.toFixed(4)}`);
      return { applied: true };
    }
    const pendingUpdate = this.propose({ layer, trigger, targetId, currentValue, proposedValue, delta, reason });
    this.logger?.info(LAYER, `变更需要确认: [${layer}] ${targetId} → pending ${pendingUpdate.id}`);
    return { applied: false, pendingUpdate };
  }

  getById(id: string): PendingUpdate | undefined {
    const row = this.db.prepare<PendingUpdateRow>(
      'SELECT * FROM pending_updates WHERE id = ?',
    ).get(id);
    return row ? this.toPending(row) : undefined;
  }

  private toPending(row: PendingUpdateRow): PendingUpdate {
    return {
      id: row.id,
      layer: row.layer,
      trigger: row.trigger_type,
      targetId: row.target_id,
      currentValue: row.current_value ?? '',
      proposedValue: row.proposed_value ?? '',
      delta: row.delta,
      reason: row.reason ?? '',
      createdAt: row.created_at,
      status: row.status,
    };
  }
}
