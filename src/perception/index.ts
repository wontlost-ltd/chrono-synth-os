/**
 * 外部感知层（ADR-0051）— 多模态内容理解作为「感官老师」，不进运行时决策。
 *
 * Phase 1（本阶段）：感官老师契约 + 确定性 mock provider + 感知蒸馏器（事实→记忆 + 身份提案→蒸馏门）。
 * 后续：Phase 2 BYOK perception provider + 配额；Phase 3 perception_events 落库 + GDPR + 对象存储；
 * Phase 4 确定性环境旁路（光/波）；Phase 5 实时流。
 */

export type {
  PerceptionModality, PerceptionInput, PerceivedFact, PerceivedIdentityHint,
  PerceptionAnalysis, PerceptionAnalyzeOptions, PerceptionProvider,
} from './perception-provider.js';
export { MockPerceptionProvider, type MockPerceptionOptions } from './sources/mock-perception-provider.js';
export {
  PerceptionDistiller, type PerceptionDistillInput, type PerceptionDistillResult,
} from './perception-distiller.js';
