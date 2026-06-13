/**
 * LLM 反思蒸馏器（ADR-0047 growth 档 · 让人格不靠 marketplace 也能成长）。
 *
 * 背景：确定性反思（runCognitionCycle → memory-pattern-extractor → UpdateGate）已在 autorun
 * 周期跑，零-LLM 也能从记忆统计 pattern 产价值漂移。本蒸馏器是**可选的 growth 增强档**：当注入
 * LLM 时，额外用 LLM 作为「老师」反思最近的高显著记忆 + 叙事，提出更丰富的成长候选
 * （value_shift / memory_edge / narrative_patch）。
 *
 * 不变量（ADR-0047 D3）：LLM 输出**不可信**，绝不直接改核心状态。所有候选都交
 * DistillationService 经统一门（core-update-gate）：
 *   - value_shift：满足 confidence≥0.8 ∧ patternAgrees ∧ |delta|≤0.05 则自动编译；
 *   - memory_edge：满足 confidence≥0.75 ∧ evidenceCount≥2 则自动编译（仅链接两条真实记忆，安全）；
 *   - narrative_patch / rule 等改「我是谁」的 kind：保守，默认需人工审批（不自动编译）。
 * 进门前先**硬校验**：valueId/memoryId 必须真实存在；value_shift delta **先封顶**到「单周期剩余预算」
 * 再过门（门看到的已是合法 delta）；字段非空。畸形/幻觉直接丢弃。
 *
 * 纯编排：不写核心状态、不调 UpdateGate、不与确定性反思争用——它只产候选喂门。
 */

import type { Logger } from '../utils/logger.js';
import type { LLMProvider, ArtifactEvidence } from '@chrono/kernel';
import { safeParseJson } from '@chrono/kernel';
import type { DistillationService, IngestResult } from './distillation-service.js';

/** value_shift 自动编译阈值（对齐 core-update-gate：|delta| ≤ 0.05）。LLM 提案一律封顶于此。 */
const MAX_REFLECTION_DELTA = 0.05;
/** 参与反思的最多记忆条数（控成本 + 聚焦高显著）。 */
const MAX_REFLECT_MEMORIES = 12;
/** LLM 反思候选的基础置信度（低于 earning 的强信号；value_shift 仍需满足门才自动编译）。 */
const REFLECTION_CONFIDENCE = 0.8;

/** 反思可见的一条记忆（已脱敏的最小投影）。 */
export interface ReflectMemory {
  readonly id: string;
  readonly content: string;
  readonly salience: number;
  readonly valence: number;
}

/** 反思可见的一个核心价值（用于 LLM 选择强化哪个 + 校验 valueId 真实）。 */
export interface ReflectValue {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

export interface LlmReflectionInput {
  readonly personaId: string;
  readonly narrative: string;
  /** 当前核心价值（LLM 只能在这些已存在的 value 上提漂移）。 */
  readonly values: readonly ReflectValue[];
  /** 候选记忆（调用方应已按 salience 降序截断到合理规模）。 */
  readonly memories: readonly ReflectMemory[];
  /**
   * 本 autorun 周期内**确定性反思已对各 value 应用的漂移**（valueId → 已用 delta）。
   * 用于「单周期单 value 累计漂移预算」（Codex 复审）：LLM 反思的 value_shift 会从
   * MAX_REFLECTION_DELTA 里扣掉已用量，使两条自动路径同周期对同一 value 的净漂移不超过 0.05，
   * 不绕过 core-update-gate 的小步防漂移意图。缺省视为本周期尚未漂移。
   */
  readonly appliedDeltas?: ReadonlyMap<string, number>;
}

export interface LlmReflectionResult {
  readonly candidatesIngested: number;
  readonly results: readonly IngestResult[];
}

/** LLM 反思的结构化输出契约（强约束 JSON）。所有字段都视为不可信，进门前硬校验。 */
interface ReflectionProposal {
  readonly valueShift?: { readonly valueId?: unknown; readonly delta?: unknown; readonly reason?: unknown };
  readonly memoryLink?: { readonly sourceId?: unknown; readonly targetId?: unknown; readonly relation?: unknown };
  readonly narrative?: unknown;
}

export class LlmReflectionDistiller {
  constructor(
    private readonly distillation: DistillationService,
    private readonly llm: LLMProvider,
    private readonly logger?: Logger,
  ) {}

  /**
   * 反思一次：LLM 提案 → 硬校验 → 过蒸馏门。无可用记忆/价值则跳过（不强行成长）。
   * 任一步失败（LLM 错、JSON 畸形、校验不过）安全降级为「未产候选」，绝不抛进 autorun 主流程。
   */
  async distill(input: LlmReflectionInput): Promise<LlmReflectionResult> {
    if (input.values.length === 0 || input.memories.length === 0) {
      this.logger?.info('LlmReflectionDistiller', '无价值或无记忆可反思，跳过');
      return { candidatesIngested: 0, results: [] };
    }

    const memories = input.memories.slice(0, MAX_REFLECT_MEMORIES);
    const proposal = await this.askLlm(input, memories);
    if (!proposal) return { candidatesIngested: 0, results: [] };

    const valueById = new Map(input.values.map((v) => [v.id, v]));
    const memoryIds = new Set(memories.map((m) => m.id));
    const evidence: ArtifactEvidence[] = memories.slice(0, 3).map((m) => ({ type: 'memory', id: m.id, score: clamp01(m.salience) }));
    const results: IngestResult[] = [];

    /* ① value_shift：valueId 必须真实存在；delta 封顶到「单周期单 value 剩余预算」（0.05 减去本周期
     * 确定性反思已用量），patternAgrees=true（仍需过门 confidence/delta 才自动编译）。 */
    const vs = this.buildValueShift(proposal.valueShift, valueById, input.appliedDeltas);
    if (vs) {
      const r = this.distillation.ingest(input.personaId, {
        kind: 'value_shift', source: 'reflection',
        payload: vs, confidence: REFLECTION_CONFIDENCE, evidence,
      });
      results.push(r);
      this.logger?.info('LlmReflectionDistiller', `反思 → value_shift ${vs.valueId} Δ${vs.delta} status=${r.status}`);
    }

    /* ② memory_edge：source/target 必须都是本次反思可见的真实记忆且不同。LLM 来源默认需审批。 */
    const me = this.buildMemoryLink(proposal.memoryLink, memoryIds);
    if (me) {
      const r = this.distillation.ingest(input.personaId, {
        kind: 'memory_edge', source: 'reflection',
        payload: me, confidence: REFLECTION_CONFIDENCE, evidence,
      });
      results.push(r);
      this.logger?.info('LlmReflectionDistiller', `反思 → memory_edge ${me.sourceId}->${me.targetId} status=${r.status}`);
    }

    /* ③ narrative_patch：非空且与原叙事不同才提。LLM 来源默认需审批（改「我是谁」更谨慎）。 */
    const narrative = typeof proposal.narrative === 'string' ? proposal.narrative.trim() : '';
    if (narrative.length > 0 && narrative !== input.narrative.trim()) {
      const r = this.distillation.ingest(input.personaId, {
        kind: 'narrative_patch', source: 'reflection',
        payload: { narrative }, confidence: REFLECTION_CONFIDENCE, evidence,
      });
      results.push(r);
      this.logger?.info('LlmReflectionDistiller', `反思 → narrative_patch status=${r.status}`);
    }

    if (results.length === 0) this.logger?.info('LlmReflectionDistiller', '反思未产出有效候选');
    return { candidatesIngested: results.length, results };
  }

  /** 调 LLM 反思，JSON 解析。任一失败返回 undefined（安全降级）。 */
  private async askLlm(input: LlmReflectionInput, memories: readonly ReflectMemory[]): Promise<ReflectionProposal | undefined> {
    const system = [
      'TASK:REFLECT',
      '你在帮助一个数字人格反思最近的经历，提出**保守的、有据可循的**成长建议。',
      '只能强化已存在的价值；记忆关联只能用给定的记忆 id；不确定时留空对应字段。',
      '返回 JSON: {"valueShift":{"valueId":"...","delta":0.03,"reason":"..."},' +
        '"memoryLink":{"sourceId":"...","targetId":"...","relation":"..."},"narrative":"..."}',
      `价值漂移 delta 绝对值不得超过 ${MAX_REFLECTION_DELTA}。无合适建议则该字段省略。`,
    ].join('\n');
    const user = [
      `人格叙事:\n${input.narrative || '（暂无）'}`,
      `当前核心价值:\n${input.values.map((v) => `- ${v.id} 「${v.label}」 权重${v.weight}`).join('\n')}`,
      `最近高显著记忆:\n${memories.map((m) => `- [${m.id}] (显著${m.salience.toFixed(2)} 情感${m.valence.toFixed(2)}) ${m.content.slice(0, 200)}`).join('\n')}`,
    ].join('\n\n');

    try {
      const res = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<ReflectionProposal>(res.content);
      return parsed ?? undefined;
    } catch (err) {
      this.logger?.warn('LlmReflectionDistiller', `LLM 反思失败，跳过本轮: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 校验并构造 value_shift payload。valueId 不存在 / delta 非法 / 周期预算已用尽 → null（丢弃）。 */
  private buildValueShift(
    raw: ReflectionProposal['valueShift'],
    valueById: ReadonlyMap<string, ReflectValue>,
    appliedDeltas?: ReadonlyMap<string, number>,
  ): { valueId: string; currentWeight: number; suggestedWeight: number; delta: number; patternAgrees: boolean } | null {
    if (!raw || typeof raw.valueId !== 'string') return null;
    const value = valueById.get(raw.valueId);
    if (!value) return null; /* 幻觉的不存在 valueId */
    /* 单周期单 value 累计漂移预算（Codex 复审）：0.05 减去本周期确定性反思已用的同向漂移。
     * 已用量取绝对值扣减，剩余预算 ≤0 则本周期该 value 不再让 LLM 漂移（避免两路径叠加超 0.05）。 */
    const usedThisCycle = Math.abs(appliedDeltas?.get(value.id) ?? 0);
    const remainingBudget = round(MAX_REFLECTION_DELTA - usedThisCycle, 4);
    if (remainingBudget <= 0) return null;
    const rawDelta = typeof raw.delta === 'number' && Number.isFinite(raw.delta) ? raw.delta : 0;
    /* 封顶到 ±剩余预算，并禁止 0（无意义提案）。 */
    const delta = round(clamp(rawDelta, -remainingBudget, remainingBudget), 4);
    if (delta === 0) return null;
    const suggestedWeight = clamp01(round(value.weight + delta, 4));
    const actualDelta = round(suggestedWeight - value.weight, 4);
    if (actualDelta === 0) return null; /* clamp 后无净变化 */
    return { valueId: value.id, currentWeight: value.weight, suggestedWeight, delta: actualDelta, patternAgrees: true };
  }

  /** 校验并构造 memory_edge payload。source/target 必须是可见记忆且不同 → 否则 null。 */
  private buildMemoryLink(
    raw: ReflectionProposal['memoryLink'],
    memoryIds: ReadonlySet<string>,
  ): { sourceId: string; targetId: string; relation: string; strength: number } | null {
    if (!raw || typeof raw.sourceId !== 'string' || typeof raw.targetId !== 'string') return null;
    if (raw.sourceId === raw.targetId) return null;
    if (!memoryIds.has(raw.sourceId) || !memoryIds.has(raw.targetId)) return null; /* 幻觉的不存在记忆 */
    const relation = typeof raw.relation === 'string' && raw.relation.trim().length > 0 ? raw.relation.trim() : 'related';
    return { sourceId: raw.sourceId, targetId: raw.targetId, relation, strength: 0.5 };
  }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function round(n: number, dp: number): number { const f = 10 ** dp; return Math.round(n * f) / f; }
