import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMetricsRoutes } from '../../server/routes/metrics.js';
import type { IDatabase, IPreparedStatement, SqlValue } from '../../storage/database.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { Query, Command, ExecResult } from '@chrono/kernel';

function createStatement<T>(handler: (...params: SqlValue[]) => T | T[] | undefined): IPreparedStatement<T> {
  return {
    run(..._params: SqlValue[]) {
      return { changes: 0, lastInsertRowid: 0 };
    },
    get(...params: SqlValue[]) {
      const result = handler(...params);
      return Array.isArray(result) ? result[0] : result;
    },
    all(...params: SqlValue[]) {
      const result = handler(...params);
      if (Array.isArray(result)) return result;
      return result === undefined ? [] : [result];
    },
  };
}

function createBigIntMetricsDb(): IDatabase {
  registerCoreSelfExecutors();
  const db: IDatabase = {
    dialect: 'sqlite',
    exec() {},
    close() {},
    transaction<T>(fn: () => T): T {
      return fn();
    },
    queryOne<TResult, TParams>(q: Query<TResult, TParams>): TResult | null {
      const exec = resolveQueryExecutor(q.kind);
      if (!exec) throw new Error(`未注册的查询: ${q.kind}`);
      return (exec(db, q.params) as TResult) ?? null;
    },
    queryMany<TResult, TParams>(q: Query<TResult, TParams>): readonly TResult[] {
      const exec = resolveQueryExecutor(q.kind);
      if (!exec) throw new Error(`未注册的查询: ${q.kind}`);
      return exec(db, q.params) as readonly TResult[];
    },
    execute<TParams>(cmd: Command<TParams>): ExecResult {
      const exec = resolveCommandExecutor(cmd.kind);
      if (!exec) throw new Error(`未注册的命令: ${cmd.kind}`);
      return exec(db, cmd.params);
    },
    prepare<T = unknown>(sql: string): IPreparedStatement<T> {
      if (sql.includes('FROM billing_outbox')) {
        return createStatement(() => ({ count: 2n })) as unknown as IPreparedStatement<T>;
      }
      if (sql.includes('FROM observability_rollups')) {
        return createStatement(() => ({
          runtime_completed_count: 3n,
          runtime_duration_total_ms: 1200n,
          task_terminal_count: 4n,
          task_success_count: 3n,
          task_rejected_count: 1n,
          task_disputed_count: 0n,
          wallet_settlement_count: 2n,
          wallet_settlement_total_amount_minor: 9900n,
          wallet_settlement_latency_total_ms: 640n,
          governance_case_opened_count: 1n,
          governance_case_active_count: 1n,
          governance_action_applied_count: 1n,
          persona_growth_total: 9n,
          persona_growth_event_count: 3n,
          persona_reputation_delta_total: 7n,
          updated_at: 1_773_491_025_000n,
        })) as unknown as IPreparedStatement<T>;
      }
      if (sql.includes('FROM observability_outbox')) {
        return createStatement(() => ({ count: 5n })) as unknown as IPreparedStatement<T>;
      }
      if (sql.includes('FROM tasks')) {
        return createStatement(() => ({ count: 1n })) as unknown as IPreparedStatement<T>;
      }
      return createStatement(() => undefined) as unknown as IPreparedStatement<T>;
    },
  };
  return db;
}

describe('metrics routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('/metrics 在 Postgres bigint 统计值下仍返回 200 JSON', async () => {
    app = Fastify({ logger: false });
    const fakeOs = {
      getDatabase: () => createBigIntMetricsDb(),
      accelerated: { getAllPersonas: () => [] },
      meta: { conflicts: { getUnresolved: () => [] } },
      snapshots: { list: () => [] },
    };

    registerMetricsRoutes(app, fakeOs as never);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.uptime_seconds >= 0, true);
    assert.equal(body.billing.outbox_pending, 2);
    assert.equal(body.observability.pipeline.outbox_pending, 5);
    assert.equal(body.observability.runtime.completed_count, 3);
    assert.equal(body.observability.runtime.avg_duration_ms, 400);
    assert.equal(body.observability.tasks.success_rate, 0.75);
    assert.equal(body.observability.wallet.avg_settlement_latency_ms, 320);
    assert.equal(body.observability.last_updated_at, '2026-03-14T12:23:45.000Z');
    assert.equal(body.queue.pending, 1);
  });

  it('/metrics + /metrics/prometheus 暴露平台人群多样性（①度量 surface）', async () => {
    /* 真实内存库 + 多租户出生扰动 → 群体多样性应被两个端点 surface。 */
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const factory = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), {
      personalityBirthMagnitude: 0.15,
    });
    for (const t of ['t-a', 't-b', 't-c']) factory.getTenantOS(t);

    app = Fastify({ logger: false });
    const fakeOs = {
      getDatabase: () => db,
      accelerated: { getAllPersonas: () => [] },
      meta: { conflicts: { getUnresolved: () => [] } },
      snapshots: { list: () => [] },
    };
    registerMetricsRoutes(app, fakeOs as never);

    /* JSON：business.population_diversity 出现且 initialized_population=3、score>0。 */
    const json = JSON.parse((await app.inject({ method: 'GET', url: '/metrics' })).body);
    assert.equal(json.business.population_diversity.initialized_population, 3);
    assert.ok(json.business.population_diversity.diversity_score > 0, '多租户 score 应>0');
    assert.ok(json.business.population_diversity.per_dimension_spread, '应含 per-dimension spread');

    /* Prometheus：三个 gauge 行出现，且 initialized population gauge=3。 */
    const prom = (await app.inject({ method: 'GET', url: '/metrics/prometheus' })).body;
    assert.match(prom, /# TYPE chrono_persona_diversity_score gauge/);
    assert.match(prom, /chrono_persona_population_initialized_total 3/);
    assert.match(prom, /chrono_persona_diversity_dimension_spread\{dimension="riskAppetite"\}/);
  });
});
