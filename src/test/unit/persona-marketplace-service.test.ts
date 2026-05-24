/**
 * Step 16d — PersonaMarketplaceService extraction tests.
 *
 * Final cut of the Step 16 split. Tests cover the highest-value
 * extracted flows: publishTask + acceptTask + completeTask round
 * trip, applyToTask, assignTask, and facade behaviour equivalence
 * through the same lifecycle.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';

interface Fixture {
  db: IDatabase;
  service: PersonaCoreService;
  personaId: string;
  tenantId: string;
  ownerUserId: string;
}

function setup(): Fixture {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const tenantId = 'tenant_test';
  const ownerUserId = 'user_test_owner';
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, 'owner@example.com', 'hash', 'member', tenantId, now, now);

  const service = new PersonaCoreService(db);
  const persona = service.createPersona({
    tenantId,
    ownerUserId,
    displayName: 'Marketplace Test',
    profile: {},
  });

  return { db, service, personaId: persona.id, tenantId, ownerUserId };
}

describe('PersonaMarketplaceService (Step 16d extraction)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  it('publishTask + listMarketplaceTasks round-trips through the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Test task',
      description: 'A test task description',
      category: 'writing',
      reward: 100,
    });
    assert.ok(task);
    assert.equal(task.title, 'Test task');
    assert.equal(task.status, 'open');

    const all = fx.service.listMarketplaceTasks(fx.tenantId);
    assert.ok(all.some((t) => t.id === task.id));

    const byId = fx.service.getMarketplaceTaskById(fx.tenantId, task.id);
    assert.deepEqual(byId, task);
  });

  it('acceptTask transitions task status + writes a task memory', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Accept me',
      description: 'desc',
      category: 'general',
      reward: 50,
    });
    const accepted = fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(accepted);
    assert.equal(accepted?.status, 'accepted');
    assert.equal(accepted?.assigneePersonaId, fx.personaId);

    /* The memory write should be visible. */
    const mems = fx.service.listPersonaMemories(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok(mems?.some((m) => m.kind === 'task'));
  });

  it('completeTask awards growth + drops task into completed state', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Complete me',
      description: 'desc',
      category: 'general',
      reward: 200,
    });
    fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const before = fx.service.getPersonaDetail(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    const completed = fx.service.completeTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      qualityScore: 0.9,
      ownerTrainingHours: 2,
    });
    assert.ok(completed);
    assert.equal(completed?.task.status, 'completed');
    /* growthIndex should rise post-completion. */
    assert.ok(completed!.persona.growthIndex > before.growthIndex);
  });

  it('acceptTask returns null when persona is not active', () => {
    fx.service.markDeceased(fx.tenantId, fx.ownerUserId, fx.personaId, 'test');
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Cannot accept',
      description: 'desc',
      category: 'general',
      reward: 10,
    });
    const result = fx.service.acceptTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.equal(result, null);
  });

  it('applyToTask + assignTask round-trip via the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Apply then assign',
      description: 'desc',
      category: 'general',
      reward: 30,
    });
    const application = fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(application);
    assert.equal(application?.status, 'submitted');

    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(assignment);
    assert.equal(assignment?.status, 'assigned');
    assert.equal(assignment?.personaId, fx.personaId);
  });

  it('submitTaskResult + acceptSubmittedTask round-trips through the facade', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Submit + accept',
      description: 'desc',
      category: 'general',
      reward: 50,
    });
    const application = fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(application);
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    assert.ok(assignment);

    const result = fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: { quality: 0.85 },
    });
    assert.ok(result);
    assert.equal(result?.status, 'submitted');

    const accepted = fx.service.acceptSubmittedTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      clientRating: 5,
      qualityScore: 0.9,
    });
    assert.ok(accepted);
    assert.equal(accepted?.result.status, 'accepted');
    assert.equal(accepted?.task.status, 'completed');
  });

  it('rejectSubmittedTask transitions result to rejected', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Reject me',
      description: 'desc',
      category: 'general',
      reward: 20,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: {},
    });

    const rejected = fx.service.rejectSubmittedTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      reason: 'quality too low',
    });
    assert.ok(rejected);
    assert.equal(rejected?.result.status, 'rejected');
    assert.equal(rejected?.result.rejectionReason, 'quality too low');
  });

  it('disputeTask opens a governance case via the facade governance hook', () => {
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Disputed',
      description: 'desc',
      category: 'general',
      reward: 40,
    });
    fx.service.applyToTask({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    const assignment = fx.service.assignTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      personaId: fx.personaId,
      taskId: task.id,
    });
    fx.service.submitTaskResult({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: 's3://test/result',
      evaluation: {},
    });

    const disputed = fx.service.disputeTask({
      tenantId: fx.tenantId,
      actorUserId: fx.ownerUserId,
      taskId: task.id,
      reason: 'output does not match requirements',
    });
    assert.ok(disputed);
    assert.ok(disputed!.governanceCase);
    assert.equal(disputed!.governanceCase.triggerType, 'task_dispute');
    /* The dispute should also surface via listGovernanceCases. */
    const cases = fx.service.listGovernanceCases(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok(cases?.some((c) => c.id === disputed!.governanceCase.id));
  });

  it('recoverTimedOutRuntimeSessions returns the counter shape worker callers expect', () => {
    /* Even with no timed-out sessions, the contract is:
     * { scanned: number, recovered: number, timedOut: number }
     * The runtime-recovery worker reads all three fields, so the
     * shape must stay locked in across the Step 16d extraction. */
    const result = fx.service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: 60_000,
      maxRetries: 3,
      limit: 10,
    });
    assert.equal(typeof result.scanned, 'number');
    assert.equal(typeof result.recovered, 'number');
    assert.equal(typeof result.timedOut, 'number');
    /* No sessions exist → all counters 0. */
    assert.equal(result.scanned, 0);
  });

  it('publishTask + getMarketplaceTaskById are byte-equal across the facade pass-through', () => {
    /* The facade delegates to marketplaceService.publishTask, and
     * getMarketplaceTaskById delegates to marketplaceService too —
     * verify that round-tripping through both delegations preserves
     * the task object byte-for-byte. */
    const task = fx.service.publishTask({
      tenantId: fx.tenantId,
      publisherUserId: fx.ownerUserId,
      title: 'Byte-equal',
      description: 'desc',
      category: 'general',
      reward: 80,
    });
    const reread = fx.service.getMarketplaceTaskById(fx.tenantId, task.id);
    assert.deepEqual(reread, task);
  });
});
