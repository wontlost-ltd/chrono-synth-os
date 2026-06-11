/**
 * 规则引擎（离线决策能力） — 薄适配器，委托 kernel 纯函数
 */

import type { DecisionCase, DecisionResult } from './types.js';
import type { PersonaOSState } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import {
  evaluateDecisionCase,
  DEFAULT_RULE_ENGINE_CONFIG,
  type RuleEngineConfig,
  type RuleEnginePersonaState,
  type RulePayload,
} from '@chrono/kernel';

export type { RuleEngineConfig };

const LAYER = 'RuleEngine';

function toRulePersona(state: PersonaOSState): RuleEnginePersonaState {
  const withRules = state as PersonaOSState & { readonly rules?: readonly RulePayload[] };
  return { L0: state.L0, L1: state.L1, L2: state.L2, L3: state.L3, rules: withRules.rules };
}

export class RuleEngine {
  private readonly config: RuleEngineConfig;

  constructor(
    private readonly clock: Clock,
    config?: Partial<RuleEngineConfig>,
    private readonly logger?: Logger,
  ) {
    this.config = { ...DEFAULT_RULE_ENGINE_CONFIG, ...config };
  }

  /** 是否允许作为 LLM 的回退方案 */
  allowsFallback(): boolean {
    return this.config.fallbackStrategy === 'rule_only';
  }

  evaluate(decisionCase: DecisionCase, personaState: PersonaOSState): DecisionResult {
    if (!this.config.enabled) {
      throw new Error('Rule engine disabled');
    }

    const result = evaluateDecisionCase(
      decisionCase,
      toRulePersona(personaState),
      this.clock.now(),
    );

    this.logger?.info(LAYER, `评估完成: ${decisionCase.id} → 推荐「${result.recommendedAlternative}」 (分数=${result.rankedOptions[0]?.overallScore.toFixed(3) ?? 'N/A'})`);
    return result;
  }
}
