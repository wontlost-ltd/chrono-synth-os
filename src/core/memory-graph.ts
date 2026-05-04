/**
 * 认知记忆图 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/memory-executors.ts
 *
 * 事务管理策略：
 *   多步原子操作（decayAll、consolidateAll 等）需要跨多个 kernel 函数共享
 *   一个事务。SyncWriteUnitOfWork 抽象本身不管理事务范围；为了维持
 *   原子性同时不破坏多运行时目标，我们保留 IDatabase 入口分支，仅
 *   在 IDatabase 形态下启用 db.transaction() 包裹。
 *
 *   从已迁移的 SyncWriteUnitOfWork 入口进入时，调用方应在外层用
 *   factory.write() 自己包裹事务范围；我们的多步方法直接执行（不再嵌套
 *   db.transaction）。这与 kernel domain function 的同步语义完全契合。
 */

import type { IDatabase } from '../storage/database.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type {
  MemoryNode, MemoryEdge, MemoryId, MemoryKind,
  MemoryCognitionConfig, WorkingMemorySlot, ActivationResult, ConsolidationResult, EvictionResult,
} from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { asUow, unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import type { KernelClock, KernelRandom, ContentEncryptor, SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  DEFAULT_COGNITION_CONFIG, mergeMemoryConfig, NOOP_ENCRYPTOR,
  addMemory, accessMemory, getMemory, getMemoryBatch, getAllMemories,
  getMemoriesPaginated, addEdge, getAllEdges, getEdgesFor,
  deleteMemory, deleteAllMemories, insertMemory,
  decayAll, spreadActivation,
  admitToWorkingMemory, getWorkingMemorySlots, refreshWorkingMemory, removeFromWorkingMemory,
  findConsolidationCandidates, consolidateMemory, consolidateAll,
  getRelatedMemories, getMemoryCount, evictExcess,
} from '@chrono/kernel';

export { DEFAULT_COGNITION_CONFIG };

/** FieldEncryption → ContentEncryptor 适配 */
function toContentEncryptor(encryption?: FieldEncryption): ContentEncryptor {
  if (!encryption?.isEnabled) return NOOP_ENCRYPTOR;
  return {
    encrypt: (content: string) => encryption.encrypt(content),
    decrypt: (content: string) => encryption.decrypt(content),
  };
}

export class CognitiveMemoryGraph {
  private readonly tx: SyncWriteUnitOfWork;
  /** 仅在 IDatabase 形态下持有；用于多步原子操作的 db.transaction 包裹。
   *  调用方传入 SyncWriteUnitOfWork 时应自行管理事务范围（factory.write） */
  private readonly db: IDatabase | null;
  private readonly config: MemoryCognitionConfig;
  private readonly encryptor: ContentEncryptor;
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;

  constructor(
    uowOrDb: UowOrDb,
    clock: Clock,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
  ) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.db = unwrapDb(uowOrDb);
    this.config = config ? mergeMemoryConfig(DEFAULT_COGNITION_CONFIG, config) : DEFAULT_COGNITION_CONFIG;
    this.encryptor = toContentEncryptor(encryption);
    this.kernelClock = { now: () => clock.now() };
    this.kernelRandom = { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'mem') };
  }

  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    return addMemory(this.tx, this.kernelClock, this.kernelRandom, this.config, this.encryptor, kind, content, valence, salience);
  }

  accessMemory(id: MemoryId): MemoryNode | undefined {
    return accessMemory(this.tx, this.kernelClock, this.config, this.encryptor, id) ?? undefined;
  }

  getMemory(id: MemoryId): MemoryNode | undefined {
    return getMemory(this.tx, this.encryptor, id) ?? undefined;
  }

  getMemoryBatch(ids: MemoryId[]): Map<MemoryId, MemoryNode> {
    return getMemoryBatch(this.tx, this.encryptor, ids);
  }

  getAllMemories(): Map<MemoryId, MemoryNode> {
    return getAllMemories(this.tx, this.encryptor);
  }

  getMemoriesPaginated(limit: number, offset: number): { nodes: MemoryNode[]; total: number } {
    return getMemoriesPaginated(this.tx, this.encryptor, limit, offset);
  }

  addEdge(source: MemoryId, target: MemoryId, relation: string, strength: number): MemoryEdge {
    return addEdge(this.tx, source, target, relation, strength);
  }

  getAllEdges(): MemoryEdge[] {
    return getAllEdges(this.tx);
  }

  getEdgesFor(id: MemoryId): MemoryEdge[] {
    return getEdgesFor(this.tx, id);
  }

  deleteMemory(id: MemoryId): boolean {
    return deleteMemory(this.tx, id);
  }

  deleteAll(): void {
    deleteAllMemories(this.tx);
  }

  insertMemory(mem: MemoryNode): void {
    insertMemory(this.tx, this.config, this.encryptor, mem);
  }

  decayAll(): { decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>; evicted: EvictionResult[] } {
    return this.runAtomic(() => decayAll(this.tx, this.kernelClock, this.config));
  }

  spreadActivation(sourceId: MemoryId): ActivationResult[] {
    return this.runAtomic(() => spreadActivation(this.tx, this.config, sourceId));
  }

  admitToWorkingMemory(memoryId: MemoryId): { admitted: boolean; evicted: MemoryId | null } {
    return this.runAtomic(() =>
      admitToWorkingMemory(this.tx, this.kernelClock, this.config, this.encryptor, memoryId),
    );
  }

  getWorkingMemorySlots(): WorkingMemorySlot[] {
    return getWorkingMemorySlots(this.tx);
  }

  refreshWorkingMemory(): WorkingMemorySlot[] {
    return this.runAtomic(() => refreshWorkingMemory(this.tx, this.kernelClock, this.config, this.encryptor));
  }

  removeFromWorkingMemory(memoryId: MemoryId): boolean {
    return removeFromWorkingMemory(this.tx, memoryId);
  }

  findConsolidationCandidates(): MemoryId[] {
    return findConsolidationCandidates(this.tx, this.config);
  }

  consolidateMemory(memoryId: MemoryId): ConsolidationResult | undefined {
    return this.runAtomic(() =>
      consolidateMemory(this.tx, this.kernelClock, this.kernelRandom, this.config, memoryId),
    ) ?? undefined;
  }

  consolidateAll(): ConsolidationResult[] {
    return this.runAtomic(() =>
      consolidateAll(this.tx, this.kernelClock, this.kernelRandom, this.config),
    );
  }

  getRelatedMemories(id: MemoryId, maxDepth = 2): MemoryNode[] {
    return getRelatedMemories(this.tx, this.encryptor, id, maxDepth);
  }

  getMemoryCount(): number {
    return getMemoryCount(this.tx);
  }

  evictExcess(): EvictionResult[] {
    return this.runAtomic(() => evictExcess(this.tx, this.config));
  }

  /**
   * 原子执行多步操作。
   * - IDatabase 形态：用 db.transaction() 包裹
   * - SyncWriteUnitOfWork 形态：直接执行；调用方应自行通过 factory.write 管理事务
   */
  private runAtomic<T>(fn: () => T): T {
    if (this.db) return this.db.transaction(fn);
    return fn();
  }
}
