// src/collaboration/collaboration-mode.ts
/** 可插拔协同模式策略接口。首实现 MultiPerspectiveAggregation（多视角汇聚）；
 * 后续「角色分工 / 辩论共识」各加 implements，编排壳（CollaborativeAnalysisService）不变。 */
export type { CollaborationMode } from './collaboration-types.js';
