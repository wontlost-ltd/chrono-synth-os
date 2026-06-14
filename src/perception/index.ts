/**
 * 外部感知层（ADR-0051）— 多模态内容理解作为「感官老师」，不进运行时决策。
 *
 * 已实现：Phase 1 感官老师契约 + 确定性 mock provider + 感知蒸馏器（事实→记忆 + 身份提案→蒸馏门）；
 * ADR-0052 Edge-P1 确定性环境旁路（environment/，光/声/运动→状态→记忆）。
 *
 * 注：media/（Edge-P5 媒体引用 + GDPR）是 privacy/retention 基础设施，由 privacy-service / retention
 * worker 直接 import，**不经本 barrel 导出**（非感知能力出口，是存储侧引用元数据管理）。
 * 未实现（登记债）：Phase 2 BYOK perception provider + 配额；perception_events 落库 + 独立 'perception'
 * artifact source；实时流；感知节律集成（环境状态影响打扰阈值等）。
 */

export type {
  PerceptionModality, PerceptionInput, PerceivedFact, PerceivedIdentityHint,
  PerceptionAnalysis, PerceptionAnalyzeOptions, PerceptionProvider,
} from './perception-provider.js';
export { MockPerceptionProvider, type MockPerceptionOptions } from './sources/mock-perception-provider.js';
export { LlmPerceptionProvider } from './sources/llm-perception-provider.js';
export {
  PerceptionDistiller, type PerceptionDistillInput, type PerceptionDistillResult,
} from './perception-distiller.js';

/* 确定性环境感知旁路（ADR-0052 Edge-P1）。 */
export * from './environment/index.js';
