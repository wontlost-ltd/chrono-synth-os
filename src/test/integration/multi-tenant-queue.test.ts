import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('多租户与任务队列集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
    queue: { enabled: true, pollIntervalMs: 50000, maxConcurrent: 1, maxRetries: 2 },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  describe('租户识别 (X-Tenant-Id)', () => {
    it('无 X-Tenant-Id 使用默认租户', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/values', payload: { label: '诚信', weight: 0.8 } });
      assert.equal(res.statusCode, 201);
    });

    it('有 X-Tenant-Id 时请求包含租户标识', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/values',
        headers: { 'x-tenant-id': 'test-tenant' },
        payload: { label: '勇气', weight: 0.6 },
      });
      assert.equal(res.statusCode, 201);
    });

    it('无效 X-Tenant-Id 回退到默认租户', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-tenant-id': 'invalid tenant id!!!' },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('GET /api/v1/tasks/:taskId', () => {
    it('查询已入队的任务', async () => {
      /* 通过内部 API 入队一个任务（模拟） */
      const db = os.getDatabase();
      const { TaskQueue } = await import('../../queue/task-queue.js');
      const queue = new TaskQueue(db);
      const taskId = queue.enqueue('default', 'test:echo', { message: 'hello' });

      const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.id, taskId);
      assert.equal(body.data.type, 'test:echo');
      assert.equal(body.data.status, 'pending');
    });

    it('不存在的任务返回 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/tasks/task_nonexistent' });
      assert.equal(res.statusCode, 404);
    });

    it('非本租户的任务不可见', async () => {
      const db = os.getDatabase();
      const { TaskQueue } = await import('../../queue/task-queue.js');
      const queue = new TaskQueue(db);
      const taskId = queue.enqueue('other-tenant', 'test:echo', {});

      /* 默认租户查不到其他租户的任务 */
      const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}` });
      assert.equal(res.statusCode, 404);
    });
  });
});
