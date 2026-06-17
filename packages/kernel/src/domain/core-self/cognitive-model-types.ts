/** L3 认知模型领域类型 */
export interface CognitiveModel {
  readonly beliefs: ReadonlyMap<string, number>;
  readonly biasWeights: ReadonlyMap<string, number>;
  readonly attributionStyle: number;
  readonly growthMindset: number;
  /**
   * 模糊/不确定容忍度（0-1，④ L3 扩展）：高 → 对不确定/高风险选项更从容（信息不足时仍敢决策）；
   * 低 → 回避不确定。接入 structural-scorer：调节高 risk 选项的偏好。默认 0.5（中性）。
   */
  readonly ambiguityTolerance: number;
  /**
   * 直觉↔分析（0-1，④ L3 扩展，双系统认知）：0=直觉型（更受认知偏差/直觉左右），1=分析型
   * （更理性，阻尼偏差调整）。接入 structural-scorer：越分析，cognitive bias 调整被越阻尼。默认 0.5。
   */
  readonly analyticalIntuitive: number;
  readonly updatedAt: number;
}
