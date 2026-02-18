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
