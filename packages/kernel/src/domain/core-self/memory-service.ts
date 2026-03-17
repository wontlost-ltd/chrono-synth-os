/**
 * 认知记忆图领域服务 — 纯业务逻辑
 * 零 node:* 依赖，可在任何运行时使用
 */

import type { KernelClock, KernelRandom } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import type {
  MemoryNode, MemoryEdge, MemoryKind, MemoryCognitionConfig,
  WorkingMemorySlot, ActivationResult, ConsolidationResult, EvictionResult,
  ContentEncryptor,
} from './memory-types.js';
import {
  assertValence, assertSalience, assertStrength,
  computeLambda, computeWorkingMemoryScore, applyDecay,
} from './memory-cognition.js';
import {
  memById, memAll, memBatch, memPaginated, memCount,
  memConsolidationCandidates, memConsolidatedFrom, memLowestSalience,
  memInsertCmd, memUpsertCmd, memUpdateAccessCmd, memUpdateSalienceCmd, memUpdateSalienceDeltaCmd,
  memDeleteCmd, memDeleteAllCmd,
  memEdgeAll, memEdgesForNode, memEdgesForNodes,
  memEdgeUpsertCmd, memEdgeDeleteForNodeCmd, memEdgeDeleteAllCmd,
  memWmSlots, memWmById, memWmCount, memWmLowest, memWmAllRaw,
  memWmInsertCmd, memWmUpdateScoreCmd, memWmDeleteCmd, memWmDeleteAllCmd,
} from './memory-queries.js';
import type { MemPaginatedResult } from './memory-queries.js';

/* ── CRUD ── */

export function addMemory(
  tx: SyncWriteUnitOfWork, clock: KernelClock, random: KernelRandom,
  config: MemoryCognitionConfig, encryptor: ContentEncryptor,
  kind: MemoryKind, content: string, valence: number, salience: number,
): MemoryNode {
  assertValence(valence);
  assertSalience(salience);
  const id = random.uuid('mem');
  const now = clock.now();
  const decayLambda = computeLambda(config.decay, kind, valence, 0);
  tx.execute(memInsertCmd({
    id, kind, content: encryptor.encrypt(content), valence, salience,
    createdAt: now, lastAccessedAt: now, accessCount: 0,
    decayLambda, lastDecayedAt: now, consolidatedFrom: null,
  }));
  return { id, kind, content, valence, salience, createdAt: now, lastAccessedAt: now, accessCount: 0, decayLambda, lastDecayedAt: now, consolidatedFrom: null };
}

export function accessMemory(
  tx: SyncWriteUnitOfWork, clock: KernelClock,
  config: MemoryCognitionConfig, encryptor: ContentEncryptor,
  id: string,
): MemoryNode | undefined {
  const node = tx.queryOne(memById(id));
  if (!node) return undefined;

  const now = clock.now();
  const newSalience = applyDecay(node.salience, node.decayLambda, now - node.lastDecayedAt);
  const newAccessCount = node.accessCount + 1;
  const newLambda = computeLambda(config.decay, node.kind, node.valence, newAccessCount);

  tx.execute(memUpdateAccessCmd({
    id, salience: newSalience, lastAccessedAt: now,
    accessCount: newAccessCount, decayLambda: newLambda, lastDecayedAt: now,
  }));

  return {
    ...node,
    content: encryptor.decrypt(node.content),
    salience: newSalience, lastAccessedAt: now,
    accessCount: newAccessCount, decayLambda: newLambda, lastDecayedAt: now,
  };
}

export function getMemory(
  tx: SyncReadUnitOfWork, encryptor: ContentEncryptor, id: string,
): MemoryNode | undefined {
  const node = tx.queryOne(memById(id));
  if (!node) return undefined;
  return { ...node, content: encryptor.decrypt(node.content) };
}

export function getMemoryBatch(
  tx: SyncReadUnitOfWork, encryptor: ContentEncryptor, ids: string[],
): Map<string, MemoryNode> {
  if (ids.length === 0) return new Map();
  const nodes = tx.queryMany(memBatch(ids));
  const map = new Map<string, MemoryNode>();
  for (const n of nodes) map.set(n.id, { ...n, content: encryptor.decrypt(n.content) });
  return map;
}

export function getAllMemories(
  tx: SyncReadUnitOfWork, encryptor: ContentEncryptor,
): Map<string, MemoryNode> {
  const nodes = tx.queryMany(memAll());
  const map = new Map<string, MemoryNode>();
  for (const n of nodes) map.set(n.id, { ...n, content: encryptor.decrypt(n.content) });
  return map;
}

export function getMemoriesPaginated(
  tx: SyncReadUnitOfWork, encryptor: ContentEncryptor, limit: number, offset: number,
): { nodes: MemoryNode[]; total: number } {
  const result = tx.queryOne(memPaginated(limit, offset)) as MemPaginatedResult | null;
  if (!result) return { nodes: [], total: 0 };
  return { nodes: result.nodes.map(n => ({ ...n, content: encryptor.decrypt(n.content) })), total: result.total };
}

export function addEdge(
  tx: SyncWriteUnitOfWork,
  source: string, target: string, relation: string, strength: number,
): MemoryEdge {
  assertStrength(strength);
  tx.execute(memEdgeUpsertCmd({ source, target, strength, relation }));
  return { source, target, strength, relation };
}

export function getAllEdges(tx: SyncReadUnitOfWork): MemoryEdge[] {
  return [...tx.queryMany(memEdgeAll())];
}

export function getEdgesFor(tx: SyncReadUnitOfWork, id: string): MemoryEdge[] {
  return [...tx.queryMany(memEdgesForNode(id))];
}

/** 内部删除方法：边 → 工作记忆 → 节点 */
export function deleteMemoryInternal(tx: SyncWriteUnitOfWork, id: string): void {
  tx.execute(memEdgeDeleteForNodeCmd(id));
  tx.execute(memWmDeleteCmd(id));
  tx.execute(memDeleteCmd(id));
}

export function deleteMemory(tx: SyncWriteUnitOfWork, id: string): boolean {
  tx.execute(memEdgeDeleteForNodeCmd(id));
  tx.execute(memWmDeleteCmd(id));
  const result = tx.execute(memDeleteCmd(id));
  return result.rowsAffected > 0;
}

export function deleteAllMemories(tx: SyncWriteUnitOfWork): void {
  tx.execute(memWmDeleteAllCmd());
  tx.execute(memEdgeDeleteAllCmd());
  tx.execute(memDeleteAllCmd());
}

export function insertMemory(
  tx: SyncWriteUnitOfWork, config: MemoryCognitionConfig, encryptor: ContentEncryptor,
  mem: MemoryNode,
): void {
  const accessCount = Number.isFinite(mem.accessCount) ? mem.accessCount : 0;
  const lastAccessedAt = Number.isFinite(mem.lastAccessedAt) ? mem.lastAccessedAt : mem.createdAt;
  const lastDecayedAt = Number.isFinite(mem.lastDecayedAt) ? mem.lastDecayedAt : lastAccessedAt;
  const decayLambda = Number.isFinite(mem.decayLambda) && mem.decayLambda > 0
    ? mem.decayLambda
    : computeLambda(config.decay, mem.kind, mem.valence, accessCount);
  tx.execute(memUpsertCmd({
    id: mem.id, kind: mem.kind, content: encryptor.encrypt(mem.content),
    valence: mem.valence, salience: mem.salience, createdAt: mem.createdAt,
    lastAccessedAt, accessCount, decayLambda, lastDecayedAt,
    consolidatedFrom: mem.consolidatedFrom ?? null,
  }));
}

/* ── 衰减 ── */

export function decayAll(
  tx: SyncWriteUnitOfWork, clock: KernelClock, config: MemoryCognitionConfig,
): { decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>; evicted: EvictionResult[] } {
  const now = clock.now();
  const nodes = tx.queryMany(memAll());
  const decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }> = [];
  const evicted: EvictionResult[] = [];
  const EPSILON = 1e-6;
  const { salienceFloor } = config.eviction;

  for (const node of nodes) {
    const dt = now - node.lastDecayedAt;
    if (dt <= 0 || node.decayLambda <= 0) continue;

    const oldSalience = node.salience;
    const newSalience = applyDecay(oldSalience, node.decayLambda, dt);

    if (Math.abs(oldSalience - newSalience) < EPSILON) continue;

    if (salienceFloor > 0 && newSalience < salienceFloor) {
      deleteMemoryInternal(tx, node.id);
      evicted.push({ memoryId: node.id, reason: 'salience_floor', salience: newSalience });
      continue;
    }

    tx.execute(memUpdateSalienceCmd({ id: node.id, salience: newSalience, lastDecayedAt: now }));
    decayed.push({ memoryId: node.id, oldSalience, newSalience });
  }
  return { decayed, evicted };
}

/* ── 扩散激活 ── */

export function spreadActivation(
  tx: SyncWriteUnitOfWork, config: MemoryCognitionConfig, sourceId: string,
): ActivationResult[] {
  const { baseActivation, damping, maxDepth } = config.activation;
  const visited = new Set<string>([sourceId]);
  const results: ActivationResult[] = [];

  let frontier: Array<{ id: string; cumulativeStrength: number; path: string[] }> = [
    { id: sourceId, cumulativeStrength: 1.0, path: [sourceId] },
  ];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: typeof frontier = [];
    for (const current of frontier) {
      const edges = tx.queryMany(memEdgesForNode(current.id));

      for (const edge of edges) {
        const neighborId = edge.source === current.id ? edge.target : edge.source;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const pathStrength = current.cumulativeStrength * edge.strength;
        const delta = baseActivation * pathStrength * Math.exp(-damping * depth);
        if (delta < 1e-6) continue;

        const path = [...current.path, neighborId];
        tx.execute(memUpdateSalienceDeltaCmd({ id: neighborId, delta }));
        results.push({ memoryId: neighborId, delta, path });
        nextFrontier.push({ id: neighborId, cumulativeStrength: pathStrength, path });
      }
    }
    frontier = nextFrontier;
  }
  return results;
}

/* ── 工作记忆 ── */

export function admitToWorkingMemory(
  tx: SyncWriteUnitOfWork, clock: KernelClock, config: MemoryCognitionConfig,
  encryptor: ContentEncryptor, memoryId: string,
): { admitted: boolean; evicted: string | null } {
  const mem = getMemory(tx, encryptor, memoryId);
  if (!mem) return { admitted: false, evicted: null };

  const score = computeWorkingMemoryScore(config.workingMemory, mem, clock.now());
  const { capacity } = config.workingMemory;

  const existing = tx.queryOne(memWmById(memoryId));
  if (existing) {
    tx.execute(memWmUpdateScoreCmd(memoryId, score));
    return { admitted: true, evicted: null };
  }

  const count = tx.queryOne(memWmCount()) as number;

  if (count < capacity) {
    tx.execute(memWmInsertCmd({ memoryId, score, enteredAt: clock.now() }));
    return { admitted: true, evicted: null };
  }

  const lowest = tx.queryOne(memWmLowest());
  if (lowest && score > lowest.score) {
    tx.execute(memWmDeleteCmd(lowest.memoryId));
    tx.execute(memWmInsertCmd({ memoryId, score, enteredAt: clock.now() }));
    return { admitted: true, evicted: lowest.memoryId };
  }

  return { admitted: false, evicted: null };
}

export function getWorkingMemorySlots(tx: SyncReadUnitOfWork): WorkingMemorySlot[] {
  return [...tx.queryMany(memWmSlots())];
}

export function refreshWorkingMemory(
  tx: SyncWriteUnitOfWork, clock: KernelClock, config: MemoryCognitionConfig,
  encryptor: ContentEncryptor,
): WorkingMemorySlot[] {
  const slots = tx.queryMany(memWmAllRaw());
  const memIds = [...slots].map(s => s.memoryId);
  const memMap = getMemoryBatch(tx, encryptor, memIds);

  for (const slot of slots) {
    const mem = memMap.get(slot.memoryId);
    if (!mem) {
      tx.execute(memWmDeleteCmd(slot.memoryId));
      continue;
    }
    const newScore = computeWorkingMemoryScore(config.workingMemory, mem, clock.now());
    tx.execute(memWmUpdateScoreCmd(slot.memoryId, newScore));
  }
  return getWorkingMemorySlots(tx);
}

export function removeFromWorkingMemory(tx: SyncWriteUnitOfWork, memoryId: string): boolean {
  const result = tx.execute(memWmDeleteCmd(memoryId));
  return result.rowsAffected > 0;
}

/* ── 记忆固化 ── */

export function findConsolidationCandidates(tx: SyncReadUnitOfWork, config: MemoryCognitionConfig): string[] {
  return [...tx.queryMany(memConsolidationCandidates({
    accessThreshold: config.consolidation.accessThreshold,
    minSalience: config.consolidation.minSalience,
  }))];
}

export function consolidateMemory(
  tx: SyncWriteUnitOfWork, clock: KernelClock, random: KernelRandom,
  config: MemoryCognitionConfig, memoryId: string,
): ConsolidationResult | undefined {
  const node = tx.queryOne(memById(memoryId));
  if (!node || node.kind !== 'episodic') return undefined;

  const existingId = tx.queryOne(memConsolidatedFrom(memoryId));
  if (existingId) return undefined;

  const now = clock.now();
  const newId = random.uuid('mem');
  const newKind: MemoryKind = 'semantic';
  const newSalience = Math.min(1.0, node.salience * 1.2);
  const newLambda = computeLambda(config.decay, newKind, node.valence, 0);

  tx.execute(memInsertCmd({
    id: newId, kind: newKind, content: node.content, valence: node.valence,
    salience: newSalience, createdAt: now, lastAccessedAt: now,
    accessCount: 0, decayLambda: newLambda, lastDecayedAt: now,
    consolidatedFrom: memoryId,
  }));

  const edges = tx.queryMany(memEdgesForNode(memoryId));
  for (const edge of edges) {
    const newSource = edge.source === memoryId ? newId : edge.source;
    const newTarget = edge.target === memoryId ? newId : edge.target;
    tx.execute(memEdgeUpsertCmd({ source: newSource, target: newTarget, strength: edge.strength, relation: edge.relation }));
  }

  if (config.eviction.deleteConsolidatedSources) {
    deleteMemoryInternal(tx, memoryId);
  }

  return { originalId: memoryId, consolidatedId: newId, newKind: 'semantic' };
}

export function consolidateAll(
  tx: SyncWriteUnitOfWork, clock: KernelClock, random: KernelRandom,
  config: MemoryCognitionConfig,
): ConsolidationResult[] {
  const candidates = findConsolidationCandidates(tx, config);
  const results: ConsolidationResult[] = [];
  for (const id of candidates) {
    const result = consolidateMemory(tx, clock, random, config, id);
    if (result) results.push(result);
  }
  return results;
}

/* ── 相关记忆查询 ── */

export function getRelatedMemories(
  tx: SyncReadUnitOfWork, encryptor: ContentEncryptor,
  id: string, maxDepth = 2,
): MemoryNode[] {
  const visited = new Set<string>([id]);
  let frontier = [id];
  const related: MemoryNode[] = [];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.length === 0) break;

    const edges = tx.queryMany(memEdgesForNodes(frontier));
    const neighborIds: string[] = [];
    for (const edge of edges) {
      const nodeId = frontier.includes(edge.source) ? edge.target : edge.source;
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        neighborIds.push(nodeId);
      }
    }

    const memMap = getMemoryBatch(tx, encryptor, neighborIds);
    const nextFrontier: string[] = [];
    for (const nid of neighborIds) {
      const mem = memMap.get(nid);
      if (mem) {
        related.push(mem);
        nextFrontier.push(nid);
      }
    }
    frontier = nextFrontier;
  }
  return related;
}

/* ── 淘汰 ── */

export function getMemoryCount(tx: SyncReadUnitOfWork): number {
  return tx.queryOne(memCount()) as number ?? 0;
}

export function evictExcess(
  tx: SyncWriteUnitOfWork, config: MemoryCognitionConfig,
): EvictionResult[] {
  const { maxMemoryNodes, capacityTargetRatio, batchSize } = config.eviction;
  if (maxMemoryNodes < 0) return [];

  const count = getMemoryCount(tx);
  if (count <= maxMemoryNodes) return [];

  const target = Math.floor(maxMemoryNodes * capacityTargetRatio);
  let toEvict = count - target;
  const evicted: EvictionResult[] = [];

  while (toEvict > 0) {
    const limit = Math.min(toEvict, batchSize);
    const rows = tx.queryMany(memLowestSalience(limit));
    const rowsArr = [...rows];
    if (rowsArr.length === 0) break;

    for (const row of rowsArr) {
      deleteMemoryInternal(tx, row.id);
      evicted.push({ memoryId: row.id, reason: 'capacity_overflow', salience: row.salience });
    }
    toEvict -= rowsArr.length;
  }
  return evicted;
}
