/**
 * 认知记忆图：管理记忆节点、关联边和认知动力学
 * 内聚遗忘曲线、扩散激活、工作记忆和记忆固化能力
 */

import type { IDatabase } from '../storage/database.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type {
  MemoryNode, MemoryEdge, MemoryId, MemoryKind,
  MemoryCognitionConfig, WorkingMemorySlot, ActivationResult, ConsolidationResult, EvictionResult,
} from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  valence: number;
  salience: number;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  decay_lambda: number;
  last_decayed_at: number;
  consolidated_from: string | null;
}

interface EdgeRow {
  source: string;
  target: string;
  strength: number;
  relation: string;
}

interface WorkingMemoryRow {
  memory_id: string;
  score: number;
  entered_at: number;
}

/** 默认认知配置 */
export const DEFAULT_COGNITION_CONFIG: MemoryCognitionConfig = {
  decay: {
    baseLambda: 0.0001,
    valenceWeight: 0.3,
    accessBoost: 0.5,
    kindFactors: { episodic: 1.0, semantic: 0.5, procedural: 0.3 },
  },
  activation: {
    baseActivation: 0.1,
    damping: 0.5,
    maxDepth: 2,
  },
  workingMemory: {
    capacity: 7,
    recencyDecay: 0.0001,
  },
  consolidation: {
    accessThreshold: 5,
    minSalience: 0.3,
  },
  eviction: {
    salienceFloor: 0.01,
    maxMemoryNodes: 10_000,
    capacityTargetRatio: 0.9,
    deleteConsolidatedSources: true,
    batchSize: 1000,
  },
};

export class CognitiveMemoryGraph {
  private readonly config: MemoryCognitionConfig;
  private readonly encryption?: FieldEncryption;

  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
  ) {
    this.config = config ? mergeConfig(DEFAULT_COGNITION_CONFIG, config) : DEFAULT_COGNITION_CONFIG;
    this.encryption = encryption?.isEnabled ? encryption : undefined;
  }

  /** 加密内容（如果启用） */
  private encryptContent(content: string): string {
    return this.encryption ? this.encryption.encrypt(content) : content;
  }

  /** 解密内容（如果启用） */
  private decryptContent(content: string): string {
    return this.encryption ? this.encryption.decrypt(content) : content;
  }

  // ===== CRUD 方法 =====

  /** 添加记忆节点 */
  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    if (!Number.isFinite(valence) || valence < -1 || valence > 1) throw new RangeError(`情感色调必须在 -1 到 1 之间，收到 ${valence}`);
    if (!Number.isFinite(salience) || salience < 0 || salience > 1) throw new RangeError(`重要性必须在 0-1 之间，收到 ${salience}`);
    const id = generatePrefixedId('mem');
    const now = this.clock.now();
    const decayLambda = this.computeLambda(kind, valence, 0);
    const storedContent = this.encryptContent(content);
    this.db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, kind, storedContent, valence, salience, now, now, 0, decayLambda, now, null);
    return { id, kind, content, valence, salience, createdAt: now, lastAccessedAt: now, accessCount: 0, decayLambda, lastDecayedAt: now, consolidatedFrom: null };
  }

  /** 访问记忆：自动执行 lazy decay + 更新访问计数 */
  accessMemory(id: MemoryId): MemoryNode | undefined {
    const row = this.db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE id = ?').get(id);
    if (!row) return undefined;

    const now = this.clock.now();
    const dt = now - row.last_decayed_at;
    let newSalience = row.salience;

    /* lazy decay：应用自上次衰减以来的遗忘 */
    if (dt > 0 && row.decay_lambda > 0) {
      newSalience = row.salience * Math.exp(-row.decay_lambda * dt);
      if (newSalience < 0) newSalience = 0;
    }

    /* 更新访问计数和衰减速率 */
    const newAccessCount = row.access_count + 1;
    const kind = row.kind as MemoryKind;
    const newLambda = this.computeLambda(kind, row.valence, newAccessCount);

    this.db.prepare<void>(
      `UPDATE memory_nodes SET salience = ?, last_accessed_at = ?, access_count = ?, decay_lambda = ?, last_decayed_at = ? WHERE id = ?`,
    ).run(newSalience, now, newAccessCount, newLambda, now, id);

    return this.toNode({ ...row, salience: newSalience, last_accessed_at: now, access_count: newAccessCount, decay_lambda: newLambda, last_decayed_at: now });
  }

  /** 获取单个记忆（不触发衰减） */
  getMemory(id: MemoryId): MemoryNode | undefined {
    const row = this.db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE id = ?').get(id);
    return row ? this.toNode(row) : undefined;
  }

  /** 批量获取记忆（减少 N+1 查询） */
  getMemoryBatch(ids: MemoryId[]): Map<MemoryId, MemoryNode> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare<MemoryRow>(
      `SELECT * FROM memory_nodes WHERE id IN (${placeholders})`,
    ).all(...ids);
    const map = new Map<MemoryId, MemoryNode>();
    for (const row of rows) {
      map.set(row.id, this.toNode(row));
    }
    return map;
  }

  /** 获取全部记忆 */
  getAllMemories(): Map<MemoryId, MemoryNode> {
    const rows = this.db.prepare<MemoryRow>('SELECT * FROM memory_nodes').all();
    const map = new Map<MemoryId, MemoryNode>();
    for (const row of rows) {
      map.set(row.id, this.toNode(row));
    }
    return map;
  }

  /** 分页获取记忆 */
  getMemoriesPaginated(limit: number, offset: number): { nodes: MemoryNode[]; total: number } {
    const total = this.db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes').get()?.count ?? 0;
    const rows = this.db.prepare<MemoryRow>(
      'SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset);
    return { nodes: rows.map(r => this.toNode(r)), total };
  }

  /** 添加记忆关联边 */
  addEdge(source: MemoryId, target: MemoryId, relation: string, strength: number): MemoryEdge {
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError(`关联强度必须在 0-1 之间，收到 ${strength}`);
    this.db.prepare<void>(
      `INSERT INTO memory_edges (source, target, strength, relation) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET strength=excluded.strength, relation=excluded.relation`,
    ).run(source, target, strength, relation);
    return { source, target, strength, relation };
  }

  /** 获取全部边 */
  getAllEdges(): MemoryEdge[] {
    return this.db.prepare<EdgeRow>('SELECT * FROM memory_edges').all().map(this.toEdge);
  }

  /** 获取某节点的相邻边 */
  getEdgesFor(id: MemoryId): MemoryEdge[] {
    return this.db.prepare<EdgeRow>('SELECT * FROM memory_edges WHERE source = ? OR target = ?').all(id, id).map(this.toEdge);
  }

  /** 删除记忆及其关联边 */
  deleteMemory(id: MemoryId): boolean {
    this.db.prepare<void>('DELETE FROM memory_edges WHERE source = ? OR target = ?').run(id, id);
    this.db.prepare<void>('DELETE FROM working_memory WHERE memory_id = ?').run(id);
    const result = this.db.prepare<void>('DELETE FROM memory_nodes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** 删除所有记忆和边 */
  deleteAll(): void {
    this.db.prepare<void>('DELETE FROM working_memory WHERE 1=1').run();
    this.db.prepare<void>('DELETE FROM memory_edges WHERE 1=1').run();
    this.db.prepare<void>('DELETE FROM memory_nodes WHERE 1=1').run();
  }

  /** 按原始数据插入记忆节点（恢复用，保留原 ID 和时间戳） */
  insertMemory(mem: MemoryNode): void {
    /* 旧快照可能缺少认知字段，需容错处理 */
    const accessCount = Number.isFinite(mem.accessCount) ? mem.accessCount : 0;
    const lastAccessedAt = Number.isFinite(mem.lastAccessedAt) ? mem.lastAccessedAt : mem.createdAt;
    const lastDecayedAt = Number.isFinite(mem.lastDecayedAt) ? mem.lastDecayedAt : lastAccessedAt;
    const decayLambda = Number.isFinite(mem.decayLambda) && mem.decayLambda > 0
      ? mem.decayLambda
      : this.computeLambda(mem.kind, mem.valence, accessCount);
    const consolidatedFrom = mem.consolidatedFrom ?? null;
    const storedContent = this.encryptContent(mem.content);
    this.db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, content=excluded.content, valence=excluded.valence, salience=excluded.salience, created_at=excluded.created_at, last_accessed_at=excluded.last_accessed_at, access_count=excluded.access_count, decay_lambda=excluded.decay_lambda, last_decayed_at=excluded.last_decayed_at, consolidated_from=excluded.consolidated_from`,
    ).run(mem.id, mem.kind, storedContent, mem.valence, mem.salience, mem.createdAt, lastAccessedAt, accessCount, decayLambda, lastDecayedAt, consolidatedFrom);
  }

  // ===== 遗忘衰减 =====

  /** 批量衰减所有记忆（含 L1 显著性下限淘汰） */
  decayAll(): { decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>; evicted: EvictionResult[] } {
    const now = this.clock.now();
    const rows = this.db.prepare<MemoryRow>('SELECT * FROM memory_nodes').all();
    const decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }> = [];
    const evicted: EvictionResult[] = [];
    const EPSILON = 1e-6;
    const { salienceFloor } = this.config.eviction;

    return this.db.transaction(() => {
      for (const row of rows) {
        const dt = now - row.last_decayed_at;
        if (dt <= 0 || row.decay_lambda <= 0) continue;

        const oldSalience = row.salience;
        let newSalience = oldSalience * Math.exp(-row.decay_lambda * dt);
        if (newSalience < 0) newSalience = 0;

        if (Math.abs(oldSalience - newSalience) < EPSILON) continue;

        /* L1：低于显著性下限时物理删除 */
        if (salienceFloor > 0 && newSalience < salienceFloor) {
          this.deleteMemoryInternal(row.id);
          evicted.push({ memoryId: row.id, reason: 'salience_floor', salience: newSalience });
          continue;
        }

        this.db.prepare<void>(
          'UPDATE memory_nodes SET salience = ?, last_decayed_at = ? WHERE id = ?',
        ).run(newSalience, now, row.id);

        decayed.push({ memoryId: row.id, oldSalience, newSalience });
      }
      return { decayed, evicted };
    });
  }

  // ===== 扩散激活 =====

  /** 从 sourceId 沿边传播激活能量 */
  spreadActivation(sourceId: MemoryId): ActivationResult[] {
    const { baseActivation, damping, maxDepth } = this.config.activation;
    const visited = new Set<string>([sourceId]);
    const results: ActivationResult[] = [];

    /* BFS 层级遍历 */
    let frontier: Array<{ id: string; cumulativeStrength: number; path: string[] }> = [
      { id: sourceId, cumulativeStrength: 1.0, path: [sourceId] },
    ];

    return this.db.transaction(() => {
      for (let depth = 1; depth <= maxDepth; depth++) {
        const nextFrontier: typeof frontier = [];
        for (const current of frontier) {
          const edges = this.db.prepare<EdgeRow>(
            'SELECT * FROM memory_edges WHERE source = ? OR target = ?',
          ).all(current.id, current.id);

          for (const edge of edges) {
            const neighborId = edge.source === current.id ? edge.target : edge.source;
            if (visited.has(neighborId)) continue;
            visited.add(neighborId);

            const pathStrength = current.cumulativeStrength * edge.strength;
            const delta = baseActivation * pathStrength * Math.exp(-damping * depth);
            if (delta < 1e-6) continue;

            const path = [...current.path, neighborId];

            /* 更新 salience（上限 1.0） */
            this.db.prepare<void>(
              'UPDATE memory_nodes SET salience = MIN(1.0, salience + ?) WHERE id = ?',
            ).run(delta, neighborId);

            results.push({ memoryId: neighborId, delta, path });
            nextFrontier.push({ id: neighborId, cumulativeStrength: pathStrength, path });
          }
        }
        frontier = nextFrontier;
      }
      return results;
    });
  }

  // ===== 工作记忆 =====

  /** 尝试将记忆纳入工作记忆 */
  admitToWorkingMemory(memoryId: MemoryId): { admitted: boolean; evicted: MemoryId | null } {
    const mem = this.getMemory(memoryId);
    if (!mem) return { admitted: false, evicted: null };

    const score = this.computeWorkingMemoryScore(mem);
    const { capacity } = this.config.workingMemory;

    return this.db.transaction(() => {
      /* 检查是否已在工作记忆中 */
      const existing = this.db.prepare<WorkingMemoryRow>(
        'SELECT * FROM working_memory WHERE memory_id = ?',
      ).get(memoryId);
      if (existing) {
        this.db.prepare<void>('UPDATE working_memory SET score = ? WHERE memory_id = ?').run(score, memoryId);
        return { admitted: true, evicted: null };
      }

      const count = this.db.prepare<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM working_memory').get()!.cnt;

      if (count < capacity) {
        this.db.prepare<void>(
          'INSERT INTO working_memory (memory_id, score, entered_at) VALUES (?, ?, ?)',
        ).run(memoryId, score, this.clock.now());
        return { admitted: true, evicted: null };
      }

      /* 容量已满，比较最低分 */
      const lowest = this.db.prepare<WorkingMemoryRow>(
        'SELECT * FROM working_memory ORDER BY score ASC LIMIT 1',
      ).get()!;

      if (score > lowest.score) {
        this.db.prepare<void>('DELETE FROM working_memory WHERE memory_id = ?').run(lowest.memory_id);
        this.db.prepare<void>(
          'INSERT INTO working_memory (memory_id, score, entered_at) VALUES (?, ?, ?)',
        ).run(memoryId, score, this.clock.now());
        return { admitted: true, evicted: lowest.memory_id };
      }

      return { admitted: false, evicted: null };
    });
  }

  /** 获取当前工作记忆 */
  getWorkingMemorySlots(): WorkingMemorySlot[] {
    return this.db.prepare<WorkingMemoryRow>(
      'SELECT * FROM working_memory ORDER BY score DESC',
    ).all().map(r => ({ memoryId: r.memory_id, score: r.score, enteredAt: r.entered_at }));
  }

  /** 刷新工作记忆评分 */
  refreshWorkingMemory(): WorkingMemorySlot[] {
    return this.db.transaction(() => {
      const slots = this.db.prepare<WorkingMemoryRow>('SELECT * FROM working_memory').all();
      const memIds = slots.map(s => s.memory_id);
      const memMap = this.getMemoryBatch(memIds);

      for (const slot of slots) {
        const mem = memMap.get(slot.memory_id);
        if (!mem) {
          this.db.prepare<void>('DELETE FROM working_memory WHERE memory_id = ?').run(slot.memory_id);
          continue;
        }
        const newScore = this.computeWorkingMemoryScore(mem);
        this.db.prepare<void>('UPDATE working_memory SET score = ? WHERE memory_id = ?').run(newScore, slot.memory_id);
      }
      return this.getWorkingMemorySlots();
    });
  }

  /** 从工作记忆移除 */
  removeFromWorkingMemory(memoryId: MemoryId): boolean {
    return this.db.prepare<void>('DELETE FROM working_memory WHERE memory_id = ?').run(memoryId).changes > 0;
  }

  // ===== 记忆固化 =====

  /** 查找可固化的 episodic 记忆（排除已被固化过的） */
  findConsolidationCandidates(): MemoryId[] {
    const { accessThreshold, minSalience } = this.config.consolidation;
    const rows = this.db.prepare<{ id: string }>(
      `SELECT id FROM memory_nodes
       WHERE kind = 'episodic'
         AND access_count >= ?
         AND salience >= ?
         AND consolidated_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_nodes AS m2 WHERE m2.consolidated_from = memory_nodes.id)`,
    ).all(accessThreshold, minSalience);
    return rows.map(r => r.id);
  }

  /** 将 episodic 记忆固化为 semantic（幂等：已被固化过的记忆不会重复固化） */
  consolidateMemory(memoryId: MemoryId): ConsolidationResult | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE id = ?').get(memoryId);
      if (!row || row.kind !== 'episodic') return undefined;

      /* 幂等性检查：如果已存在从该记忆固化的 semantic 节点，跳过 */
      const existing = this.db.prepare<{ id: string }>(
        'SELECT id FROM memory_nodes WHERE consolidated_from = ? LIMIT 1',
      ).get(memoryId);
      if (existing) return undefined;

      const now = this.clock.now();
      const newId = generatePrefixedId('mem');
      const newKind: MemoryKind = 'semantic';
      const newSalience = Math.min(1.0, row.salience * 1.2);
      const newLambda = this.computeLambda(newKind, row.valence, 0);

      /* 创建 semantic 记忆 */
      this.db.prepare<void>(
        `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, newKind, row.content, row.valence, newSalience, now, now, 0, newLambda, now, memoryId);

      /* 复制原记忆的关联边到新记忆 */
      const edges = this.db.prepare<EdgeRow>(
        'SELECT * FROM memory_edges WHERE source = ? OR target = ?',
      ).all(memoryId, memoryId);

      for (const edge of edges) {
        const newSource = edge.source === memoryId ? newId : edge.source;
        const newTarget = edge.target === memoryId ? newId : edge.target;
        this.db.prepare<void>(
          `INSERT INTO memory_edges (source, target, strength, relation) VALUES (?, ?, ?, ?)
           ON CONFLICT(source, target) DO UPDATE SET strength=excluded.strength, relation=excluded.relation`,
        ).run(newSource, newTarget, edge.strength, edge.relation);
      }

      /* L3：固化完成后删除原始 episodic（consolidated_from 列有 ON DELETE SET NULL） */
      if (this.config.eviction.deleteConsolidatedSources) {
        this.deleteMemoryInternal(memoryId);
      }

      return { originalId: memoryId, consolidatedId: newId, newKind: 'semantic' as const };
    });
  }

  /** 批量固化 */
  consolidateAll(): ConsolidationResult[] {
    const candidates = this.findConsolidationCandidates();
    const results: ConsolidationResult[] = [];
    for (const id of candidates) {
      const result = this.consolidateMemory(id);
      if (result) results.push(result);
    }
    return results;
  }

  /** 查询相关记忆（只读 BFS，不修改 salience） */
  getRelatedMemories(id: MemoryId, maxDepth = 2): MemoryNode[] {
    const visited = new Set<string>([id]);
    let frontier = [id];
    const related: MemoryNode[] = [];

    for (let depth = 0; depth < maxDepth; depth++) {
      if (frontier.length === 0) break;

      /* 批量查询当前层所有节点的边 */
      const placeholders = frontier.map(() => '?').join(',');
      const edges = this.db.prepare<EdgeRow>(
        `SELECT * FROM memory_edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
      ).all(...frontier, ...frontier);

      /* 收集未访问的邻居 ID */
      const neighborIds: string[] = [];
      for (const edge of edges) {
        const nodeId = frontier.includes(edge.source) ? edge.target : edge.source;
        if (!visited.has(nodeId)) {
          visited.add(nodeId);
          neighborIds.push(nodeId);
        }
      }

      /* 批量加载邻居节点 */
      const memMap = this.getMemoryBatch(neighborIds);
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

  // ===== 淘汰方法 =====

  /** 获取记忆节点总数 */
  getMemoryCount(): number {
    return this.db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes').get()?.count ?? 0;
  }

  /** 容量淘汰：超过 maxMemoryNodes 时按评分淘汰至 targetRatio */
  evictExcess(): EvictionResult[] {
    const { maxMemoryNodes, capacityTargetRatio, batchSize } = this.config.eviction;
    if (maxMemoryNodes < 0) return [];

    const count = this.getMemoryCount();
    if (count <= maxMemoryNodes) return [];

    const target = Math.floor(maxMemoryNodes * capacityTargetRatio);
    let toEvict = count - target;
    const evicted: EvictionResult[] = [];

    return this.db.transaction(() => {
      while (toEvict > 0) {
        const limit = Math.min(toEvict, batchSize);
        const rows = this.db.prepare<{ id: string; salience: number }>(
          'SELECT id, salience FROM memory_nodes ORDER BY salience ASC, last_accessed_at ASC LIMIT ?',
        ).all(limit);
        if (rows.length === 0) break;

        for (const row of rows) {
          this.deleteMemoryInternal(row.id);
          evicted.push({ memoryId: row.id, reason: 'capacity_overflow', salience: row.salience });
        }
        toEvict -= rows.length;
      }
      return evicted;
    });
  }

  // ===== 内部方法 =====

  /** 内部删除方法：删除边 → 工作记忆 → 节点（memory_embeddings 有 CASCADE） */
  private deleteMemoryInternal(id: MemoryId): void {
    this.db.prepare<void>('DELETE FROM memory_edges WHERE source = ? OR target = ?').run(id, id);
    this.db.prepare<void>('DELETE FROM working_memory WHERE memory_id = ?').run(id);
    this.db.prepare<void>('DELETE FROM memory_nodes WHERE id = ?').run(id);
  }

  /** 计算衰减速率 λ（保证非负有限值） */
  private computeLambda(kind: MemoryKind, valence: number, accessCount: number): number {
    const { baseLambda, valenceWeight, accessBoost, kindFactors } = this.config.decay;
    const kindFactor = kindFactors[kind] ?? 1.0;
    const raw = baseLambda * (1 - valenceWeight * Math.abs(valence)) * kindFactor / (1 + accessBoost * accessCount);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** 计算工作记忆评分 */
  private computeWorkingMemoryScore(mem: MemoryNode): number {
    const now = this.clock.now();
    const { recencyDecay } = this.config.workingMemory;
    const recencyFactor = Math.exp(-recencyDecay * (now - mem.lastAccessedAt));
    const accessFactor = 1 + Math.log(1 + mem.accessCount);
    return mem.salience * recencyFactor * accessFactor;
  }

  private toNode(row: MemoryRow): MemoryNode {
    return {
      id: row.id,
      kind: row.kind as MemoryKind,
      content: this.decryptContent(row.content),
      valence: row.valence,
      salience: row.salience,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      decayLambda: row.decay_lambda,
      lastDecayedAt: row.last_decayed_at,
      consolidatedFrom: row.consolidated_from,
    };
  }

  private toEdge(row: EdgeRow): MemoryEdge {
    return {
      source: row.source,
      target: row.target,
      strength: row.strength,
      relation: row.relation,
    };
  }
}

/** 深度合并认知配置 */
function mergeConfig(base: MemoryCognitionConfig, override: Partial<MemoryCognitionConfig>): MemoryCognitionConfig {
  return {
    decay: { ...base.decay, ...override.decay, kindFactors: { ...base.decay.kindFactors, ...override.decay?.kindFactors } },
    activation: { ...base.activation, ...override.activation },
    workingMemory: { ...base.workingMemory, ...override.workingMemory },
    consolidation: { ...base.consolidation, ...override.consolidation },
    eviction: { ...base.eviction, ...override.eviction },
  };
}
