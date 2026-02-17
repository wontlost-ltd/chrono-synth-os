/**
 * 核心节律层（慢层）
 * 维护稳定的记忆、叙事和核心价值权重
 * 更新缓慢以保持连续性，作为锚定自我防止身份漂移
 */

import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type { CoreSelfState, CoreValue, MemoryEdge, MemoryId, MemoryKind, MemoryNode, ValueId } from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { MemoryGraph } from './memory-graph.js';
import { NarrativeStore } from './narrative-store.js';
import { ValueStore } from './value-store.js';

const LAYER = 'CoreRhythm';

export class CoreRhythmLayer {
  readonly values: ValueStore;
  readonly memories: MemoryGraph;
  readonly narrative: NarrativeStore;

  constructor(
    db: IDatabase,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.values = new ValueStore(db, clock);
    this.memories = new MemoryGraph(db, clock);
    this.narrative = new NarrativeStore(db, clock);
  }

  /** 添加核心价值 */
  addValue(label: string, weight: number): CoreValue {
    const value = this.values.create(label, weight);
    this.bus.emit('core:value-updated', { value });
    this.logger.info(LAYER, `价值已添加: ${label} (权重=${weight})`);
    return value;
  }

  /** 更新价值权重 */
  updateValue(id: ValueId, weight: number): CoreValue | undefined {
    const value = this.values.updateWeight(id, weight);
    if (value) {
      this.bus.emit('core:value-updated', { value });
      this.logger.info(LAYER, `价值已更新: ${value.label} → 权重=${weight}`);
    }
    return value;
  }

  /** 添加记忆 */
  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    const memory = this.memories.addMemory(kind, content, valence, salience);
    this.bus.emit('core:memory-added', { memory });
    this.logger.info(LAYER, `记忆已添加: [${kind}] id=${memory.id}`);
    return memory;
  }

  /** 访问记忆 */
  accessMemory(id: string): MemoryNode | undefined {
    const memory = this.memories.accessMemory(id);
    if (memory) {
      this.bus.emit('core:memory-accessed', { memoryId: id });
    }
    return memory;
  }

  /** 关联两个记忆 */
  linkMemories(source: string, target: string, relation: string, strength: number): MemoryEdge {
    return this.memories.addEdge(source, target, relation, strength);
  }

  /** 更新叙事 */
  updateNarrative(content: string): void {
    const previous = this.narrative.set(content);
    this.bus.emit('core:narrative-changed', { narrative: content, previousNarrative: previous });
    this.logger.info(LAYER, '叙事已更新');
  }

  /** 获取当前完整状态快照 */
  getState(): CoreSelfState {
    return {
      values: this.values.getAll(),
      memories: this.memories.getAllMemories(),
      edges: this.memories.getAllEdges(),
      narrative: this.narrative.get(),
      updatedAt: this.clock.now(),
    };
  }

  /** 从快照恢复价值（清空后重建） */
  restoreValues(values: ReadonlyMap<ValueId, CoreValue>): void {
    this.values.deleteAll();
    for (const [, value] of values) {
      this.values.insert(value);
    }
    this.logger.info(LAYER, `价值已恢复: ${values.size} 项`);
  }

  /** 从快照恢复记忆和边（清空后重建） */
  restoreMemories(memories: ReadonlyMap<MemoryId, MemoryNode>, edges: readonly MemoryEdge[]): void {
    this.memories.deleteAll();
    for (const [, mem] of memories) {
      this.memories.insertMemory(mem);
    }
    for (const edge of edges) {
      this.memories.addEdge(edge.source, edge.target, edge.relation, edge.strength);
    }
    this.logger.info(LAYER, `记忆已恢复: ${memories.size} 节点, ${edges.length} 边`);
  }
}
