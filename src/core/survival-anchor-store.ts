/**
 * 生存锚点存储 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/anchor-executors.ts
 */

import type { SurvivalAnchor, SurvivalAnchorKind } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import {
  createAnchor, updateAnchor, getAnchorById, getAllAnchors,
  deleteAnchor, deleteAllAnchors, upsertAnchor,
} from '@chrono/kernel';
import type {
  KernelClock, KernelRandom, SurvivalAnchorPatch, SyncWriteUnitOfWork,
} from '@chrono/kernel';

/** 向后兼容别名 */
export type SurvivalAnchorUpdate = SurvivalAnchorPatch;

function toKernelClock(clock: Clock): KernelClock {
  return { now: () => clock.now() };
}

function toKernelRandom(): KernelRandom {
  return { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'anchor') };
}

export class SurvivalAnchorStore {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;

  constructor(uowOrDb: UowOrDb, clock: Clock) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.kernelClock = toKernelClock(clock);
    this.kernelRandom = toKernelRandom();
  }

  /** 创建生存锚点 */
  create(label: string, kind: SurvivalAnchorKind, value: unknown, severity: number): SurvivalAnchor {
    return createAnchor(this.tx, this.kernelClock, this.kernelRandom, label, kind, value, severity);
  }

  /** 更新生存锚点 */
  update(id: string, patch: SurvivalAnchorUpdate): SurvivalAnchor | undefined {
    return updateAnchor(this.tx, this.kernelClock, id, patch) ?? undefined;
  }

  /** 按 ID 获取 */
  getById(id: string): SurvivalAnchor | undefined {
    return getAnchorById(this.tx, id) ?? undefined;
  }

  /** 获取全部锚点 */
  getAll(): SurvivalAnchor[] {
    return getAllAnchors(this.tx);
  }

  /** 删除锚点 */
  delete(id: string): boolean {
    return deleteAnchor(this.tx, id);
  }

  /** 删除全部 */
  deleteAll(): void {
    deleteAllAnchors(this.tx);
  }

  /** 按原始数据插入（恢复用） */
  insert(anchor: SurvivalAnchor): void {
    upsertAnchor(this.tx, anchor);
  }
}
