import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { loadConfig } from '../../config/schema.js';
import { ObservabilityWorker } from '../../observability/observability-worker.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { createApp } from '../../server/index.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';

describe('Observability Metrics 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let worker: ObservabilityWorker;
  let service: PersonaCoreService;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    observability: {
      worker: {
        enabled: false,
      },
    },
  });

  beforeEach(async () => {
    const logger = new SilentLogger();
    os = new ChronoSynthOS({
      clock: new TestClock(1000),
      logger,
    });
    os.start();
    app = await createApp({ os, config });
    service = new PersonaCoreService(directUnitOfWork(os.getDatabase()));
    worker = new ObservabilityWorker(os.getDatabase(), logger, { batchSize: 50 });

    const now = Date.now();
    os.getDatabase().prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_obs_owner', 'obs-owner@example.com', 'hash', 'member', 'tenant_obs', now, now);
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('/metrics 暴露异步观测 rollup 指标', async () => {
    const persona = service.createPersona({
      tenantId: 'tenant_obs',
      ownerUserId: 'user_obs_owner',
      displayName: 'Observability Persona',
      visibility: 'marketplace',
    });

    const task = service.publishTask({
      tenantId: 'tenant_obs',
      publisherUserId: 'user_obs_owner',
      title: 'Produce async metrics',
      description: 'Verify outbox worker metrics',
      category: 'operations',
      reward: 120,
    });

    const application = service.applyToTask({
      tenantId: 'tenant_obs',
      ownerUserId: 'user_obs_owner',
      taskId: task.id,
      personaId: persona.id,
    });
    assert.ok(application);

    const assignment = service.assignTask({
      tenantId: 'tenant_obs',
      actorUserId: 'user_obs_owner',
      taskId: task.id,
      personaId: persona.id,
    });
    assert.ok(assignment);

    const runtime = service.createRuntimeSession({
      tenantId: 'tenant_obs',
      ownerUserId: 'user_obs_owner',
      personaId: persona.id,
      taskId: task.id,
    });
    assert.ok(runtime);
    assert.equal(service.planRuntimeSession('tenant_obs', 'user_obs_owner', runtime!.id)?.state, 'EXECUTE');
    assert.equal(service.executeRuntimeSession('tenant_obs', 'user_obs_owner', runtime!.id)?.state, 'EVALUATE');
    assert.equal(service.evaluateRuntimeSession('tenant_obs', 'user_obs_owner', runtime!.id)?.state, 'MEMORY_UPDATE');
    assert.equal(service.completeRuntimeSession('tenant_obs', 'user_obs_owner', runtime!.id)?.state, 'COMPLETED');

    const submitted = service.submitTaskResult({
      tenantId: 'tenant_obs',
      ownerUserId: 'user_obs_owner',
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: `runtime://${runtime!.id}/final.json`,
      evaluation: { summary: 'done' },
    });
    assert.ok(submitted);

    const accepted = service.acceptSubmittedTask({
      tenantId: 'tenant_obs',
      actorUserId: 'user_obs_owner',
      taskId: task.id,
      qualityScore: 0.94,
      clientRating: 5,
    });
    assert.ok(accepted);

    const governanceCase = service.openGovernanceCase({
      tenantId: 'tenant_obs',
      actorUserId: 'user_obs_owner',
      personaId: persona.id,
      triggerType: 'policy_review',
      severity: 'medium',
      details: { taskId: task.id },
    });
    assert.ok(governanceCase);

    const action = service.applyGovernanceAction({
      tenantId: 'tenant_obs',
      actorUserId: 'user_obs_owner',
      caseId: governanceCase!.id,
      actionType: 'temporary_restriction',
      durationSeconds: 1800,
      details: { reason: 'manual review' },
    });
    assert.ok(action);

    const flush = await worker.flush();
    assert.ok(flush.processed >= 6);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.observability.runtime.completed_count, 1);
    assert.ok(body.observability.runtime.avg_duration_ms >= 0);
    assert.equal(body.observability.tasks.success_count, 1);
    assert.equal(body.observability.wallet.settlement_count, 1);
    assert.equal(body.observability.governance.opened_count, 1);
    assert.equal(body.observability.governance.action_applied_count, 1);
    assert.ok(body.observability.persona.growth_event_count >= 2);
    assert.equal(typeof body.observability.pipeline.outbox_pending, 'number');

    const prometheus = await app.inject({ method: 'GET', url: '/metrics/prometheus' });
    assert.equal(prometheus.statusCode, 200);
    assert.ok(prometheus.body.includes('chrono_observability_events_total'));
    assert.ok(prometheus.body.includes('chrono_runtime_completed_total 1'));
    assert.ok(prometheus.body.includes('chrono_task_success_rate 1'));
  });
});
