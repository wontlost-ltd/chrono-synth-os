import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { FieldEncryption } from '../../storage/encryption.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('PersonaCoreService', () => {
  let db: IDatabase;
  let service: PersonaCoreService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    service = new PersonaCoreService(directUnitOfWork(db));

    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_test_owner', 'owner@example.com', 'hash', 'member', 'tenant_test', now, now);
  });

  it('创建 persona 后可完成市场任务并累积钱包与成长', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Nova Prime',
      profile: { mission: 'research-first', traits: ['precise', 'durable'] },
      initialKnowledge: [
        { title: 'Platform brief', content: 'Core platform strategy', tags: ['strategy'] },
      ],
    });

    assert.equal(persona.displayName, 'Nova Prime');
    assert.equal(persona.wallet.balance, 0);
    assert.equal(persona.knowledgeItems.length, 1);

    const forked = service.createFork({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      label: 'Nova Research Fork',
      forkType: 'research',
    });

    assert.ok(forked);
    assert.equal(forked?.stats.activeForks, 1);
    const forkId = forked?.forks[0]?.id;
    assert.ok(forkId);

    const task = service.publishTask({
      tenantId: 'tenant_test',
      publisherUserId: 'user_test_owner',
      title: 'Write system architecture memo',
      description: 'Summarize the new Persona Core model',
      category: 'writing',
      reward: 120,
    });

    const accepted = service.acceptTask({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      taskId: task.id,
      personaId: persona.id,
      forkId,
    });
    assert.equal(accepted?.status, 'accepted');

    const completed = service.completeTask({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      taskId: task.id,
      qualityScore: 0.92,
      ownerTrainingHours: 3,
    });

    assert.ok(completed);
    assert.equal(completed?.task.status, 'completed');
    assert.ok((completed?.wallet.balance ?? 0) > 0);
    assert.ok((completed?.wallet.tokenBalance ?? 0) > 0);
    assert.ok((completed?.persona.growthIndex ?? 0) > 0);
    assert.ok((completed?.persona.reputation ?? 0) > 0);
    assert.ok((completed?.persona.growthEvents.length ?? 0) >= 1);
  });

  it('治理事件可以把 persona 置为 restricted 或 deceased', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Sentinel',
    });

    const restricted = service.addGovernanceEvent({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      eventType: 'restriction',
      severity: 3,
      summary: 'Compliance review failed',
      payload: { reason: 'policy_violation' },
    });

    assert.equal(restricted?.status, 'restricted');
    assert.equal(restricted?.governanceEvents[0]?.eventType, 'restriction');

    const deceased = service.markDeceased('tenant_test', 'user_test_owner', persona.id, 'manual shutdown');
    assert.equal(deceased?.status, 'deceased');
    assert.ok(deceased?.deceasedAt);
  });

  it('支持文档对齐的 task apply/assign/runtime/submit/accept 与 governance case/action', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Runtime Persona',
      visibility: 'marketplace',
    });

    const task = service.publishTask({
      tenantId: 'tenant_test',
      publisherUserId: 'user_test_owner',
      title: 'Formal runtime contract',
      description: 'Implement the runtime v1 flow',
      category: 'coding',
      reward: 180,
    });

    const application = service.applyToTask({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      taskId: task.id,
      personaId: persona.id,
    });
    assert.ok(application);
    assert.equal(application?.status, 'submitted');

    const assignment = service.assignTask({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      taskId: task.id,
      personaId: persona.id,
    });
    assert.ok(assignment);
    assert.equal(assignment?.status, 'assigned');

    const runtime = service.createRuntimeSession({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      taskId: task.id,
    });
    assert.ok(runtime);
    assert.equal(runtime?.state, 'PLAN');

    const planned = service.planRuntimeSession('tenant_test', 'user_test_owner', runtime!.id);
    assert.equal(planned?.state, 'EXECUTE');
    assert.ok(planned?.plan?.steps.length);

    const executed = service.executeRuntimeSession('tenant_test', 'user_test_owner', runtime!.id);
    assert.equal(executed?.state, 'EVALUATE');
    assert.ok(executed?.artifacts.length);

    const evaluated = service.evaluateRuntimeSession('tenant_test', 'user_test_owner', runtime!.id);
    assert.equal(evaluated?.state, 'MEMORY_UPDATE');
    assert.equal((evaluated?.evaluation?.ready_for_completion as boolean | undefined) ?? false, true);

    const completedSession = service.completeRuntimeSession('tenant_test', 'user_test_owner', runtime!.id);
    assert.equal(completedSession?.state, 'COMPLETED');
    assert.equal((completedSession?.resultSummary?.memory_records_created as number | undefined) ?? 0, 1);

    const submitted = service.submitTaskResult({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      taskId: task.id,
      assignmentId: assignment!.id,
      resultUri: `runtime://${runtime!.id}/final.json`,
      evaluation: { summary: 'Runtime finished' },
    });
    assert.ok(submitted);
    assert.equal(submitted?.status, 'submitted');

    const accepted = service.acceptSubmittedTask({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      taskId: task.id,
      clientRating: 5,
      qualityScore: 0.91,
    });
    assert.ok(accepted);
    assert.equal(accepted?.task.status, 'completed');
    assert.equal(accepted?.assignment.status, 'accepted');
    assert.equal(accepted?.result.status, 'accepted');

    const wallet = service.getWalletByIdForOwner('tenant_test', 'user_test_owner', persona.wallet.id);
    assert.ok(wallet);
    assert.equal(wallet?.balance, 108);
    assert.equal(wallet?.tokenBalance, 36);

    const transactions = service.listWalletTransactions('tenant_test', 'user_test_owner', persona.wallet.id);
    assert.ok(transactions);
    assert.equal(transactions?.length, 3);
    assert.equal(transactions?.some((item) => item.transactionType === 'task_payment' && item.amountMinor === 18000), true);
    assert.equal(transactions?.some((item) => item.transactionType === 'platform_fee' && item.amountMinor === -3600), true);
    assert.equal(transactions?.some((item) => item.transactionType === 'persona_reserve' && item.amountMinor === -3600), true);

    const payout = service.requestWalletPayout({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      walletId: persona.wallet.id,
      amountMinor: 5000,
    });
    assert.ok(payout);
    assert.equal(payout?.status, 'completed');

    const walletAfterPayout = service.getWalletByIdForOwner('tenant_test', 'user_test_owner', persona.wallet.id);
    assert.equal(walletAfterPayout?.balance, 58);

    const duplicateSettlement = service.settleTaskPayment({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      taskId: task.id,
      assignmentId: assignment!.id,
      totalAmountMinor: 18000,
      currency: 'CRED',
      split: {
        ownerPct: 60,
        personaPct: 20,
        platformPct: 20,
      },
    });
    assert.ok(duplicateSettlement);
    assert.equal(duplicateSettlement?.status, 'completed');

    const recompute = service.recomputeMarketplaceRankings('tenant_test', {
      category: 'coding',
      limit: 5,
    });
    assert.equal(recompute.rankings[0]?.personaId, persona.id);
    assert.ok(recompute.materialization.metricDate);
    assert.ok(recompute.materialization.personaRows >= 1);

    const economy = service.getEconomyAnalytics('tenant_test');
    assert.equal(economy.grossRevenueMinor, 18000);
    assert.equal(economy.ownerPayoutsMinor, 5000);
    assert.equal(economy.platformFeesMinor, 3600);
    assert.equal(economy.personaReservesMinor, 3600);
    assert.equal(economy.payoutRequests, 1);
    assert.equal(economy.settlementCount, 1);
    assert.equal(economy.transactionCount, 4);

    const governanceCase = service.openGovernanceCase({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      personaId: persona.id,
      triggerType: 'policy_review',
      severity: 'medium',
      details: { taskId: task.id },
    });
    assert.ok(governanceCase);
    assert.equal(governanceCase?.status, 'open');

    const action = service.applyGovernanceAction({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      caseId: governanceCase!.id,
      actionType: 'temporary_restriction',
      durationSeconds: 3600,
      details: { reason: 'manual review' },
    });
    assert.ok(action);
    assert.equal(action?.personaStatus, 'restricted');

    const cases = service.listGovernanceCases('tenant_test', 'user_test_owner', persona.id);
    assert.ok(cases);
    assert.equal(cases?.[0]?.id, governanceCase?.id);

    const appealed = service.appealGovernanceCase({
      tenantId: 'tenant_test',
      actorUserId: 'user_test_owner',
      caseId: governanceCase!.id,
      details: { appeal: 'fixed' },
    });
    assert.equal(appealed?.status, 'appealed');
  });

  it('Persona Operating State 聚合认知记忆与工作记忆', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Operator',
      initialKnowledge: [
        { title: 'Runbook', content: 'Always verify healthz before rollout', confidence: 0.9 },
      ],
    });

    service.addMemory({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      kind: 'interaction',
      summary: 'Owner requested a safer deployment flow',
      content: { channel: 'cli', request: 'safe deploy' },
      importance: 0.8,
    });

    service.addMemory({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      kind: 'training',
      summary: 'Practiced rollback checklist',
      content: { checklist: ['backup', 'rollback', 'verify'] },
      importance: 0.72,
    });

    const state = service.getOperatingState('tenant_test', 'user_test_owner', persona.id);
    assert.ok(state);
    assert.equal(state?.persona.id, persona.id);
    assert.ok((state?.cognitive.totalMemories ?? 0) >= 3);
    assert.ok((state?.cognitive.totalEdges ?? 0) >= 2);
    assert.ok((state?.cognitive.workingMemory.length ?? 0) > 0);
    assert.equal(state?.cognitive.semanticKnowledge[0]?.kind, 'semantic');
    assert.equal(state?.cognitive.recentExperiences[0]?.kind, 'episodic');
    assert.equal(state?.cognitive.proceduralMemory[0]?.kind, 'procedural');
  });

  it('生命周期评估会先将长期无活动 persona 标记为 dormant', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Dormant Persona',
    });

    const staleAt = Date.now() - 240 * DAY_MS;
    db.prepare<void>(
      'UPDATE persona_core SET created_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    ).run(staleAt, staleAt, 'tenant_test', persona.id);
    db.prepare<void>(
      'UPDATE persona_wallets SET created_at = ?, updated_at = ?, last_settled_at = ? WHERE tenant_id = ? AND persona_id = ?',
    ).run(staleAt, staleAt, staleAt, 'tenant_test', persona.id);

    const evaluation = service.evaluateLifecycle({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      inactivityDays: 180,
    });

    assert.ok(evaluation);
    assert.equal(evaluation?.transition, 'dormant');
    assert.equal(evaluation?.persona.status, 'dormant');

    const secondEvaluation = service.evaluateLifecycle({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      inactivityDays: 180,
    });

    assert.ok(secondEvaluation);
    assert.equal(secondEvaluation?.transition, 'none');
    assert.equal(secondEvaluation?.persona.status, 'dormant');
  });

  it('dormant persona 在第二个 inactivity 周期后会被标记为 deceased', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Dormant Then Dead',
    });

    const staleAt = Date.now() - 240 * DAY_MS;
    db.prepare<void>(
      'UPDATE persona_core SET created_at = ?, updated_at = ?, lifecycle_status = ? WHERE tenant_id = ? AND id = ?',
    ).run(staleAt, staleAt, 'dormant', 'tenant_test', persona.id);
    db.prepare<void>(
      'UPDATE persona_wallets SET created_at = ?, updated_at = ?, last_settled_at = ? WHERE tenant_id = ? AND persona_id = ?',
    ).run(staleAt, staleAt, staleAt, 'tenant_test', persona.id);

    const evaluation = service.evaluateLifecycle({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      inactivityDays: 180,
    });

    assert.ok(evaluation);
    assert.equal(evaluation?.transition, 'deceased');
    assert.equal(evaluation?.persona.status, 'deceased');
    assert.ok((evaluation?.lastActiveAt ?? 0) <= staleAt);
  });

  it('生命周期评估会保留近期仍有活动的 persona', () => {
    const persona = service.createPersona({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      displayName: 'Active Persona',
    });

    service.addMemory({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      kind: 'interaction',
      summary: 'Owner checked in recently',
      content: { channel: 'dashboard' },
      importance: 0.6,
    });

    const evaluation = service.evaluateLifecycle({
      tenantId: 'tenant_test',
      ownerUserId: 'user_test_owner',
      personaId: persona.id,
      inactivityDays: 180,
    });

    assert.ok(evaluation);
    assert.equal(evaluation?.transition, 'none');
    assert.equal(evaluation?.persona.status, 'active');
    assert.ok((evaluation?.lastActiveAt ?? 0) > Date.now() - DAY_MS);
  });

  it('敏感 persona memory 在启用加密时以密文落库并明文回读', () => {
    const encDb = createMemoryDatabase();
    runMigrations(encDb);
    const encryption = new FieldEncryption({
      enabled: true,
      masterKey: randomBytes(32).toString('base64'),
      keyRotationIntervalDays: 90,
    });
    const encryptedService = new PersonaCoreService(directUnitOfWork(encDb), encryption);

    const now = Date.now();
    encDb.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_enc_owner', 'enc-owner@example.com', 'hash', 'member', 'tenant_enc', now, now);

    const persona = encryptedService.createPersona({
      tenantId: 'tenant_enc',
      ownerUserId: 'user_enc_owner',
      displayName: 'Encrypted Memory Persona',
    });

    const memory = encryptedService.addMemory({
      tenantId: 'tenant_enc',
      ownerUserId: 'user_enc_owner',
      personaId: persona.id,
      kind: 'interaction',
      sensitivity: 'encrypted',
      summary: 'Secret deployment note',
      content: { note: 'rotate credentials after rollout' },
      importance: 0.91,
    });

    assert.ok(memory);
    assert.equal(memory?.summary, 'Secret deployment note');
    assert.equal(memory?.content.note, 'rotate credentials after rollout');
    assert.equal(memory?.isEncrypted, true);
    assert.equal(memory?.sensitivity, 'encrypted');

    const raw = encDb.prepare<{
      summary: string;
      content_json: string;
      is_encrypted: number;
      sensitivity: string;
    }>(
      'SELECT summary, content_json, is_encrypted, sensitivity FROM persona_memories WHERE tenant_id = ? AND id = ?',
    ).get('tenant_enc', memory!.id);
    assert.ok(raw);
    assert.equal(raw?.is_encrypted, 1);
    assert.equal(raw?.sensitivity, 'encrypted');
    assert.notEqual(raw?.summary, 'Secret deployment note');
    assert.notEqual(raw?.content_json, JSON.stringify({ note: 'rotate credentials after rollout' }));

    const detail = encryptedService.getPersonaDetail('tenant_enc', 'user_enc_owner', persona.id);
    assert.ok(detail);
    assert.equal(detail?.recentMemories[0]?.summary, 'Secret deployment note');
    assert.equal(detail?.recentMemories[0]?.content.note, 'rotate credentials after rollout');

    const cognitiveRow = encDb.prepare<{ content: string }>(
      'SELECT content FROM persona_memory_nodes WHERE tenant_id = ? AND persona_id = ? LIMIT 1',
    ).get('tenant_enc', persona.id);
    assert.ok(cognitiveRow);
    assert.notEqual(cognitiveRow?.content, 'Secret deployment note');
  });
});
