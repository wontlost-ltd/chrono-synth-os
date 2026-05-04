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
