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
import { clamp01 } from '../utils/math.js';
import type { CognitiveModel, DecisionStyle, SurvivalAnchor } from '../types/personality-os.js';
import type { CoreValue } from '../types/core-self.js';
import type { LLMProvider } from './llm-provider.js';
import type { ContextMemory, RetrievalService } from './retrieval-service.js';
import { computeStructuralScore } from './structural-scorer.js';
import type { ScoreBreakdown } from './structural-scorer.js';
import { compilePersonaState, summarizeForPrompt } from './persona-state.js';
import type { RuleEngine } from './rule-engine.js';
import {
  DEFAULT_ALTERNATIVES,
  type DecisionCase, type DecisionResult, type Explanation, type RankedOption,
  type SimulationConfig, type SimulationRollout,
} from './types.js';

export interface DecisionProgress {
  readonly progress: number;
  readonly stage: string;
}

export interface DecisionEngineOptions {
  readonly onProgress?: (progress: DecisionProgress) => void;
}

const LAYER = 'DecisionEngine';

/** 记忆检索数量 */
const CONTEXT_MEMORY_COUNT = 5;
/** 最低备选方案数量 */
const MIN_ALTERNATIVES = 2;
/** 结构化评分缺失时的默认风险值 */
const DEFAULT_RISK_SCORE = 0.5;
/** 结构化评分缺失时的默认置信度 */
const DEFAULT_CONFIDENCE = 0.5;
/** 无 rollout 数据时的降级置信度 */
const EMPTY_ROLLOUT_CONFIDENCE = 0.3;

function safeParseJson<T>(content: string): T | undefined {
  try {
    return JSON.parse(content) as T;
  } catch {
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
    private readonly ruleEngine?: RuleEngine,
  ) {}

  async evaluate(decisionCase: DecisionCase, options?: DecisionEngineOptions): Promise<DecisionResult> {
    try {
      return await this.evaluateWithLLM(decisionCase, options);
    } catch (err) {
      if (this.ruleEngine?.allowsFallback()) {
        this.logger.warn(LAYER, 'LLM 不可用，回退到规则引擎', err);
        const state = compilePersonaState(this.core);
        return this.ruleEngine.evaluate(decisionCase, state);
      }
      throw err;
    }
  }

  private async evaluateWithLLM(decisionCase: DecisionCase, options?: DecisionEngineOptions): Promise<DecisionResult> {
    this.logger.info(LAYER, `开始决策模拟: ${decisionCase.id}`);
    const state = compilePersonaState(this.core);
    const personaSummary = summarizeForPrompt(state);
    const query = `${decisionCase.title}\n${decisionCase.description}`;

    let queryEmbedding: number[] = [];
    try {
      const embeddings = await this.llm.embed([query]);
      queryEmbedding = embeddings[0] ?? [];
    } catch (err) {
      this.logger.warn(LAYER, '查询向量获取失败，退化为图检索', err);
    }

    const contextMemories = this.retrieval.getContext(query, queryEmbedding, CONTEXT_MEMORY_COUNT);
    options?.onProgress?.({ progress: 0.1, stage: 'context' });

    const alternatives = await this.getAlternatives(decisionCase, personaSummary, contextMemories);
    const limited = alternatives.slice(0, Math.max(MIN_ALTERNATIVES, this.config.maxOptions));
    options?.onProgress?.({ progress: 0.2, stage: 'alternatives' });

    const valueWeights = new Map<string, number>();
    for (const value of state.L1.values()) {
      valueWeights.set(value.id, value.weight);
      valueWeights.set(value.label, value.weight);
    }
    const timeHorizonMonths = this.extractTimeHorizonMonths(decisionCase.context);

    const ranked: Array<{ option: RankedOption; score: number }> = [];
    for (let i = 0; i < limited.length; i++) {
      const alternative = limited[i];
      const rollouts = await this.runRollouts(
        decisionCase, alternative, personaSummary, contextMemories,
        valueWeights, state.L1, state.L0, state.L2, state.L3, timeHorizonMonths,
      );

      const aggregate = this.aggregateRollouts(rollouts);
      const explanation = await this.explainAlternative(decisionCase, alternative, rollouts, contextMemories);

      const regretProbability = Math.max(0, Math.min(1, state.L2.regretSensitivity * (1 - aggregate.overallScore)));
      ranked.push({
        option: {
          alternative,
          rank: 0,
          alignmentScore: aggregate.alignmentScore,
          riskScore: aggregate.riskScore,
          confidence: aggregate.confidence,
          overallScore: aggregate.overallScore,
          regretProbability,
          explanation,
          scoreBreakdown: aggregate.scoreBreakdown,
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

    return [...DEFAULT_ALTERNATIVES];
  }

  private async runRollouts(
    decisionCase: DecisionCase,
    alternative: string,
    personaSummary: string,
    contextMemories: readonly ContextMemory[],
    valueWeights: ReadonlyMap<string, number>,
    values: ReadonlyMap<string, CoreValue>,
    anchors: readonly SurvivalAnchor[],
    decisionStyle: DecisionStyle,
    cognitiveModel: CognitiveModel,
    timeHorizonMonths?: number,
  ): Promise<SimulationRollout[]> {
    const total = Math.max(1, this.config.rollouts);
    const rollouts: SimulationRollout[] = [];
    for (let i = 0; i < total; i++) {
      rollouts.push(await this.simulateAlternative(
        decisionCase, alternative, personaSummary, contextMemories,
        valueWeights, values, anchors, decisionStyle, cognitiveModel, timeHorizonMonths,
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
    values: ReadonlyMap<string, CoreValue>,
    anchors: readonly SurvivalAnchor[],
    decisionStyle: DecisionStyle,
    cognitiveModel: CognitiveModel,
    timeHorizonMonths?: number,
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
    let riskScore = DEFAULT_RISK_SCORE;
    let confidence = DEFAULT_CONFIDENCE;

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

    const structural = computeStructuralScore({
      valueWeights,
      values,
      scenarioRelevance: valueAlignment,
      anchors,
      violations: constraintViolations,
      riskScore,
      decisionStyle,
      cognitiveModel,
      timeHorizonMonths,
    });

    return {
      alternative,
      outcomes,
      valueAlignment,
      constraintViolations,
      alignmentScore: structural.alignmentScore,
      riskScore,
      confidence,
      overallScore: structural.overallScore,
      scoreBreakdown: structural.breakdown,
    };
  }

  private aggregateRollouts(rollouts: readonly SimulationRollout[]): {
    alignmentScore: number; riskScore: number; confidence: number; overallScore: number; scoreBreakdown?: ScoreBreakdown;
  } {
    if (rollouts.length === 0) {
      return { alignmentScore: 0, riskScore: DEFAULT_RISK_SCORE, confidence: EMPTY_ROLLOUT_CONFIDENCE, overallScore: 0 };
    }
    const avg = (list: readonly number[]) => list.reduce((s, v) => s + v, 0) / list.length;
    const overallScore = avg(rollouts.map(r => r.overallScore));
    const scoreBreakdown = this.aggregateScoreBreakdown(rollouts);
    return {
      alignmentScore: avg(rollouts.map(r => r.alignmentScore)),
      riskScore: avg(rollouts.map(r => r.riskScore)),
      confidence: avg(rollouts.map(r => r.confidence)),
      overallScore,
      scoreBreakdown,
    };
  }

  private aggregateScoreBreakdown(rollouts: readonly SimulationRollout[]): ScoreBreakdown | undefined {
    let count = 0;
    const valueTotals: Record<string, number> = {};
    const biasTotals: Record<string, number> = {};
    const anchorSet = new Set<string>();
    let timeTotal = 0;
    let biasTotal = 0;

    for (const rollout of rollouts) {
      const breakdown = rollout.scoreBreakdown;
      if (!breakdown) continue;
      count += 1;
      for (const [key, value] of Object.entries(breakdown.valueContributions)) {
        valueTotals[key] = (valueTotals[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(breakdown.biasAdjustments)) {
        biasTotals[key] = (biasTotals[key] ?? 0) + value;
      }
      for (const violation of breakdown.anchorViolations) {
        anchorSet.add(violation);
      }
      timeTotal += breakdown.timeHorizonEffect;
      biasTotal += breakdown.cognitiveBiasTotal;
    }

    if (count === 0) return undefined;

    for (const key of Object.keys(valueTotals)) {
      valueTotals[key] /= count;
    }
    for (const key of Object.keys(biasTotals)) {
      biasTotals[key] /= count;
    }

    return {
      valueContributions: valueTotals,
      anchorViolations: [...anchorSet],
      biasAdjustments: biasTotals,
      timeHorizonEffect: timeTotal / count,
      cognitiveBiasTotal: biasTotal / count,
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

  private extractTimeHorizonMonths(context?: Record<string, unknown>): number | undefined {
    if (!context) return undefined;
    const raw = context.timeHorizonMonths;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
}
