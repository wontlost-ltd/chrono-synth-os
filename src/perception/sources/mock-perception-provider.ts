/**
 * MockPerceptionProvider — 确定性感官老师（ADR-0051 Phase 1）。
 *
 * 不调任何外部模型：从 PerceptionInput.representation（采集层给的 transcript / 场景描述）
 * 用确定性规则产出一份**结构合法**的 PerceptionAnalysis，使整条「感知→校验→记忆/蒸馏门」
 * 链路可在本地无外部依赖地跑通与测试。真实云/本地多模态 provider 是 Phase 2（走 BYOK）。
 *
 * 它故意只做「把表征切成事实摘要」这件确定性的事——不假装语义理解；语义理解是真实老师的职责。
 * 但它产出的形状与真实老师完全一致，足以验证 distiller 的校验/沉淀/门控逻辑。
 */

import type {
  PerceptionProvider, PerceptionInput, PerceptionAnalyzeOptions, PerceptionAnalysis, PerceivedFact,
} from '../perception-provider.js';

const DEFAULT_MAX_FACTS = 5;

export interface MockPerceptionOptions {
  /** 覆盖默认 confidence（测试用）。 */
  readonly confidence?: number;
  /**
   * 可选：直接指定老师要返回的分析（测试畸形输入 / 身份提案路径用）。
   * 给定时忽略 representation 推导，原样返回——用于驱动 distiller 各分支。
   */
  readonly scriptedAnalysis?: PerceptionAnalysis;
}

export class MockPerceptionProvider implements PerceptionProvider {
  readonly name = 'mock-perception';

  constructor(private readonly opts: MockPerceptionOptions = {}) {}

  async analyze(input: PerceptionInput, options?: PerceptionAnalyzeOptions): Promise<PerceptionAnalysis> {
    if (this.opts.scriptedAnalysis) return this.opts.scriptedAnalysis;

    const maxFacts = options?.maxFacts ?? DEFAULT_MAX_FACTS;
    /* 确定性切分：按句子边界切表征，每句成一个事实摘要（episodic）。 */
    const sentences = input.representation
      .split(/[。.!?！？\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, maxFacts);

    const facts: PerceivedFact[] = sentences.map((sentence, i) => ({
      summary: `${input.modality === 'audio' ? '我听到' : '我看到'}：${sentence}`,
      memoryKind: 'episodic',
      /* 确定性 valence：含负向词则偏负，否则中性（仅占位，真实老师会做情感分析）。 */
      valence: /累|难|压力|焦虑|sad|tired|stress/i.test(sentence) ? -0.3 : 0,
      salience: clamp01(0.5 + (sentences.length - i) * 0.05),
    }));

    return {
      facts,
      confidence: this.opts.confidence ?? 0.7,
    };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
