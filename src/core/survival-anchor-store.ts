/**
 * 生存锚点存储 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/anchor-executors.ts
 */

import type { IDatabase } from '../storage/database.js';
import type { SurvivalAnchor, SurvivalAnchorKind } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import {
  createAnchor, updateAnchor, getAnchorById, getAllAnchors,
  deleteAnchor, deleteAllAnchors, upsertAnchor,
} from '@chrono/kernel';
import type { KernelClock, KernelRandom, SurvivalAnchorPatch } from '@chrono/kernel';

/** 向后兼容别名 */
export type SurvivalAnchorUpdate = SurvivalAnchorPatch;

function toKernelClock(clock: Clock): KernelClock {
  return { now: () => clock.now() };
}

function toKernelRandom(): KernelRandom {
  return { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'anchor') };
}

export class SurvivalAnchorStore {
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;

  constructor(
    private readonly db: IDatabase,
    clock: Clock,
  ) {
    registerCoreSelfExecutors();
    this.kernelClock = toKernelClock(clock);
    this.kernelRandom = toKernelRandom();
  }

  /** 创建生存锚点 */
  create(label: string, kind: SurvivalAnchorKind, value: unknown, severity: number): SurvivalAnchor {
    const tx = directUnitOfWork(this.db);
    return createAnchor(tx, this.kernelClock, this.kernelRandom, label, kind, value, severity);
  }

  /** 更新生存锚点 */
  update(id: string, patch: SurvivalAnchorUpdate): SurvivalAnchor | undefined {
    const tx = directUnitOfWork(this.db);
    return updateAnchor(tx, this.kernelClock, id, patch) ?? undefined;
  }

  /** 按 ID 获取 */
  getById(id: string): SurvivalAnchor | undefined {
    const tx = directUnitOfWork(this.db);
    return getAnchorById(tx, id) ?? undefined;
  }

  /** 获取全部锚点 */
  getAll(): SurvivalAnchor[] {
    const tx = directUnitOfWork(this.db);
    return getAllAnchors(tx);
  }

  /** 删除锚点 */
  delete(id: string): boolean {
    const tx = directUnitOfWork(this.db);
    return deleteAnchor(tx, id);
  }

  /** 删除全部 */
  deleteAll(): void {
    const tx = directUnitOfWork(this.db);
    deleteAllAnchors(tx);
  }

  /** 按原始数据插入（恢复用） */
  insert(anchor: SurvivalAnchor): void {
    const tx = directUnitOfWork(this.db);
    upsertAnchor(tx, anchor);
  }
}
