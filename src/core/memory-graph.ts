/**
 * 认知记忆图 — 薄适配器，将公共 API 委托给 kernel 领域服务
 * SQL 实现位于 src/storage/executors/memory-executors.ts
 *
 * 多步原子操作通过 SyncWriteUnitOfWork.transaction(fn) 提供：
 *   - SQLite 实现（IDatabase.transaction）直接由 SqliteDatabase / PostgresDatabase 提供
 *   - 其他运行时由各自适配器决定（例如 Web Worker 可使用 messageport 协议事务）
 */

import type { FieldEncryption } from '../storage/encryption.js';
import type {
  MemoryNode, MemoryEdge, MemoryId, MemoryKind,
  MemoryCognitionConfig, WorkingMemorySlot, ActivationResult, ConsolidationResult, EvictionResult,
} from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
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
  private readonly config: MemoryCognitionConfig;
  private readonly encryptor: ContentEncryptor;
  private readonly kernelClock: KernelClock;
  private readonly kernelRandom: KernelRandom;
  private readonly personaId: string;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    clock: Clock,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
    personaId = 'default',
  ) {
    registerCoreSelfExecutors();
    this.config = config ? mergeMemoryConfig(DEFAULT_COGNITION_CONFIG, config) : DEFAULT_COGNITION_CONFIG;
    this.encryptor = toContentEncryptor(encryption);
    this.kernelClock = { now: () => clock.now() };
    this.kernelRandom = { uuid: (prefix?: string) => generatePrefixedId(prefix ?? 'mem') };
    this.personaId = personaId;
  }

  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    return addMemory(this.tx, this.kernelClock, this.kernelRandom, this.config, this.encryptor, kind, content, valence, salience, this.personaId);
  }

  accessMemory(id: MemoryId): MemoryNode | undefined {
    return accessMemory(this.tx, this.kernelClock, this.config, this.encryptor, id, this.personaId) ?? undefined;
  }

  getMemory(id: MemoryId): MemoryNode | undefined {
    return getMemory(this.tx, this.encryptor, id, this.personaId) ?? undefined;
  }

  getMemoryBatch(ids: MemoryId[]): Map<MemoryId, MemoryNode> {
    return getMemoryBatch(this.tx, this.encryptor, ids, this.personaId);
  }

  getAllMemories(): Map<MemoryId, MemoryNode> {
    return getAllMemories(this.tx, this.encryptor, this.personaId);
  }

  getMemoriesPaginated(limit: number, offset: number): { nodes: MemoryNode[]; total: number } {
    return getMemoriesPaginated(this.tx, this.encryptor, limit, offset, this.personaId);
  }

  addEdge(source: MemoryId, target: MemoryId, relation: string, strength: number): MemoryEdge {
    return addEdge(this.tx, source, target, relation, strength, this.personaId);
  }

  getAllEdges(): MemoryEdge[] {
    return getAllEdges(this.tx, this.personaId);
  }

  getEdgesFor(id: MemoryId): MemoryEdge[] {
    return getEdgesFor(this.tx, id, this.personaId);
  }

  deleteMemory(id: MemoryId): boolean {
    return deleteMemory(this.tx, id, this.personaId);
  }

  deleteAll(): void {
    deleteAllMemories(this.tx, this.personaId);
  }

  insertMemory(mem: MemoryNode): void {
    insertMemory(this.tx, this.config, this.encryptor, mem, this.personaId);
  }

  decayAll(): { decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>; evicted: EvictionResult[] } {
    return this.tx.transaction(() => decayAll(this.tx, this.kernelClock, this.config, this.personaId));
  }

  spreadActivation(sourceId: MemoryId): ActivationResult[] {
    return this.tx.transaction(() => spreadActivation(this.tx, this.config, sourceId, this.personaId));
  }

  admitToWorkingMemory(memoryId: MemoryId): { admitted: boolean; evicted: MemoryId | null } {
    return this.tx.transaction(() =>
      admitToWorkingMemory(this.tx, this.kernelClock, this.config, this.encryptor, memoryId, this.personaId),
    );
  }

  getWorkingMemorySlots(): WorkingMemorySlot[] {
    return getWorkingMemorySlots(this.tx, this.personaId);
  }

  refreshWorkingMemory(): WorkingMemorySlot[] {
    return this.tx.transaction(() => refreshWorkingMemory(this.tx, this.kernelClock, this.config, this.encryptor, this.personaId));
  }

  removeFromWorkingMemory(memoryId: MemoryId): boolean {
    return removeFromWorkingMemory(this.tx, memoryId, this.personaId);
  }

  findConsolidationCandidates(): MemoryId[] {
    return findConsolidationCandidates(this.tx, this.config, this.personaId);
  }

  consolidateMemory(memoryId: MemoryId): ConsolidationResult | undefined {
    return this.tx.transaction(() =>
      consolidateMemory(this.tx, this.kernelClock, this.kernelRandom, this.config, memoryId, this.personaId),
    ) ?? undefined;
  }

  consolidateAll(): ConsolidationResult[] {
    return this.tx.transaction(() =>
      consolidateAll(this.tx, this.kernelClock, this.kernelRandom, this.config, this.personaId),
    );
  }

  getRelatedMemories(id: MemoryId, maxDepth = 2): MemoryNode[] {
    return getRelatedMemories(this.tx, this.encryptor, id, maxDepth, this.personaId);
  }

  getMemoryCount(): number {
    return getMemoryCount(this.tx, this.personaId);
  }

  evictExcess(): EvictionResult[] {
    return this.tx.transaction(() => evictExcess(this.tx, this.config, this.personaId));
  }
}
