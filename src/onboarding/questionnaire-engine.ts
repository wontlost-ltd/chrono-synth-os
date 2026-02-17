/**
 * 自适应问卷引擎
 * 通过结构化问题推断 L0/L2/L3 参数
 */

/** 问题定义 */
export interface Question {
  readonly id: string;
  readonly text: string;
  readonly dimension: 'riskAppetite' | 'timeHorizon' | 'lossAversion' | 'explorationBias'
    | 'deliberationDepth' | 'regretSensitivity' | 'attributionStyle' | 'growthMindset';
  /** 分数映射方向：true 表示高分 → 高值 */
  readonly positive: boolean;
}

/** 用户答案 */
export interface QuestionResponse {
  readonly id: string;
  /** 1-5 分 */
  readonly score: number;
}

/** 推断结果 */
export interface InferredParameters {
  readonly decisionStyle: Partial<{
    riskAppetite: number;
    timeHorizon: number;
    lossAversion: number;
    explorationBias: number;
    deliberationDepth: number;
    regretSensitivity: number;
  }>;
  readonly cognitiveModel: Partial<{
    attributionStyle: number;
    growthMindset: number;
  }>;
}

/** 预定义问题库 */
const QUESTIONS: readonly Question[] = [
  { id: 'q_risk_1', text: '面对高回报但不确定的机会，你倾向于行动', dimension: 'riskAppetite', positive: true },
  { id: 'q_risk_2', text: '你更愿意选择稳定但回报较低的方案', dimension: 'riskAppetite', positive: false },
  { id: 'q_time_1', text: '你愿意牺牲眼前利益换取长期成果', dimension: 'timeHorizon', positive: true },
  { id: 'q_time_2', text: '你更看重即时的确定性回报', dimension: 'timeHorizon', positive: false },
  { id: 'q_loss_1', text: '失去已有的东西比获得新东西更让你痛苦', dimension: 'lossAversion', positive: true },
  { id: 'q_explore_1', text: '你喜欢尝试全新的方法而非沿用熟悉的', dimension: 'explorationBias', positive: true },
  { id: 'q_delib_1', text: '做重要决策前你会花大量时间收集信息', dimension: 'deliberationDepth', positive: true },
  { id: 'q_regret_1', text: '做了错误决策后你会长时间感到后悔', dimension: 'regretSensitivity', positive: true },
  { id: 'q_attr_1', text: '成功主要归因于自己的努力而非环境', dimension: 'attributionStyle', positive: false },
  { id: 'q_growth_1', text: '你相信能力可以通过努力持续提升', dimension: 'growthMindset', positive: true },
];

export class QuestionnaireEngine {
  /** 获取所有可用问题 */
  getQuestions(): readonly Question[] {
    return QUESTIONS;
  }

  /** 评估用户答案，推断 L2/L3 参数 */
  evaluate(responses: readonly QuestionResponse[]): InferredParameters {
    const responseMap = new Map(responses.map(r => [r.id, r.score]));

    const dimensionScores = new Map<string, { total: number; count: number }>();

    for (const q of QUESTIONS) {
      const score = responseMap.get(q.id);
      if (score === undefined) continue;

      /* 归一化到 0-1 范围 */
      const normalized = q.positive ? (score - 1) / 4 : (5 - score) / 4;

      const existing = dimensionScores.get(q.dimension);
      if (existing) {
        existing.total += normalized;
        existing.count += 1;
      } else {
        dimensionScores.set(q.dimension, { total: normalized, count: 1 });
      }
    }

    const get = (dim: string): number | undefined => {
      const entry = dimensionScores.get(dim);
      return entry ? entry.total / entry.count : undefined;
    };

    const decisionStyle: Record<string, number> = {};
    const cognitiveModel: Record<string, number> = {};

    const dims: Array<[string, 'decision' | 'cognitive', string]> = [
      ['riskAppetite', 'decision', 'riskAppetite'],
      ['timeHorizon', 'decision', 'timeHorizon'],
      ['lossAversion', 'decision', 'lossAversion'],
      ['explorationBias', 'decision', 'explorationBias'],
      ['deliberationDepth', 'decision', 'deliberationDepth'],
      ['regretSensitivity', 'decision', 'regretSensitivity'],
      ['attributionStyle', 'cognitive', 'attributionStyle'],
      ['growthMindset', 'cognitive', 'growthMindset'],
    ];

    for (const [dim, target, key] of dims) {
      const value = get(dim);
      if (value === undefined) continue;
      if (target === 'decision') {
        /* deliberationDepth 需要映射到 1-5 范围 */
        if (key === 'deliberationDepth') {
          decisionStyle[key] = Math.round(1 + value * 4);
        } else if (key === 'lossAversion') {
          /* lossAversion 范围 1-3 */
          decisionStyle[key] = 1 + value * 2;
        } else {
          decisionStyle[key] = value;
        }
      } else {
        cognitiveModel[key] = value;
      }
    }

    return { decisionStyle, cognitiveModel };
  }
}
