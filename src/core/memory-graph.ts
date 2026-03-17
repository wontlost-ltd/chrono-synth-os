/**
 * 认知记忆图 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/memory-executors.ts
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
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import type { KernelClock, KernelRandom, ContentEncryptor } from '@chrono/kernel';
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
  private readonly config: MemoryCognitionConfig;
  private readonly encryptor: ContentEncryptor;
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;

  constructor(
    private readonly db: IDatabase,
    clock: Clock,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
  ) {
    registerCoreSelfExecutors();
    this.config = config ? mergeMemoryConfig(DEFAULT_COGNITION_CONFIG, config) : DEFAULT_COGNITION_CONFIG;
    this.encryptor = toContentEncryptor(encryption);
    this.kernelClock = { now: () => clock.now() };
    this.kernelRandom = { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'mem') };
  }

  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    const tx = directUnitOfWork(this.db);
    return addMemory(tx, this.kernelClock, this.kernelRandom, this.config, this.encryptor, kind, content, valence, salience);
  }

  accessMemory(id: MemoryId): MemoryNode | undefined {
    const tx = directUnitOfWork(this.db);
    return accessMemory(tx, this.kernelClock, this.config, this.encryptor, id) ?? undefined;
  }

  getMemory(id: MemoryId): MemoryNode | undefined {
    const tx = directUnitOfWork(this.db);
    return getMemory(tx, this.encryptor, id) ?? undefined;
  }

  getMemoryBatch(ids: MemoryId[]): Map<MemoryId, MemoryNode> {
    const tx = directUnitOfWork(this.db);
    return getMemoryBatch(tx, this.encryptor, ids);
  }

  getAllMemories(): Map<MemoryId, MemoryNode> {
    const tx = directUnitOfWork(this.db);
    return getAllMemories(tx, this.encryptor);
  }

  getMemoriesPaginated(limit: number, offset: number): { nodes: MemoryNode[]; total: number } {
    const tx = directUnitOfWork(this.db);
    return getMemoriesPaginated(tx, this.encryptor, limit, offset);
  }

  addEdge(source: MemoryId, target: MemoryId, relation: string, strength: number): MemoryEdge {
    const tx = directUnitOfWork(this.db);
    return addEdge(tx, source, target, relation, strength);
  }

  getAllEdges(): MemoryEdge[] {
    const tx = directUnitOfWork(this.db);
    return getAllEdges(tx);
  }

  getEdgesFor(id: MemoryId): MemoryEdge[] {
    const tx = directUnitOfWork(this.db);
    return getEdgesFor(tx, id);
  }

  deleteMemory(id: MemoryId): boolean {
    const tx = directUnitOfWork(this.db);
    return deleteMemory(tx, id);
  }

  deleteAll(): void {
    const tx = directUnitOfWork(this.db);
    deleteAllMemories(tx);
  }

  insertMemory(mem: MemoryNode): void {
    const tx = directUnitOfWork(this.db);
    insertMemory(tx, this.config, this.encryptor, mem);
  }

  decayAll(): { decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>; evicted: EvictionResult[] } {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return decayAll(tx, this.kernelClock, this.config);
    });
  }

  spreadActivation(sourceId: MemoryId): ActivationResult[] {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return spreadActivation(tx, this.config, sourceId);
    });
  }

  admitToWorkingMemory(memoryId: MemoryId): { admitted: boolean; evicted: MemoryId | null } {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return admitToWorkingMemory(tx, this.kernelClock, this.config, this.encryptor, memoryId);
    });
  }

  getWorkingMemorySlots(): WorkingMemorySlot[] {
    const tx = directUnitOfWork(this.db);
    return getWorkingMemorySlots(tx);
  }

  refreshWorkingMemory(): WorkingMemorySlot[] {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return refreshWorkingMemory(tx, this.kernelClock, this.config, this.encryptor);
    });
  }

  removeFromWorkingMemory(memoryId: MemoryId): boolean {
    const tx = directUnitOfWork(this.db);
    return removeFromWorkingMemory(tx, memoryId);
  }

  findConsolidationCandidates(): MemoryId[] {
    const tx = directUnitOfWork(this.db);
    return findConsolidationCandidates(tx, this.config);
  }

  consolidateMemory(memoryId: MemoryId): ConsolidationResult | undefined {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return consolidateMemory(tx, this.kernelClock, this.kernelRandom, this.config, memoryId);
    }) ?? undefined;
  }

  consolidateAll(): ConsolidationResult[] {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return consolidateAll(tx, this.kernelClock, this.kernelRandom, this.config);
    });
  }

  getRelatedMemories(id: MemoryId, maxDepth = 2): MemoryNode[] {
    const tx = directUnitOfWork(this.db);
    return getRelatedMemories(tx, this.encryptor, id, maxDepth);
  }

  getMemoryCount(): number {
    const tx = directUnitOfWork(this.db);
    return getMemoryCount(tx);
  }

  evictExcess(): EvictionResult[] {
    return this.db.transaction(() => {
      const tx = directUnitOfWork(this.db);
      return evictExcess(tx, this.config);
    });
  }
}
