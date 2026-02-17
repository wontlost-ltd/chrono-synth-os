/**
 * 记忆图：管理记忆节点和关联边的持久化存储
 */

import type { IDatabase } from '../storage/database.js';
import type { MemoryNode, MemoryEdge, MemoryId, MemoryKind } from '../types/core-self.js';
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
}

interface EdgeRow {
  source: string;
  target: string;
  strength: number;
  relation: string;
}

export class MemoryGraph {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 添加记忆节点 */
  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    if (!Number.isFinite(valence) || valence < -1 || valence > 1) throw new RangeError(`情感色调必须在 -1 到 1 之间，收到 ${valence}`);
    if (!Number.isFinite(salience) || salience < 0 || salience > 1) throw new RangeError(`重要性必须在 0-1 之间，收到 ${salience}`);
    const id = generatePrefixedId('mem');
    const now = this.clock.now();
    this.db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, kind, content, valence, salience, now, now);
    return { id, kind, content, valence, salience, createdAt: now, lastAccessedAt: now };
  }

  /** 访问记忆，更新最后访问时间 */
  accessMemory(id: MemoryId): MemoryNode | undefined {
    const now = this.clock.now();
    const result = this.db.prepare<void>(
      'UPDATE memory_nodes SET last_accessed_at = ? WHERE id = ?',
    ).run(now, id);
    if (result.changes === 0) return undefined;
    return this.getMemory(id);
  }

  /** 获取单个记忆 */
  getMemory(id: MemoryId): MemoryNode | undefined {
    const row = this.db.prepare<MemoryRow>(
      'SELECT * FROM memory_nodes WHERE id = ?',
    ).get(id);
    return row ? this.toNode(row) : undefined;
  }

  /** 获取全部记忆 */
  getAllMemories(): Map<MemoryId, MemoryNode> {
    const rows = this.db.prepare<MemoryRow>(
      'SELECT * FROM memory_nodes',
    ).all();
    const map = new Map<MemoryId, MemoryNode>();
    for (const row of rows) {
      map.set(row.id, this.toNode(row));
    }
    return map;
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
    const rows = this.db.prepare<EdgeRow>(
      'SELECT * FROM memory_edges',
    ).all();
    return rows.map(this.toEdge);
  }

  /** 获取某节点的相邻边 */
  getEdgesFor(id: MemoryId): MemoryEdge[] {
    const rows = this.db.prepare<EdgeRow>(
      'SELECT * FROM memory_edges WHERE source = ? OR target = ?',
    ).all(id, id);
    return rows.map(this.toEdge);
  }

  /** 删除记忆及其关联边 */
  deleteMemory(id: MemoryId): boolean {
    this.db.prepare<void>('DELETE FROM memory_edges WHERE source = ? OR target = ?').run(id, id);
    const result = this.db.prepare<void>('DELETE FROM memory_nodes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** 删除所有记忆和边 */
  deleteAll(): void {
    this.db.exec('DELETE FROM memory_edges');
    this.db.exec('DELETE FROM memory_nodes');
  }

  /** 按原始数据插入记忆节点（恢复用，保留原 ID 和时间戳） */
  insertMemory(mem: MemoryNode): void {
    this.db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, content=excluded.content, valence=excluded.valence, salience=excluded.salience, created_at=excluded.created_at, last_accessed_at=excluded.last_accessed_at`,
    ).run(mem.id, mem.kind, mem.content, mem.valence, mem.salience, mem.createdAt, mem.lastAccessedAt);
  }

  private toNode(row: MemoryRow): MemoryNode {
    return {
      id: row.id,
      kind: row.kind as MemoryKind,
      content: row.content,
      valence: row.valence,
      salience: row.salience,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
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
