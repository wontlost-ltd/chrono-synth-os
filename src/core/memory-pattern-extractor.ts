/**
 * 记忆模式提取器
 * must-think 第六节：Memory -> Pattern -> Value Shift -> Parameter Update
 * 从固化记忆中提取模式，生成价值权重漂移提案
 */

import type { CoreValue, MemoryNode } from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';

export interface PatternExtractionConfig {
  /** 触发模式提取的最低记忆数量 */
  minMemoryCount: number;
  /** |avg valence| 必须超过此值 */
  valenceThreshold: number;
  /** delta = valenceAvg * salienceAvg * driftSensitivity */
  driftSensitivity: number;
  /** 单次最大权重漂移 */
  maxDriftDelta: number;
  /** 情绪事件触发阈值：|valence| × salience 超过此值视为强情绪事件 */
  emotionalEventThreshold: number;
  /** 情绪事件权重漂移灵敏度 */
  emotionalDriftSensitivity: number;
}

export interface MemoryPattern {
  readonly id: string;
  readonly relatedValueId: string;
  readonly relatedValueLabel: string;
  readonly valenceAvg: number;
  readonly salienceAvg: number;
  readonly memoryCount: number;
  readonly suggestedWeightDelta: number;
  readonly extractedAt: number;
}

export interface ValueUpdateProposal {
  readonly valueId: string;
  readonly currentWeight: number;
  readonly suggestedWeight: number;
  readonly delta: number;
  readonly reason: string;
}

const DEFAULT_CONFIG: PatternExtractionConfig = {
  minMemoryCount: 5,
  valenceThreshold: 0.4,
  driftSensitivity: 0.5,
  maxDriftDelta: 0.1,
  emotionalEventThreshold: 0.7,
  emotionalDriftSensitivity: 0.3,
};

const LAYER = 'PatternExtractor';

/** 权重变化的最小有效阈值，低于此值的漂移忽略 */
const WEIGHT_DELTA_EPSILON = 1e-6;

/**
 * CJK + 拉丁文分词器（与 rule-engine 一致）
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean),
  );
}

/** 检查两个 token 集合是否存在交集 */
function hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}

export class MemoryPatternExtractor {
  private readonly config: PatternExtractionConfig;

  constructor(
    private readonly clock: Clock,
    private readonly logger?: Logger,
    config?: Partial<PatternExtractionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从记忆中提取模式：
   * 1. 过滤 semantic 记忆（已固化的知识）
   * 2. 对每个 CoreValue，用 tokenize 匹配记忆 content
   * 3. 计算相关记忆的 avg valence 和 avg salience
   * 4. 满足阈值条件则生成 MemoryPattern
   */
  extractPatterns(
    memories: ReadonlyMap<string, MemoryNode>,
    values: ReadonlyMap<string, CoreValue>,
  ): MemoryPattern[] {
    /* 仅处理 semantic 记忆（已固化） */
    const semanticMemories: MemoryNode[] = [];
    for (const m of memories.values()) {
      if (m.kind === 'semantic') {
        semanticMemories.push(m);
      }
    }

    if (semanticMemories.length === 0) return [];

    const patterns: MemoryPattern[] = [];
    const now = this.clock.now();

    for (const value of values.values()) {
      const valueTokens = tokenize(value.label);
      if (valueTokens.size === 0) continue;

      /* 匹配与该价值相关的记忆 */
      const related: MemoryNode[] = [];
      for (const mem of semanticMemories) {
        if (hasTokenOverlap(valueTokens, tokenize(mem.content))) {
          related.push(mem);
        }
      }

      if (related.length < this.config.minMemoryCount) continue;

      const valenceAvg = related.reduce((sum, m) => sum + m.valence, 0) / related.length;
      const salienceAvg = related.reduce((sum, m) => sum + m.salience, 0) / related.length;

      if (Math.abs(valenceAvg) < this.config.valenceThreshold) continue;

      const rawDelta = valenceAvg * salienceAvg * this.config.driftSensitivity;
      const suggestedWeightDelta = Math.max(
        -this.config.maxDriftDelta,
        Math.min(this.config.maxDriftDelta, rawDelta),
      );

      const pattern: MemoryPattern = {
        id: `pat_${value.id}_${now}`,
        relatedValueId: value.id,
        relatedValueLabel: value.label,
        valenceAvg,
        salienceAvg,
        memoryCount: related.length,
        suggestedWeightDelta,
        extractedAt: now,
      };

      patterns.push(pattern);
      this.logger?.info(LAYER, `模式提取: ${value.label} — ${related.length} 条记忆, 建议漂移 ${suggestedWeightDelta.toFixed(4)}`);
    }

    return patterns;
  }

  /**
   * 将模式转换为价值更新提案
   */
  patternsToProposals(
    patterns: readonly MemoryPattern[],
    values: ReadonlyMap<string, CoreValue>,
  ): ValueUpdateProposal[] {
    const proposals: ValueUpdateProposal[] = [];

    for (const pattern of patterns) {
      const value = values.get(pattern.relatedValueId);
      if (!value) continue;

      const suggestedWeight = Math.max(0, Math.min(1, value.weight + pattern.suggestedWeightDelta));
      const delta = suggestedWeight - value.weight;

      if (Math.abs(delta) < WEIGHT_DELTA_EPSILON) continue;

      proposals.push({
        valueId: pattern.relatedValueId,
        currentWeight: value.weight,
        suggestedWeight,
        delta,
        reason: `记忆模式漂移: ${pattern.memoryCount} 条 semantic 记忆, 平均情感 ${pattern.valenceAvg.toFixed(2)}, 平均显著性 ${pattern.salienceAvg.toFixed(2)}`,
      });
    }

    return proposals;
  }

  /**
   * 强情绪事件检测（must-think 第八节触发机制之一）
   * 扫描 episodic 记忆中 |valence| × salience 超过阈值的条目，
   * 与关联价值维度产生即时漂移提案
   */
  extractEmotionalEvents(
    memories: ReadonlyMap<string, MemoryNode>,
    values: ReadonlyMap<string, CoreValue>,
  ): ValueUpdateProposal[] {
    const proposals: ValueUpdateProposal[] = [];

    for (const mem of memories.values()) {
      if (mem.kind !== 'episodic') continue;
      const intensity = Math.abs(mem.valence) * mem.salience;
      if (intensity < this.config.emotionalEventThreshold) continue;

      const contentTokens = tokenize(mem.content);

      for (const value of values.values()) {
        const valueTokens = tokenize(value.label);
        if (!hasTokenOverlap(valueTokens, contentTokens)) continue;

        const rawDelta = mem.valence * mem.salience * this.config.emotionalDriftSensitivity;
        const clampedDelta = Math.max(-this.config.maxDriftDelta, Math.min(this.config.maxDriftDelta, rawDelta));
        const suggestedWeight = Math.max(0, Math.min(1, value.weight + clampedDelta));
        const delta = suggestedWeight - value.weight;
        if (Math.abs(delta) < WEIGHT_DELTA_EPSILON) continue;

        proposals.push({
          valueId: value.id,
          currentWeight: value.weight,
          suggestedWeight,
          delta,
          reason: `强情绪事件: 「${mem.content.slice(0, 30)}」 情感=${mem.valence.toFixed(2)}, 显著性=${mem.salience.toFixed(2)}`,
        });
        this.logger?.info(LAYER, `情绪事件触发: ${value.label} — 记忆 ${mem.id}, 建议漂移 ${delta.toFixed(4)}`);
      }
    }

    return proposals;
  }
}
