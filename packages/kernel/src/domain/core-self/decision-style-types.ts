/** L2 决策风格领域类型 */
export interface DecisionStyle {
  readonly riskAppetite: number;
  readonly timeHorizon: number;
  readonly explorationBias: number;
  readonly lossAversion: number;
  readonly deliberationDepth: number;
  readonly regretSensitivity: number;
  readonly updatedAt: number;
}

export interface DecisionStyleDefaults {
  readonly riskAppetite: number;
  readonly timeHorizon: number;
  readonly explorationBias: number;
  readonly lossAversion: number;
  readonly deliberationDepth: number;
  readonly regretSensitivity: number;
}

export const DEFAULT_DECISION_STYLE: DecisionStyleDefaults = {
  riskAppetite: 0.5,
  timeHorizon: 0.5,
  explorationBias: 0.3,
  lossAversion: 2.0,
  deliberationDepth: 3,
  regretSensitivity: 0.5,
};
