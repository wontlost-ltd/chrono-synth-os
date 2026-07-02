/**
 * 外部感知层（ADR-0051）— 多模态内容理解作为「感官老师」，不进运行时决策。
 *
 * 已实现：Phase 1 感官老师契约 + 确定性 mock provider + 感知蒸馏器（事实→记忆 + 身份提案→蒸馏门）；
 * ADR-0052 Edge-P1 确定性环境旁路（environment/，光/声/运动→状态→记忆）。
 *
 * 注：media/（Edge-P5 媒体引用 + GDPR）是 privacy/retention 基础设施，由 privacy-service / retention
 * worker 直接 import，**不经本 barrel 导出**（非感知能力出口，是存储侧引用元数据管理）。
 * 真 LLM 感官老师已实现（LlmPerceptionProvider，按租户 BYOK 选用）；感知配额计量（#113）、
 * perception_events 审计落库（#114，含 failed-status 区分老师失败）、独立 'perception' artifact source（v088）、
 * 实时流式感知（perceive-stream.ts，分片/WS）、确定性环境旁路→节律集成（environment/）均已落地
 * （ADR-0051 Phase 1-5 全部交付；原「未实现登记债」注释已滞后，全维评审 G7 校正）。
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
