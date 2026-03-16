/** L3 认知模型领域类型 */
export interface CognitiveModel {
  readonly beliefs: ReadonlyMap<string, number>;
  readonly biasWeights: ReadonlyMap<string, number>;
  readonly attributionStyle: number;
  readonly growthMindset: number;
  readonly updatedAt: number;
}
