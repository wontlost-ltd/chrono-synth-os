/**
 * 自定义业务指标
 * 通过 OpenTelemetry Metrics API 暴露关键业务数据
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('chrono-synth-os');

/** HTTP 请求总数 */
export const requestsTotal = meter.createCounter('chrono_requests_total', {
  description: 'HTTP 请求总数',
});

/** 模拟执行持续时间 */
export const simulationDuration = meter.createHistogram('chrono_simulation_duration_seconds', {
  description: '模拟执行耗时（秒）',
  unit: 's',
});

/** LLM token 消耗量 */
export const llmTokensUsed = meter.createCounter('chrono_llm_tokens_used', {
  description: 'LLM token 消耗总量',
});

/** HTTP 请求时延（秒）— histogram with default buckets for p95/p99 SLO */
export const requestDurationSeconds = meter.createHistogram('chrono_request_duration_seconds', {
  description: 'HTTP 请求时延（秒），用于 SLO 计算',
  unit: 's',
});

/** 工具调用结果计数（labels: tool_id, outcome） */
export const toolInvocationOutcomeTotal = meter.createCounter('chrono_tool_invocation_outcome_total', {
  description: 'tool_invocations 终态计数（success / failed / denied_* / timeout / pending_confirmation）',
});

/** 活跃订阅数 */
export const activeSubscriptions = meter.createUpDownCounter('chrono_active_subscriptions', {
  description: '当前活跃订阅数',
});

/** WebSocket 活跃连接数 */
export const wsActiveConnections = meter.createUpDownCounter('chrono_ws_active_connections', {
  description: 'WebSocket 活跃连接数',
});

/** 缓存命中率 */
export const cacheHits = meter.createCounter('chrono_cache_hits_total', {
  description: '缓存命中次数',
});

export const cacheMisses = meter.createCounter('chrono_cache_misses_total', {
  description: '缓存未命中次数',
});

/* ─────────────── P1-C 对话接入层指标（生产级） ─────────────── */

/** 对话消息总数（按 guard_action 维度） */
export const conversationMessagesTotal = meter.createCounter('chrono_conversation_messages_total', {
  description: '对话消息处理总数（按 guard_action 维度）',
});

/** 对话端到端延迟（毫秒） */
export const conversationDurationMs = meter.createHistogram('chrono_conversation_duration_ms', {
  description: '对话端到端处理时长',
  unit: 'ms',
});

/** LLM 调用失败次数 */
export const conversationLlmFailures = meter.createCounter('chrono_conversation_llm_failures_total', {
  description: '对话流水线中 LLM 调用失败次数',
});

/** 配额耗尽次数 */
export const conversationQuotaExceeded = meter.createCounter('chrono_conversation_quota_exceeded_total', {
  description: '对话流水线配额耗尽降级次数',
});

/** PII 脱敏命中次数（按 category） */
export const conversationPiiRedacted = meter.createCounter('chrono_conversation_pii_redacted_total', {
  description: 'PII 脱敏命中次数',
});

/* ─────────────── P1-K Onboarding 漏斗指标 ─────────────── */

/** 引导会话启动总数（label: cohort=v2） */
export const onboardingStarted = meter.createCounter('chrono_onboarding_started_total', {
  description: '引导会话启动次数',
});

/** 各步完成总数（labels: step=1..5, cohort） */
export const onboardingStepCompleted = meter.createCounter('chrono_onboarding_step_completed_total', {
  description: '引导单步完成总数（5 步漏斗 PM 看板）',
});

/** 引导完成总数（complete = 走到底；skip 单独记） */
export const onboardingCompleted = meter.createCounter('chrono_onboarding_completed_total', {
  description: '引导完整走完的会话数',
});

/** 引导主动跳过总数 */
export const onboardingSkipped = meter.createCounter('chrono_onboarding_skipped_total', {
  description: '用户主动跳过引导的会话数',
});

/** 单步完成耗时（毫秒；label: step） */
export const onboardingStepDurationMs = meter.createHistogram('chrono_onboarding_step_duration_ms', {
  description: '引导单步耗时（毫秒），用于 PRD 的 5 分钟预算监控',
  unit: 'ms',
});

/**
 * ADR-0047：蒸馏编译补偿不完整次数（label: step=rollback|reject）。
 * 编译已应用但状态推进失败时触发补偿；若回滚或拒绝标记失败，计入此指标——
 * 表示可能存在"核心已变更但工件未达终态"的不一致，需人工巡检告警。
 */
export const distillationCompensationFailures = meter.createCounter('chrono_distillation_compensation_failures_total', {
  description: '蒸馏编译补偿（回滚/标记）失败次数；>0 表示需人工巡检核心一致性',
});
