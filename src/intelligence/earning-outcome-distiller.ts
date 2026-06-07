/**
 * 收益蒸馏器（ADR-0048 D5 + ADR-0047）。
 *
 * 把"挣到的经验"转成确定性人格成长——但绝不直接改核心状态：所有产物都作为
 * 蒸馏候选交给 DistillationService，经校验 → 门控 → （自动或人工审批）编译。
 * 这闭合 earn→grow 飞轮，且复用 ADR-0047 同一安全门。
 *
 * 映射（确定性、保守）：
 *   - 高质量完成任务 → value_shift：对 owner 指定的"该 category 对应价值"做小幅正向
 *     漂移（delta 由质量分缩放，封顶在自动编译阈值内）。patternAgrees=true 仅当
 *     质量足够高（视为强信号）。
 *   - 同时产出 memory_edge 候选：把本次任务记忆与该价值/既有任务记忆关联（可选）。
 *
 * 不做的事：不写钱包、不改声誉（那是结算路径的事）、不在低质量时强行成长。
 */

import type { Logger } from '../utils/logger.js';
import type { DistillationService, IngestResult } from './distillation-service.js';
import type { ArtifactEvidence } from '@chrono/kernel';

/** 自动编译阈值对齐 DistillationService（value_shift: delta ≤ 0.05, conf ≥ 0.8） */
const MAX_GROWTH_DELTA = 0.05;
/** 质量高于此值才视为"强信号"（patternAgrees=true，可走自动编译） */
const STRONG_SIGNAL_QUALITY = 0.8;

export interface EarningOutcomeInput {
  readonly tenantId: string;
  readonly personaId: string;
  readonly taskId: string;
  readonly category: string;
  /** 任务验收质量分 0..1 */
  readonly qualityScore: number;
  /** 结算报酬（用于 evidence/置信度参考） */
  readonly payout: number;
  /** owner 配置的"该 category → 价值 id + 当前权重"映射；缺省则不产 value_shift */
  readonly targetValue?: { readonly valueId: string; readonly currentWeight: number };
  /** 可选：把本次任务记忆与既有记忆关联（产 memory_edge 候选，ADR-0048 D5） */
  readonly linkMemory?: { readonly sourceId: string; readonly targetId: string; readonly relation: string };
}

export interface DistillEarningResult {
  /** 产生的候选数（0 表示质量太低或无映射，未产候选） */
  readonly candidatesIngested: number;
  readonly results: readonly IngestResult[];
}

export class EarningOutcomeDistiller {
  constructor(
    private readonly distillation: DistillationService,
    private readonly logger?: Logger,
  ) {}

  /**
   * 把一次任务收益蒸馏为成长候选。纯编排：构造候选 → 交 DistillationService 门控。
   * 低质量（<0.5）不产成长候选（不奖励烂活）；无 targetValue 映射则跳过 value_shift。
   */
  distill(input: EarningOutcomeInput): DistillEarningResult {
    const quality = clamp01(input.qualityScore);
    if (quality < 0.5) {
      this.logger?.info('EarningOutcomeDistiller', `质量 ${quality} <0.5，不产成长候选: task=${input.taskId}`);
      return { candidatesIngested: 0, results: [] };
    }

    const evidence: ArtifactEvidence[] = [
      /* 任务完成本身是一条经历记忆；质量分作为统计 pattern 信号 */
      { type: 'memory', id: `task:${input.taskId}`, score: quality },
      { type: 'pattern', id: `earning:${input.category}`, score: Math.min(1, input.payout / 100) },
    ];
    const patternAgrees = quality >= STRONG_SIGNAL_QUALITY; /* 强信号(≥0.8)→ 可自动编译 */
    const confidence = patternAgrees ? 0.85 : 0.7;
    const results: IngestResult[] = [];

    /* ① value_shift：仅当有 category→value 映射时 */
    if (input.targetValue) {
      const { valueId, currentWeight } = input.targetValue;
      const suggestedWeight = clamp01(round(currentWeight + MAX_GROWTH_DELTA * quality, 4));
      const actualDelta = round(suggestedWeight - currentWeight, 4);
      const r = this.distillation.ingest(input.personaId, {
        kind: 'value_shift',
        source: 'conversation',
        payload: { valueId, currentWeight, suggestedWeight, delta: actualDelta, patternAgrees },
        confidence,
        evidence,
      });
      results.push(r);
      this.logger?.info('EarningOutcomeDistiller', `收益蒸馏 → value_shift ${valueId} Δ${actualDelta} status=${r.status}`);
    }

    /* ② memory_edge：仅当 owner 提供了记忆关联（ADR-0048 D5） */
    if (input.linkMemory && input.linkMemory.sourceId !== input.linkMemory.targetId) {
      const { sourceId, targetId, relation } = input.linkMemory;
      const r = this.distillation.ingest(input.personaId, {
        kind: 'memory_edge',
        source: 'conversation',
        payload: { sourceId, targetId, relation, strength: clamp01(quality) },
        confidence,
        evidence,
      });
      results.push(r);
      this.logger?.info('EarningOutcomeDistiller', `收益蒸馏 → memory_edge ${sourceId}->${targetId} status=${r.status}`);
    }

    if (results.length === 0) {
      this.logger?.info('EarningOutcomeDistiller', `无 value 映射且无记忆关联，未产候选: ${input.category}`);
    }
    return { candidatesIngested: results.length, results };
  }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function round(n: number, dp: number): number { const f = 10 ** dp; return Math.round(n * f) / f; }
