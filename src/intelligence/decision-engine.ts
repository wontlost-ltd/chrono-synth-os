/**
 * 决策引擎
 * 结合五层人格状态、语义记忆检索和 LLM 蒙特卡洛模拟进行决策评估
 *
 * 核心流程：
 * 1. 编译 PersonaOSState → prompt 摘要
 * 2. 检索相关记忆
 * 3. 生成/确认备选方案
 * 4. 每个方案运行 N 次蒙特卡洛模拟
 * 5. 基于 L0-L3 结构化评分
 * 6. 排序并生成解释
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import type { SurvivalAnchor } from '../types/personality-os.js';
import type { LLMProvider } from './llm-provider.js';
import type { ContextMemory, RetrievalService } from './retrieval-service.js';
import { compilePersonaState, summarizeForPrompt } from './persona-state.js';
import type {
  DecisionCase, DecisionResult, Explanation, RankedOption,
  SimulationConfig, SimulationRollout,
} from './types.js';

export interface DecisionProgress {
  readonly progress: number;
  readonly stage: string;
}

export interface DecisionEngineOptions {
  readonly onProgress?: (progress: DecisionProgress) => void;
}

const LAYER = 'DecisionEngine';

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function safeParseJson<T>(content: string): T | undefined {
  try {
    return JSON.parse(content) as T;
  } catch {
    /* 尝试提取内嵌 JSON 对象 */
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return undefined;
    }
  }
}

function formatMemories(memories: readonly ContextMemory[]): string {
  if (memories.length === 0) return '无';
  return memories.map(m => `- (${m.score.toFixed(2)}) [${m.kind}] ${m.content}`).join('\n');
}

export class DecisionEngine {
  constructor(
    private readonly core: CoreRhythmLayer,
    private readonly retrieval: RetrievalService,
    private readonly llm: LLMProvider,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly config: SimulationConfig,
  ) {}

  async evaluate(decisionCase: DecisionCase, options?: DecisionEngineOptions): Promise<DecisionResult> {
    this.logger.info(LAYER, `开始决策模拟: ${decisionCase.id}`);
    const state = compilePersonaState(this.core);
    const personaSummary = summarizeForPrompt(state);
    const query = `${decisionCase.title}\n${decisionCase.description}`;

    /* 获取查询向量（容错：失败时退化为纯图检索） */
    let queryEmbedding: number[] = [];
    try {
      const embeddings = await this.llm.embed([query]);
      queryEmbedding = embeddings[0] ?? [];
    } catch (err) {
      this.logger.warn(LAYER, '查询向量获取失败，退化为图检索', err);
    }

    const contextMemories = this.retrieval.getContext(query, queryEmbedding, 5);
    options?.onProgress?.({ progress: 0.1, stage: 'context' });

    /* 获取备选方案 */
    const alternatives = await this.getAlternatives(decisionCase, personaSummary, contextMemories);
    const limited = alternatives.slice(0, Math.max(2, this.config.maxOptions));
    options?.onProgress?.({ progress: 0.2, stage: 'alternatives' });

    /* 构建价值权重映射（同时按 id 和 label 索引，方便 LLM 输出匹配） */
    const valueWeights = new Map<string, number>();
    for (const value of state.L1.values()) {
      valueWeights.set(value.id, value.weight);
      valueWeights.set(value.label, value.weight);
    }

    /* 逐方案模拟 + 评分 */
    const ranked: Array<{ option: RankedOption; score: number }> = [];
    for (let i = 0; i < limited.length; i++) {
      const alternative = limited[i];
      const rollouts = await this.runRollouts(
        decisionCase, alternative, personaSummary, contextMemories,
        valueWeights, state.L0, state.L2,
      );

      const aggregate = this.aggregateRollouts(rollouts);
      const explanation = await this.explainAlternative(decisionCase, alternative, rollouts, contextMemories);

      ranked.push({
        option: {
          alternative,
          rank: 0,
          alignmentScore: aggregate.alignmentScore,
          riskScore: aggregate.riskScore,
          confidence: aggregate.confidence,
          explanation,
        },
        score: aggregate.overallScore,
      });

      options?.onProgress?.({ progress: 0.2 + 0.8 * ((i + 1) / limited.length), stage: `simulated:${alternative}` });
    }

    ranked.sort((a, b) => b.score - a.score);
    const finalOptions = ranked.map((entry, idx) => ({ ...entry.option, rank: idx + 1 }));

    const result: DecisionResult = {
      caseId: decisionCase.id,
      recommendedAlternative: finalOptions[0]?.alternative ?? '',
      rankedOptions: finalOptions,
      simulatedAt: this.clock.now(),
    };

    this.logger.info(LAYER, `决策模拟完成: ${decisionCase.id}`);
    return result;
  }

  private async getAlternatives(
    decisionCase: DecisionCase,
    personaSummary: string,
    contextMemories: readonly ContextMemory[],
  ): Promise<string[]> {
    if (decisionCase.alternatives && decisionCase.alternatives.length > 0) {
      return [...decisionCase.alternatives];
    }

    const system = [
      'TASK:ALTERNATIVES',
      '请返回 JSON: {"alternatives": ["选项1","选项2"]}',
      `限制最多 ${this.config.maxOptions} 个选项`,
    ].join('\n');
    const user = [
      `人格摘要:\n${personaSummary}`,
      `决策标题: ${decisionCase.title}`,
      `决策描述: ${decisionCase.description}`,
      `约束: ${(decisionCase.constraints ?? []).join('; ') || '无'}`,
      `上下文: ${JSON.stringify(decisionCase.context ?? {})}`,
      `相关记忆:\n${formatMemories(contextMemories)}`,
    ].join('\n\n');

    try {
      const res = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<{ alternatives?: unknown }>(res.content);
      const list = Array.isArray(parsed?.alternatives)
        ? (parsed.alternatives as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim())
        : [];
      if (list.length > 0) return list;
    } catch (err) {
      this.logger.warn(LAYER, '备选项生成失败，使用默认选项', err);
    }

    return ['保持现状', '采取行动'];
  }

  private async runRollouts(
    decisionCase: DecisionCase,
    alternative: string,
    personaSummary: string,
    contextMemories: readonly ContextMemory[],
    valueWeights: ReadonlyMap<string, number>,
    anchors: readonly SurvivalAnchor[],
    decisionStyle: { riskAppetite: number; timeHorizon: number },
  ): Promise<SimulationRollout[]> {
    const total = Math.max(1, this.config.rollouts);
    const rollouts: SimulationRollout[] = [];
    for (let i = 0; i < total; i++) {
      rollouts.push(await this.simulateAlternative(
        decisionCase, alternative, personaSummary, contextMemories,
        valueWeights, anchors, decisionStyle,
      ));
    }
    return rollouts;
  }

  private async simulateAlternative(
    decisionCase: DecisionCase,
    alternative: string,
    personaSummary: string,
    contextMemories: readonly ContextMemory[],
    valueWeights: ReadonlyMap<string, number>,
    anchors: readonly SurvivalAnchor[],
    decisionStyle: { riskAppetite: number; timeHorizon: number },
  ): Promise<SimulationRollout> {
    const system = [
      'TASK:SIMULATE',
      '返回 JSON: {"outcomes":[...],"valueAlignment":{"value":0.5},"constraintViolations":[],"riskScore":0.5,"confidence":0.5}',
    ].join('\n');
    const user = [
      `人格摘要:\n${personaSummary}`,
      `决策标题: ${decisionCase.title}`,
      `决策描述: ${decisionCase.description}`,
      `备选方案: ${alternative}`,
      `约束: ${(decisionCase.constraints ?? []).join('; ') || '无'}`,
      `上下文: ${JSON.stringify(decisionCase.context ?? {})}`,
      `相关记忆:\n${formatMemories(contextMemories)}`,
    ].join('\n\n');

    let outcomes: string[] = [];
    let valueAlignment = new Map<string, number>();
    let constraintViolations: string[] = [];
    let riskScore = 0.5;
    let confidence = 0.5;

    try {
      const res = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<{
        outcomes?: unknown;
        valueAlignment?: Record<string, number>;
        constraintViolations?: unknown;
        riskScore?: number;
        confidence?: number;
      }>(res.content);

      if (Array.isArray(parsed?.outcomes)) {
        outcomes = (parsed.outcomes as unknown[]).filter((v): v is string => typeof v === 'string');
      }
      if (parsed?.valueAlignment && typeof parsed.valueAlignment === 'object') {
        valueAlignment = new Map(Object.entries(parsed.valueAlignment));
      }
      if (Array.isArray(parsed?.constraintViolations)) {
        constraintViolations = (parsed.constraintViolations as unknown[]).filter((v): v is string => typeof v === 'string');
      }
      riskScore = clamp01(parsed?.riskScore ?? riskScore);
      confidence = clamp01(parsed?.confidence ?? confidence);
    } catch (err) {
      this.logger.warn(LAYER, `模拟失败，使用回退策略: ${alternative}`, err);
    }

    const alignmentScore = this.computeAlignmentScore(valueWeights, valueAlignment);
    const constraintPenalty = this.computeConstraintPenalty(anchors, constraintViolations);
    const stylePenalty = this.computeStylePenalty(riskScore, decisionStyle);

    return {
      alternative,
      outcomes,
      valueAlignment,
      constraintViolations,
      alignmentScore,
      riskScore,
      confidence,
      overallScore: alignmentScore - constraintPenalty - stylePenalty,
    };
  }

  /** 价值对齐度 = 加权平均（L1 权重 × LLM 评估的对齐分数） */
  private computeAlignmentScore(
    valueWeights: ReadonlyMap<string, number>,
    alignment: ReadonlyMap<string, number>,
  ): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const [key, weight] of valueWeights) {
      if (!Number.isFinite(weight)) continue;
      totalWeight += weight;
      weighted += weight * clamp01(alignment.get(key) ?? 0);
    }
    return totalWeight > 0 ? weighted / totalWeight : 0;
  }

  /** L0 约束违反惩罚 = 按严重度加权 */
  private computeConstraintPenalty(anchors: readonly SurvivalAnchor[], violations: readonly string[]): number {
    if (anchors.length === 0 || violations.length === 0) return 0;
    let penalty = 0;
    for (const violation of violations) {
      const match = anchors.find(a => violation.includes(a.id) || violation.includes(a.label));
      penalty += (match?.severity ?? 1) / 5;
    }
    return clamp01(penalty / Math.max(1, violations.length)) * 0.4;
  }

  /** L2 风格偏离惩罚 */
  private computeStylePenalty(riskScore: number, style: { riskAppetite: number; timeHorizon: number }): number {
    const targetRisk = 1 - clamp01(style.riskAppetite);
    const riskGap = Math.abs(clamp01(riskScore) - targetRisk);
    const horizonPenalty = (1 - clamp01(style.timeHorizon)) * 0.1;
    return clamp01(riskGap * 0.3 + horizonPenalty);
  }

  private aggregateRollouts(rollouts: readonly SimulationRollout[]): {
    alignmentScore: number; riskScore: number; confidence: number; overallScore: number;
  } {
    if (rollouts.length === 0) {
      return { alignmentScore: 0, riskScore: 0.5, confidence: 0.3, overallScore: 0 };
    }
    const avg = (list: readonly number[]) => list.reduce((s, v) => s + v, 0) / list.length;
    const overallScore = avg(rollouts.map(r => r.overallScore));
    return {
      alignmentScore: avg(rollouts.map(r => r.alignmentScore)),
      riskScore: avg(rollouts.map(r => r.riskScore)),
      confidence: avg(rollouts.map(r => r.confidence)),
      overallScore,
    };
  }

  private async explainAlternative(
    decisionCase: DecisionCase,
    alternative: string,
    rollouts: readonly SimulationRollout[],
    contextMemories: readonly ContextMemory[],
  ): Promise<Explanation> {
    const system = [
      'TASK:EXPLAIN',
      '返回 JSON: {"summary":"...","evidence":[{"source":"memory","content":"...","relevance":0.5}],"counterfactuals":[{"scenario":"...","outcome":"...","probability":0.3}]}',
    ].join('\n');
    const user = [
      `决策标题: ${decisionCase.title}`,
      `备选方案: ${alternative}`,
      `模拟结果: ${JSON.stringify(rollouts.map(r => ({
        outcomes: r.outcomes,
        riskScore: r.riskScore,
        confidence: r.confidence,
        overallScore: r.overallScore,
      })))}`,
      `相关记忆:\n${formatMemories(contextMemories)}`,
    ].join('\n\n');

    try {
      const res = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<{
        summary?: string;
        evidence?: Array<{ source?: string; content?: string; relevance?: number }>;
        counterfactuals?: Array<{ scenario?: string; outcome?: string; probability?: number }>;
      }>(res.content);

      if (parsed?.summary) {
        return {
          summary: parsed.summary,
          evidence: (parsed.evidence ?? [])
            .filter(e => e && typeof e.content === 'string')
            .map(e => ({ source: e.source ?? 'memory', content: e.content ?? '', relevance: clamp01(e.relevance ?? 0.5) })),
          counterfactuals: (parsed.counterfactuals ?? [])
            .filter(c => c && typeof c.scenario === 'string')
            .map(c => ({ scenario: c.scenario ?? '', outcome: c.outcome ?? '', probability: clamp01(c.probability ?? 0.3) })),
        };
      }
    } catch (err) {
      this.logger.warn(LAYER, `解释生成失败: ${alternative}`, err);
    }

    return {
      summary: '该选项在当前人格与记忆上下文中表现相对稳定。',
      evidence: contextMemories.slice(0, 3).map(m => ({ source: 'memory', content: m.content, relevance: clamp01(m.score) })),
      counterfactuals: [],
    };
  }
}
