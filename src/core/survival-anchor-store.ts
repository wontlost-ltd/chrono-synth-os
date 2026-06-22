/**
 * 生存锚点存储 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/anchor-executors.ts
 */

import type { SurvivalAnchor, SurvivalAnchorKind } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
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
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;
  private readonly personaId: string;

  constructor(private readonly tx: SyncWriteUnitOfWork, clock: Clock, personaId = 'default') {
    registerCoreSelfExecutors();
    this.kernelClock = toKernelClock(clock);
    this.kernelRandom = toKernelRandom();
    this.personaId = personaId;
  }

  /** 创建生存锚点 */
  create(label: string, kind: SurvivalAnchorKind, value: unknown, severity: number): SurvivalAnchor {
    return createAnchor(this.tx, this.kernelClock, this.kernelRandom, label, kind, value, severity, this.personaId);
  }

  /** 更新生存锚点 */
  update(id: string, patch: SurvivalAnchorUpdate): SurvivalAnchor | undefined {
    return updateAnchor(this.tx, this.kernelClock, id, patch, this.personaId) ?? undefined;
  }

  /** 按 ID 获取 */
  getById(id: string): SurvivalAnchor | undefined {
    return getAnchorById(this.tx, id, this.personaId) ?? undefined;
  }

  /** 获取全部锚点 */
  getAll(): SurvivalAnchor[] {
    return getAllAnchors(this.tx, this.personaId);
  }

  /** 删除锚点 */
  delete(id: string): boolean {
    return deleteAnchor(this.tx, id, this.personaId);
  }

  /** 删除全部 */
  deleteAll(): void {
    deleteAllAnchors(this.tx, this.personaId);
  }

  /** 按原始数据插入（恢复用） */
  insert(anchor: SurvivalAnchor): void {
    upsertAnchor(this.tx, anchor, this.personaId);
  }
}
