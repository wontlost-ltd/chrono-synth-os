/**
 * 战略辅助层（M7）——CEO persona 把**人类给定的战略输入**确定性地展开成排序后的战略备选，供**人类批准**。
 * 零-LLM、确定性。**绝不是自动 CEO**。
 *
 * 蓝图诚实分层：CEO 级战略判断本质需推理，零-LLM 运行时**做不了**（ADR-0047）。M7 不假装做战略推理，
 * 它做三件可确定性化的事：
 *   1. **展开**：把人类给的战略目标 + 候选举措（每个映射到已知 goalType）按**人类声明的** priority/impact/
 *      feasibility 加权打分（service 只做确定性算术，不臆造数值）；
 *   2. **多视角备选**：用不同确定性排序透镜（impact-first / risk-averse / quick-wins）产出 2-3 个战略备选——
 *      这是同一组举措的**确定性重排**，不是 LLM 生成的新战略；
 *   3. **硬门控人类批准**：每个备选都是 proposal，`requiresHumanApproval` 恒 true；service **绝不**自动提交/
 *      执行战略；超出风险容忍度的举措标记 needsEscalation。
 *
 * 红线：智能来源是**人类战略输入**（ADR-0047 第 1 层）+ 确定性规则展开（第 3 层），**不调 LLM 做战略决策**。
 * 相同输入 → 相同备选（可复现、可审计、可对照）。
 *
 * 输入校验契约（Codex 复审）：本 service 信任并**原样**使用人类声明的 priority/impact/feasibility 等数值
 * （不 silent clamp——clamp 会悄悄改写人类声明值，降低审计诚实性）。未来接 HTTP 入口时，非法数值应在
 * **入口层**用 RangeError 显式拒绝，而非在此静默纠正。
 */

import type { RiskLevel } from './types.js';

/** 风险序。 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** 一个候选战略举措（人类给定）。 */
export interface StrategicInitiative {
  readonly id: string;
  readonly title: string;
  /** 该举措落地走哪个已知 goalType（确定性可执行）。 */
  readonly goalType: string;
  /** 人类声明的优先级（1-5，越高越重要）。 */
  readonly priority: number;
  /** 人类声明的预期影响（1-5）。 */
  readonly impact: number;
  /** 人类声明的可行性（1-5，越高越易实现）。 */
  readonly feasibility: number;
  /** 该举措的风险等级（人类/playbook 评估）。 */
  readonly riskLevel: RiskLevel;
  /** 估算成本（预算单位，人类给定）。 */
  readonly estimatedCost: number;
}

/** 战略输入（人类给定的约束与目标）。 */
export interface StrategyInput {
  /** 战略目标陈述（人类给定，service 不解读语义，仅透传）。 */
  readonly objective: string;
  /** 预算上限（总成本不得超）。 */
  readonly budgetCap: number;
  /** 风险容忍上限（超过此风险的举措标 needsEscalation）。 */
  readonly riskTolerance: RiskLevel;
  /** 候选举措集合。 */
  readonly initiatives: readonly StrategicInitiative[];
}

/** 排序透镜（确定性重排视角）。 */
export type StrategyLens = 'impact_first' | 'risk_averse' | 'quick_wins';

/** 备选里的一条已排序举措 + 确定性标注。 */
export interface RankedInitiative {
  readonly initiative: StrategicInitiative;
  /** 该透镜下的确定性得分（可解释）。 */
  readonly score: number;
  /** 是否纳入本备选（预算内）。 */
  readonly included: boolean;
  /** 是否超风险容忍 → 需人类升级评审（即便纳入也要单独批）。 */
  readonly needsEscalation: boolean;
}

/** 一个战略备选（某透镜下的方案）。 */
export interface StrategyAlternative {
  readonly lens: StrategyLens;
  readonly rationale: string;
  readonly rankedInitiatives: readonly RankedInitiative[];
  /** 纳入举措的总成本（预算内）。 */
  readonly totalCost: number;
  /** 纳入举措数。 */
  readonly includedCount: number;
  /** 含需升级（超风险）举措数。 */
  readonly escalationCount: number;
}

/** 战略建议结果。**恒需人类批准**——这不是可自动执行的决定。 */
export interface StrategyAdvisory {
  readonly objective: string;
  readonly alternatives: readonly StrategyAlternative[];
  /** 铁律：M7 只建议不决策，所有备选都必须人类批准后才可能转成可执行目标。 */
  readonly requiresHumanApproval: true;
}

/** 三个确定性透镜的评分权重（声明式，可审计；非 LLM）。 */
const LENS_WEIGHTS: Record<StrategyLens, { priority: number; impact: number; feasibility: number; riskPenalty: number }> = {
  /* 影响优先：重影响与优先级。 */
  impact_first: { priority: 2, impact: 3, feasibility: 1, riskPenalty: 1 },
  /* 风险规避：重可行性，重罚风险。 */
  risk_averse: { priority: 1, impact: 1, feasibility: 2, riskPenalty: 3 },
  /* 速赢优先：重可行性与影响（低风险易落地先做）。 */
  quick_wins: { priority: 1, impact: 2, feasibility: 3, riskPenalty: 2 },
};

export class StrategyAdvisoryService {
  /**
   * 把人类战略输入展开成多视角战略备选（确定性）。**不决策、不执行**——返回的备选恒需人类批准。
   * 相同输入 → 相同备选。
   */
  advise(input: StrategyInput): StrategyAdvisory {
    const lenses: StrategyLens[] = ['impact_first', 'risk_averse', 'quick_wins'];
    const alternatives = lenses.map((lens) => this.buildAlternative(lens, input));
    return { objective: input.objective, alternatives, requiresHumanApproval: true };
  }

  /** 某透镜下确定性建一个备选：打分 → 排序 → 预算内贪心纳入 → 标超风险。 */
  private buildAlternative(lens: StrategyLens, input: StrategyInput): StrategyAlternative {
    const w = LENS_WEIGHTS[lens];
    const tolerance = RISK_ORDER[input.riskTolerance];

    /* 确定性打分 + 排序（得分降序，并列按 initiative.id 字典序兜底——稳定可复现）。 */
    const scored = input.initiatives
      .map((initiative) => ({
        initiative,
        score: this.score(initiative, w),
        needsEscalation: RISK_ORDER[initiative.riskLevel] > tolerance,
      }))
      .sort((a, b) => b.score - a.score || (a.initiative.id < b.initiative.id ? -1 : a.initiative.id > b.initiative.id ? 1 : 0));

    /* 预算内贪心纳入（按排序顺序累加成本，超预算则不纳入但保留在列表标 included=false）。 */
    let spent = 0;
    const rankedInitiatives: RankedInitiative[] = scored.map((s) => {
      const fits = spent + s.initiative.estimatedCost <= input.budgetCap;
      if (fits) spent += s.initiative.estimatedCost;
      return { initiative: s.initiative, score: s.score, included: fits, needsEscalation: s.needsEscalation };
    });

    const included = rankedInitiatives.filter((r) => r.included);
    return {
      lens,
      rationale: this.lensRationale(lens),
      rankedInitiatives,
      totalCost: spent,
      includedCount: included.length,
      escalationCount: included.filter((r) => r.needsEscalation).length,
    };
  }

  /** 确定性加权打分（人类给定的 priority/impact/feasibility，service 只算术 + 确定性风险罚分）。 */
  private score(i: StrategicInitiative, w: { priority: number; impact: number; feasibility: number; riskPenalty: number }): number {
    const base = i.priority * w.priority + i.impact * w.impact + i.feasibility * w.feasibility;
    const penalty = RISK_ORDER[i.riskLevel] * w.riskPenalty;
    return base - penalty;
  }

  private lensRationale(lens: StrategyLens): string {
    switch (lens) {
      case 'impact_first': return '影响优先：重预期影响与优先级，适合追求最大产出';
      case 'risk_averse': return '风险规避：重可行性、重罚风险，适合稳健推进';
      case 'quick_wins': return '速赢优先：重可行性与影响，低风险易落地先做';
    }
  }
}
