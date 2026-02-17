/**
 * 指标收集插件
 * 内存中收集请求计数和延迟，不依赖 Prometheus
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

/** 每个端点保留的最大延迟样本数（环形缓冲区大小） */
const MAX_LATENCY_SAMPLES = 4096;

interface EndpointMetrics {
  count: number;
  /** 环形缓冲区：固定大小，writeIndex 循环覆盖最旧数据 */
  latencies: number[];
  writeIndex: number;
  filled: boolean;
}

/** 计算排序数组的百分位值 */
export function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export class MetricsCollector {
  private readonly endpoints = new Map<string, EndpointMetrics>();

  /** 记录一次请求延迟（环形缓冲区，最多保留 MAX_LATENCY_SAMPLES 条） */
  record(key: string, latencyMs: number): void {
    let entry = this.endpoints.get(key);
    if (!entry) {
      entry = { count: 0, latencies: new Array<number>(MAX_LATENCY_SAMPLES), writeIndex: 0, filled: false };
      this.endpoints.set(key, entry);
    }
    entry.count++;
    entry.latencies[entry.writeIndex] = latencyMs;
    entry.writeIndex++;
    if (entry.writeIndex >= MAX_LATENCY_SAMPLES) {
      entry.writeIndex = 0;
      entry.filled = true;
    }
  }

  /** 获取当前指标快照 */
  snapshot(): Record<string, { count: number; p50_ms: number; p90_ms: number; p99_ms: number }> {
    const result: Record<string, { count: number; p50_ms: number; p90_ms: number; p99_ms: number }> = {};
    for (const [key, entry] of this.endpoints) {
      /* 从环形缓冲区提取有效样本 */
      const sampleCount = entry.filled ? MAX_LATENCY_SAMPLES : entry.writeIndex;
      const samples = entry.latencies.slice(0, sampleCount);
      const sorted = samples.sort((a, b) => a - b);
      result[key] = {
        count: entry.count,
        p50_ms: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
        p90_ms: Math.round(calculatePercentile(sorted, 90) * 100) / 100,
        p99_ms: Math.round(calculatePercentile(sorted, 99) * 100) / 100,
      };
    }
    return result;
  }

  /** 获取总请求数 */
  totalRequests(): number {
    let total = 0;
    for (const entry of this.endpoints.values()) {
      total += entry.count;
    }
    return total;
  }

  /** 重置所有指标 */
  reset(): void {
    this.endpoints.clear();
  }
}

/** 全局收集器实例 */
const collector = new MetricsCollector();

/** 注册请求级指标采集钩子 */
export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, _reply, done) => {
    (request as unknown as Record<string, unknown>).__startTime = performance.now();
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, _reply, done) => {
    const start = (request as unknown as Record<string, number>).__startTime;
    if (start !== undefined) {
      const latency = performance.now() - start;
      /* 使用路由模板（如 /api/v1/values/:id）避免高基数；
         未匹配路由（404）归入固定桶，防止任意 URL 导致基数爆炸 */
      const routeTemplate = request.routeOptions?.url;
      const key = `${request.method} ${routeTemplate ?? 'UNMATCHED'}`;
      collector.record(key, latency);
    }
    done();
  });
}

/** 获取当前指标快照 */
export function getMetricsSnapshot() {
  return collector.snapshot();
}

/** 获取总请求数 */
export function getTotalRequests(): number {
  return collector.totalRequests();
}

/** 重置指标 */
export function resetMetrics(): void {
  collector.reset();
}
