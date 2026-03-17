/**
 * 集成提案类型 — 纯领域类型
 * 将快层实验结果合并到慢层的提案定义
 * 零 node:* 依赖
 */

/** 集成提案：将快层实验结果合并到慢层 */
export interface IntegrationProposal {
  readonly id: string;
  readonly sourceVersionId: string;
  /** 建议的价值权重调整 */
  readonly valueChanges: ReadonlyMap<string, number>;
  /** 建议的叙事更新 */
  readonly narrativeUpdate?: string;
  /** 集成置信度 0-1 */
  readonly confidence: number;
  readonly proposedAt: number;
  accepted?: boolean;
  decidedAt?: number;
}
