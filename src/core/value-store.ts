/**
 * 价值存储 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/value-executors.ts
 */

import type { CoreValue, ValueId } from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import {
  createValue, updateValue, getValueById, getAllValues,
  deleteValue, deleteAllValues, upsertValue,
} from '@chrono/kernel';
import type { KernelClock, KernelRandom, SyncWriteUnitOfWork } from '@chrono/kernel';

function toKernelClock(clock: Clock): KernelClock {
  return { now: () => clock.now() };
}

function toKernelRandom(): KernelRandom {
  return { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'val') };
}

export class ValueStore {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;

  constructor(uowOrDb: UowOrDb, clock: Clock) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.kernelClock = toKernelClock(clock);
    this.kernelRandom = toKernelRandom();
  }

  /** 创建新价值维度 */
  create(label: string, weight: number, timeDiscount = 0.5, emotionAmplifier = 1.0): CoreValue {
    return createValue(this.tx, this.kernelClock, this.kernelRandom, label, weight, timeDiscount, emotionAmplifier);
  }

  /** 更新价值权重（向后兼容） */
  updateWeight(id: ValueId, weight: number): CoreValue | undefined {
    return this.update(id, { weight });
  }

  /** 更新价值参数 */
  update(
    id: ValueId,
    patch: { weight?: number; timeDiscount?: number; emotionAmplifier?: number },
  ): CoreValue | undefined {
    return updateValue(this.tx, this.kernelClock, id, patch) ?? undefined;
  }

  /** 按 ID 获取 */
  getById(id: ValueId): CoreValue | undefined {
    return getValueById(this.tx, id) ?? undefined;
  }

  /** 获取全部价值 */
  getAll(): Map<ValueId, CoreValue> {
    return getAllValues(this.tx);
  }

  /** 删除价值 */
  delete(id: ValueId): boolean {
    return deleteValue(this.tx, id);
  }

  /** 删除全部价值 */
  deleteAll(): void {
    deleteAllValues(this.tx);
  }

  /** 按原始数据插入（恢复用，保留原 ID） */
  insert(value: CoreValue): void {
    upsertValue(this.tx, value);
  }
}
