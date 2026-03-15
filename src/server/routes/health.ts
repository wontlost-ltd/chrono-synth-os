/**
 * 健康检查路由
 * /healthz 轻量探活（含版本），/readyz 深度就绪检查（含 Redis）
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { IDatabase } from '../../storage/database.js';
import type { TaskWorker } from '../../queue/task-worker.js';
import { CircuitBreaker, CircuitOpenError } from '../plugins/circuit-breaker.js';
import { getPackageVersion } from '../../utils/package-version.js';

const getVersion = getPackageVersion;

/** 服务器生命周期状态（由 main.ts 管理） */
export const serverState = {
  ready: false,
  shuttingDown: false,
  startTime: Date.now(),
};

export interface HealthRouteDeps {
  os: ChronoSynthOS;
  /** 数据库实例，用于轻量级探活查询 */
  db?: IDatabase;
  /** 可选注入断路器，便于测试；不传则内部创建 */
  circuitBreaker?: CircuitBreaker;
  /** 可选任务工作者，用于报告队列健康状态 */
  worker?: TaskWorker;
  /** 可选观测工作者，用于报告异步观测健康状态 */
  observabilityWorker?: { isHealthy(): boolean; inflight: number };
  /** 可选 runtime 恢复工作者，用于报告 runtime recovery 健康状态 */
  runtimeRecoveryWorker?: { isHealthy(): boolean; inflight: number };
  /** 可选 settlement reconciliation 工作者，用于报告账务对账健康状态 */
  settlementReconciliationWorker?: { isHealthy(): boolean; inflight: number };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { os, db } = deps;
  const dbCircuitBreaker = deps.circuitBreaker ?? new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 10_000,
    halfOpenMaxRequests: 1,
  });

  /* 轻量探活：版本 + 运行时间 */
  app.get('/healthz', async () => {
    return {
      status: 'ok',
      version: getVersion(),
      uptime: Math.floor((Date.now() - serverState.startTime) / 1000),
    };
  });

  /* 深度就绪检查 */
  app.get('/readyz', async (_request, reply) => {
    if (serverState.shuttingDown) {
      return reply.status(503).send({
        status: 'shutting_down',
        version: getVersion(),
        components: {},
      });
    }

    const components: Record<string, unknown> = {};

    /* OS 就绪状态 */
    components.os = { status: serverState.ready ? 'ok' : 'not_ready' };

    /* 数据库可达性：通过断路器执行轻量 SELECT 1 + 延迟测量 */
    let dbOk = false;
    let dbLatencyMs = 0;
    let dbStatus: string = 'degraded';
    try {
      const start = performance.now();
      await dbCircuitBreaker.execute(() => {
        if (db) {
          db.prepare<{ ok: number }>('SELECT 1 AS ok').get();
        } else {
          os.core.values.getAll();
        }
      });
      dbLatencyMs = Math.round((performance.now() - start) * 100) / 100;
      dbOk = true;
      dbStatus = 'ok';
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        dbStatus = 'circuit_open';
      }
      dbOk = false;
    }
    components.database = { status: dbStatus, latency_ms: dbLatencyMs };

    /* Redis 可达性 */
    let redisOk = true;
    if (app.redis) {
      try {
        const start = performance.now();
        await app.redis.ping();
        const latency = Math.round((performance.now() - start) * 100) / 100;
        components.redis = { status: 'ok', latency_ms: latency };
      } catch {
        components.redis = { status: 'degraded' };
        redisOk = false;
      }
    }

    /* 任务队列工作者 */
    if (deps.worker) {
      const healthy = deps.worker.isHealthy();
      components.worker = { status: healthy ? 'ok' : 'stopped', inflight: deps.worker.inflight };
    }

    if (deps.observabilityWorker) {
      const healthy = deps.observabilityWorker.isHealthy();
      components.observability_worker = {
        status: healthy ? 'ok' : 'stopped',
        inflight: deps.observabilityWorker.inflight,
      };
    }

    if (deps.runtimeRecoveryWorker) {
      const healthy = deps.runtimeRecoveryWorker.isHealthy();
      components.runtime_recovery_worker = {
        status: healthy ? 'ok' : 'stopped',
        inflight: deps.runtimeRecoveryWorker.inflight,
      };
    }

    if (deps.settlementReconciliationWorker) {
      const healthy = deps.settlementReconciliationWorker.isHealthy();
      components.settlement_reconciliation_worker = {
        status: healthy ? 'ok' : 'stopped',
        inflight: deps.settlementReconciliationWorker.inflight,
      };
    }

    const allOk = serverState.ready && dbOk && redisOk;
    const statusCode = allOk ? 200 : 503;
    const status = allOk ? 'ok' : 'degraded';

    return reply.status(statusCode).send({ status, version: getVersion(), components });
  });
}
