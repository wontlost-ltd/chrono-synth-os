import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector, calculatePercentile } from '../../server/plugins/metrics.js';

describe('指标系统', () => {
  describe('calculatePercentile', () => {
    it('空数组返回 0', () => {
      assert.equal(calculatePercentile([], 50), 0);
    });

    it('单元素数组始终返回该元素', () => {
      assert.equal(calculatePercentile([42], 50), 42);
      assert.equal(calculatePercentile([42], 99), 42);
    });

    it('计算 p50', () => {
      const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      assert.equal(calculatePercentile(sorted, 50), 5);
    });

    it('计算 p90', () => {
      const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      assert.equal(calculatePercentile(sorted, 90), 9);
    });

    it('计算 p99', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
      assert.equal(calculatePercentile(sorted, 99), 99);
    });
  });

  describe('MetricsCollector', () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it('初始状态无指标', () => {
      assert.deepEqual(collector.snapshot(), {});
      assert.equal(collector.totalRequests(), 0);
    });

    it('记录并汇总请求延迟', () => {
      collector.record('GET /healthz', 10);
      collector.record('GET /healthz', 20);
      collector.record('GET /healthz', 30);

      const snap = collector.snapshot();
      assert.equal(snap['GET /healthz'].count, 3);
      assert.equal(collector.totalRequests(), 3);
    });

    it('分端点独立统计', () => {
      collector.record('GET /healthz', 5);
      collector.record('POST /api/v1/values', 15);

      const snap = collector.snapshot();
      assert.equal(snap['GET /healthz'].count, 1);
      assert.equal(snap['POST /api/v1/values'].count, 1);
      assert.equal(collector.totalRequests(), 2);
    });

    it('reset 清空所有指标', () => {
      collector.record('GET /healthz', 10);
      collector.reset();

      assert.deepEqual(collector.snapshot(), {});
      assert.equal(collector.totalRequests(), 0);
    });

    it('百分位数计算正确', () => {
      for (let i = 1; i <= 100; i++) {
        collector.record('GET /test', i);
      }

      const snap = collector.snapshot();
      assert.equal(snap['GET /test'].count, 100);
      assert.equal(snap['GET /test'].p50_ms, 50);
      assert.equal(snap['GET /test'].p90_ms, 90);
      assert.equal(snap['GET /test'].p99_ms, 99);
    });
  });
});
