/**
 * 核心节律层（慢层）
 * 维护稳定的记忆、叙事和核心价值权重
 * 更新缓慢以保持连续性，作为锚定自我防止身份漂移
 */

import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type {
  CoreSelfState, CoreValue, MemoryEdge, MemoryId, MemoryKind, MemoryNode, ValueId,
  MemoryCognitionConfig, ActivationResult, ConsolidationResult, WorkingMemorySlot,
} from '../types/core-self.js';
import type { SurvivalAnchor, DecisionStyle, CognitiveModel } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { CognitiveMemoryGraph } from './memory-graph.js';
import type { FieldEncryption } from '../storage/encryption.js';
import { CognitiveModelStore } from './cognitive-model-store.js';
import { DecisionStyleStore } from './decision-style-store.js';
import { NarrativeStore } from './narrative-store.js';
import { SurvivalAnchorStore, type SurvivalAnchorUpdate } from './survival-anchor-store.js';
import { ValueStore } from './value-store.js';

const LAYER = 'CoreRhythm';

export class CoreRhythmLayer {
  readonly values: ValueStore;
  readonly memories: CognitiveMemoryGraph;
  readonly narrative: NarrativeStore;
  readonly survival: SurvivalAnchorStore;
  readonly decisionStyle: DecisionStyleStore;
  readonly cognitiveModel: CognitiveModelStore;

  constructor(
    db: IDatabase,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    cognitionConfig?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
    private readonly tenantId?: string,
  ) {
    this.values = new ValueStore(db, clock);
    this.memories = new CognitiveMemoryGraph(db, clock, cognitionConfig, encryption);
    this.narrative = new NarrativeStore(db, clock);
    this.survival = new SurvivalAnchorStore(db, clock);
    this.decisionStyle = new DecisionStyleStore(db, clock);
    this.cognitiveModel = new CognitiveModelStore(db, clock);
  }

  /** 添加核心价值 */
  addValue(label: string, weight: number, timeDiscount?: number, emotionAmplifier?: number): CoreValue {
    const value = this.values.create(label, weight, timeDiscount, emotionAmplifier);
    this.bus.emit('core:value-updated', { value, tenantId: this.tenantId });
    this.logger.info(LAYER, `价值已添加: ${label} (权重=${weight})`);
    return value;
  }

  /** 更新价值权重（向后兼容） */
  updateValue(id: ValueId, weight: number): CoreValue | undefined {
    return this.updateValueParams(id, { weight });
  }

  /** 更新价值参数 */
  updateValueParams(
    id: ValueId,
    patch: { weight?: number; timeDiscount?: number; emotionAmplifier?: number },
  ): CoreValue | undefined {
    const value = this.values.update(id, patch);
    if (value) {
      this.bus.emit('core:value-updated', { value, tenantId: this.tenantId });
      const parts: string[] = [];
      if (patch.weight !== undefined) parts.push(`权重=${patch.weight}`);
      if (patch.timeDiscount !== undefined) parts.push(`时间折扣=${patch.timeDiscount}`);
      if (patch.emotionAmplifier !== undefined) parts.push(`情绪放大=${patch.emotionAmplifier}`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      this.logger.info(LAYER, `价值已更新: ${value.label}${detail}`);
    }
    return value;
  }

  /** 添加记忆 */
  addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode {
    const memory = this.memories.addMemory(kind, content, valence, salience);
    this.bus.emit('core:memory-added', { memory, tenantId: this.tenantId });
    this.logger.info(LAYER, `记忆已添加: [${kind}] id=${memory.id}`);
    return memory;
  }

  /** 访问记忆（自动触发 lazy decay 和访问计数更新） */
  accessMemory(id: string): MemoryNode | undefined {
    const memory = this.memories.accessMemory(id);
    if (memory) {
      this.bus.emit('core:memory-accessed', { memoryId: id, tenantId: this.tenantId });
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
    this.bus.emit('core:narrative-changed', { narrative: content, previousNarrative: previous, tenantId: this.tenantId });
    this.logger.info(LAYER, '叙事已更新');
  }

  // ===== L0 生存锚点 =====

  /** 添加生存锚点 */
  addSurvivalAnchor(label: string, kind: SurvivalAnchor['kind'], value: unknown, severity: number): SurvivalAnchor {
    const anchor = this.survival.create(label, kind, value, severity);
    this.bus.emit('core:survival-updated', { anchor, tenantId: this.tenantId });
    this.logger.info(LAYER, `生存锚点已添加: ${label} (类型=${kind}, 严重度=${severity})`);
    return anchor;
  }

  /** 更新生存锚点 */
  updateSurvivalAnchor(id: string, patch: SurvivalAnchorUpdate): SurvivalAnchor | undefined {
    const anchor = this.survival.update(id, patch);
    if (anchor) {
      this.bus.emit('core:survival-updated', { anchor, tenantId: this.tenantId });
      this.logger.info(LAYER, `生存锚点已更新: ${anchor.label}`);
    }
    return anchor;
  }

  /** 删除生存锚点 */
  deleteSurvivalAnchor(id: string): boolean {
    return this.survival.delete(id);
  }

  // ===== L2 决策风格 =====

  /** 设置决策风格（合并更新） */
  setDecisionStyle(patch: Partial<DecisionStyle>): DecisionStyle {
    const style = this.decisionStyle.set(patch);
    this.bus.emit('core:decision-style-updated', { style, tenantId: this.tenantId });
    this.logger.info(LAYER, '决策风格已更新');
    return style;
  }

  // ===== L3 认知模型 =====

  /** 设置认知模型（合并更新） */
  setCognitiveModel(patch: Partial<CognitiveModel>): CognitiveModel {
    const model = this.cognitiveModel.set(patch);
    this.bus.emit('core:cognitive-model-updated', { model, tenantId: this.tenantId });
    this.logger.info(LAYER, '认知模型已更新');
    return model;
  }

  /** 获取当前完整状态快照 */
  getState(): CoreSelfState {
    return {
      values: this.values.getAll(),
      memories: this.memories.getAllMemories(),
      edges: this.memories.getAllEdges(),
      narrative: this.narrative.get(),
      survivalAnchors: this.survival.getAll(),
      decisionStyle: this.decisionStyle.get(),
      cognitiveModel: this.cognitiveModel.get(),
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

  /** 从快照恢复生存锚点（清空后重建） */
  restoreSurvivalAnchors(anchors: readonly SurvivalAnchor[]): void {
    this.survival.deleteAll();
    for (const anchor of anchors) {
      this.survival.insert(anchor);
    }
    this.logger.info(LAYER, `生存锚点已恢复: ${anchors.length} 项`);
  }

  /** 从快照恢复决策风格 */
  restoreDecisionStyle(style: DecisionStyle): void {
    this.decisionStyle.set(style);
    this.logger.info(LAYER, '决策风格已恢复');
  }

  /** 从快照恢复认知模型 */
  restoreCognitiveModel(model: CognitiveModel): void {
    this.cognitiveModel.set(model);
    this.logger.info(LAYER, '认知模型已恢复');
  }

  // ===== 认知方法 =====

  /** 触发全量衰减 */
  runMemoryDecay(): Array<{ memoryId: string; oldSalience: number; newSalience: number }> {
    const results = this.memories.decayAll();
    for (const r of results) {
      this.bus.emit('core:memory-decayed', { ...r, tenantId: this.tenantId });
    }
    if (results.length > 0) {
      this.logger.info(LAYER, `记忆衰减: ${results.length} 个记忆受影响`);
    }
    return results;
  }

  /** 触发扩散激活 */
  activateMemory(id: MemoryId): ActivationResult[] {
    const results = this.memories.spreadActivation(id);
    if (results.length > 0) {
      this.bus.emit('core:memory-activated', { sourceId: id, results, tenantId: this.tenantId });
      this.logger.info(LAYER, `扩散激活: 从 ${id} 激活了 ${results.length} 个相邻记忆`);
    }
    return results;
  }

  /** 触发记忆固化 */
  runConsolidation(): ConsolidationResult[] {
    const results = this.memories.consolidateAll();
    for (const r of results) {
      this.bus.emit('core:memory-consolidated', { result: r, tenantId: this.tenantId });
    }
    if (results.length > 0) {
      this.logger.info(LAYER, `记忆固化: ${results.length} 个 episodic 记忆转为 semantic`);
    }
    return results;
  }

  /** 获取工作记忆 */
  getWorkingMemory(): WorkingMemorySlot[] {
    return this.memories.getWorkingMemorySlots();
  }

  /** 刷新并广播工作记忆 */
  refreshWorkingMemory(): WorkingMemorySlot[] {
    const slots = this.memories.refreshWorkingMemory();
    this.bus.emit('core:working-memory-updated', { slots, tenantId: this.tenantId });
    return slots;
  }
}
