/**
 * 决策引擎 — 薄适配器
 * 编排 LLM 调用与检索，纯计算逻辑委托 kernel
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
import { compilePersonaState, summarizeForPrompt } from './persona-state.js';
import type { RuleEngine } from './rule-engine.js';
import {
  DEFAULT_ALTERNATIVES,
  type DecisionCase, type DecisionResult, type Explanation, type RankedOption,
  type SimulationConfig, type SimulationRollout,
} from './types.js';
import {
  safeParseJson,
  formatMemories,
  aggregateRollouts,
  CONTEXT_MEMORY_COUNT,
  MIN_ALTERNATIVES,
  DEFAULT_RISK_SCORE,
  DEFAULT_CONFIDENCE,
  type DecisionProgress,
} from '@chrono/kernel';

export type { DecisionProgress };

/**
 * 推理模式（ADR-0047）。
 * - autonomous：确定性内核为主路径，完全不调用 LLM，离线可用。
 * - growth：LLM 增强（生成备选、模拟、解释），失败时回退规则引擎。
 *
 * 默认 growth，保持既有调用方行为不变。
 */
export type ReasoningMode = 'autonomous' | 'growth';

export interface DecisionEngineOptions {
  readonly onProgress?: (progress: DecisionProgress) => void;
  /** 推理模式，缺省 'growth'（向后兼容） */
  readonly mode?: ReasoningMode;
}

/**
 * 自主决策的**窄接口**（ADR-0047 F8）：只暴露确定性 evaluateAutonomous，不暴露可能触发 LLM 的 growth 路径。
 * 自主运营调用方（earning 等）应依赖本接口而非完整 DecisionEngine——从类型上杜绝「漏传 mode → 静默调 LLM」。
 * DecisionEngine 实现本接口（结构兼容），无需改造构造。
 */
export interface AutonomousDecisionEngine {
  evaluateAutonomous(decisionCase: DecisionCase, options?: DecisionEngineOptions): DecisionResult;
}

const LAYER = 'DecisionEngine';

export class DecisionEngine {
  /**
   * @param llm LLM 提供方。ADR-0047 D1：autonomous-only runtime 可传 undefined
   *   实现"无 LLM 构造"；此时仅 autonomous 模式可用，growth 模式会抛清晰错误。
   *   growth 模式（默认）必须注入 llm。
   */
  constructor(
    private readonly core: CoreRhythmLayer,
    private readonly retrieval: RetrievalService,
    private readonly llm: LLMProvider | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly config: SimulationConfig,
    private readonly ruleEngine?: RuleEngine,
  ) {}

  /** growth 路径取 LLM；未注入时抛清晰错误（autonomous-only 构造的预期失败） */
  private requireLlm(): LLMProvider {
    if (!this.llm) {
      throw new Error('growth 模式需要 LLMProvider，但未注入（autonomous-only 构造）。请用 mode:"autonomous" 或注入 llm');
    }
    return this.llm;
  }

  async evaluate(decisionCase: DecisionCase, options?: DecisionEngineOptions): Promise<DecisionResult> {
    /* ADR-0047：autonomous 模式下确定性内核是一等主路径，不触碰 LLM。 */
    if (options?.mode === 'autonomous') {
      return this.evaluateAutonomousImpl(decisionCase, options);
    }

    /* growth 模式：LLM 增强，失败回退规则引擎（保留既有韧性）。 */
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

  /**
   * 自主模式评估（ADR-0047）：纯确定性规则引擎，零 LLM 调用。**公开**给自主路径（earning/自主运营）直接调用——
   * 无 mode 参数，故**不可能**因漏传 mode 而退回 growth(LLM) 路径（全维评审 F8 footgun：evaluate() 默认 growth，
   * 若自主调用方漏传 {mode:'autonomous'} 会静默调 LLM 破坏零-LLM 论点）。自主调用方应依赖窄接口
   * AutonomousDecisionEngine 并调本方法，把「不调 LLM」变成类型层面的保证而非调用纪律。
   */
  evaluateAutonomous(decisionCase: DecisionCase, options?: DecisionEngineOptions): DecisionResult {
    return this.evaluateAutonomousImpl(decisionCase, options);
  }

  private evaluateAutonomousImpl(decisionCase: DecisionCase, options?: DecisionEngineOptions): DecisionResult {
    if (!this.ruleEngine) {
      throw new Error('autonomous 模式需要 RuleEngine，但未注入');
    }
    options?.onProgress?.({ progress: 0.1, stage: 'autonomous' });
    const state = compilePersonaState(this.core);
    const result = this.ruleEngine.evaluate(decisionCase, state);
    options?.onProgress?.({ progress: 1, stage: 'autonomous:done' });
    this.logger.info(LAYER, `自主模式决策完成（无 LLM）: ${decisionCase.id} → 「${result.recommendedAlternative}」`);
    return result;
  }

  private async evaluateWithLLM(decisionCase: DecisionCase, options?: DecisionEngineOptions): Promise<DecisionResult> {
    this.logger.info(LAYER, `开始决策模拟: ${decisionCase.id}`);
    const state = compilePersonaState(this.core);
    const personaSummary = summarizeForPrompt(state);
    const query = `${decisionCase.title}\n${decisionCase.description}`;

    let queryEmbedding: number[] = [];
    try {
      const embeddings = await this.requireLlm().embed([query]);
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

      const aggregate = aggregateRollouts(rollouts);
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
      const res = await this.requireLlm().chat(
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
      const res = await this.requireLlm().chat(
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
      const res = await this.requireLlm().chat(
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
