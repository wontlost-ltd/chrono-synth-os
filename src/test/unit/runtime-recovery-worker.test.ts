import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { RuntimeRecoveryWorker } from '../../persona-core/runtime-recovery-worker.js';
import { SilentLogger } from '../../utils/logger.js';

describe('RuntimeRecoveryWorker', () => {
  let db: IDatabase;
  let service: PersonaCoreService;
  let logger: SilentLogger;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    service = new PersonaCoreService(db);
    logger = new SilentLogger();

    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_runtime_owner', 'runtime-owner@example.com', 'hash', 'member', 'tenant_runtime', now, now);
  });

  it('会把超时 runtime 从活动态恢复到可重试态，并在重试耗尽后置为 TIMEOUT', async () => {
    const persona = service.createPersona({
      tenantId: 'tenant_runtime',
      ownerUserId: 'user_runtime_owner',
      displayName: 'Recovery Persona',
      visibility: 'marketplace',
    });
    const task = service.publishTask({
      tenantId: 'tenant_runtime',
      publisherUserId: 'user_runtime_owner',
      title: 'Recover timed out runtime',
      description: 'Exercise runtime recovery worker',
      category: 'operations',
      reward: 100,
    });

    assert.ok(service.applyToTask({
      tenantId: 'tenant_runtime',
      ownerUserId: 'user_runtime_owner',
      taskId: task.id,
      personaId: persona.id,
    }));
    const assignment = service.assignTask({
      tenantId: 'tenant_runtime',
      actorUserId: 'user_runtime_owner',
      taskId: task.id,
      personaId: persona.id,
    });
    assert.ok(assignment);

    const runtime = service.createRuntimeSession({
      tenantId: 'tenant_runtime',
      ownerUserId: 'user_runtime_owner',
      personaId: persona.id,
      taskId: task.id,
    });
    assert.ok(runtime);
    assert.equal(service.planRuntimeSession('tenant_runtime', 'user_runtime_owner', runtime!.id)?.state, 'EXECUTE');

    db.prepare<void>(
      `UPDATE runtime_sessions
       SET timeout_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(Date.now() - 1_000, Date.now() - 1_000, 'tenant_runtime', runtime!.id);

    const worker = new RuntimeRecoveryWorker(db, logger, {
      pollIntervalMs: 10_000,
      sessionTimeoutMs: 60_000,
      maxRetries: 1,
      batchSize: 10,
    });

    const first = await worker.flush();
    assert.equal(first.recovered, 1);
    assert.equal(first.timedOut, 0);

    const recovered = service.getRuntimeSession('tenant_runtime', 'user_runtime_owner', runtime!.id);
    assert.equal(recovered?.state, 'PLAN');
    assert.equal(recovered?.retryCount, 1);
    assert.ok((recovered?.timeoutAt ?? 0) > Date.now());
    assert.equal(recovered?.completedAt, null);

    db.prepare<void>(
      `UPDATE runtime_sessions
       SET timeout_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(Date.now() - 1_000, 'tenant_runtime', runtime!.id);

    const second = await worker.flush();
    assert.equal(second.recovered, 0);
    assert.equal(second.timedOut, 1);

    const terminal = service.getRuntimeSession('tenant_runtime', 'user_runtime_owner', runtime!.id);
    assert.equal(terminal?.state, 'TIMEOUT');
    assert.equal(terminal?.retryCount, 1);
    assert.ok(terminal?.completedAt);
    assert.equal(terminal?.timeoutAt, null);
  });
});
