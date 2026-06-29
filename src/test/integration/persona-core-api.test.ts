import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const DAY_MS = 24 * 60 * 60 * 1000;

interface AuthContext {
  accessToken: string;
  tenantId: string;
  userId?: string;
}

describe('Persona Core API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
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

  async function registerUser(email: string): Promise<AuthContext> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    assert.equal(response.statusCode, 201);
    return JSON.parse(response.body).data as AuthContext;
  }

  function authHeaders(auth: AuthContext, extraHeaders?: Record<string, string>) {
    return {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
      ...(extraHeaders ?? {}),
    };
  }

  it('走通 persona core + marketplace 最小业务闭环', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-core@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string };

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers,
      payload: {
        displayName: 'Aurora Core',
        visibility: 'marketplace',
        profile: { mission: 'deliver reliable market work' },
        initialKnowledge: [
          { title: 'House style', content: 'Use concise technical prose', tags: ['writing', 'ops'] },
        ],
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const createdPersona = JSON.parse(createPersonaRes.body).data as {
      id: string;
      wallet: { balance: number };
      knowledgeItems: Array<{ title: string }>;
    };
    assert.equal(createdPersona.wallet.balance, 0);
    assert.equal(createdPersona.knowledgeItems[0]?.title, 'House style');

    const forkRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/forks`,
      headers,
      payload: {
        label: 'Aurora Delivery Fork',
        forkType: 'operations',
      },
    });
    assert.equal(forkRes.statusCode, 201);
    const forkBody = JSON.parse(forkRes.body).data as { forks: Array<{ id: string }> };
    const forkId = forkBody.forks[0]?.id;
    assert.ok(forkId);

    const publishTaskRes = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers,
      payload: {
        title: 'Prepare rollout checklist',
        description: 'Draft a deployment checklist for Podman-based local testing',
        category: 'operations',
        reward: 80,
      },
    });
    assert.equal(publishTaskRes.statusCode, 201);
    const task = JSON.parse(publishTaskRes.body).data as { id: string; status: string };
    assert.equal(task.status, 'open');

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/tasks/${task.id}/accept`,
      headers,
      payload: {
        personaId: createdPersona.id,
        forkId,
      },
    });
    assert.equal(acceptRes.statusCode, 200);
    assert.equal(JSON.parse(acceptRes.body).data.status, 'accepted');

    const completeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/tasks/${task.id}/complete`,
      headers,
      payload: {
        qualityScore: 0.9,
        ownerTrainingHours: 2,
      },
    });
    assert.equal(completeRes.statusCode, 200);
    const completed = JSON.parse(completeRes.body).data as {
      task: { status: string };
      wallet: { balance: number };
      persona: { growthIndex: number; reputation: number; marketplaceTasks: Array<{ id: string; status: string }> };
    };
    assert.equal(completed.task.status, 'completed');
    assert.ok(completed.wallet.balance > 0);
    assert.ok(completed.persona.growthIndex > 0);
    assert.ok(completed.persona.reputation > 0);
    assert.equal(completed.persona.marketplaceTasks[0]?.id, task.id);

    const reputationRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${createdPersona.id}/reputation`,
      headers,
    });
    assert.equal(reputationRes.statusCode, 200);
    const reputation = JSON.parse(reputationRes.body).data as {
      score: number;
      summary: { successfulTasks: number };
    };
    assert.ok(reputation.score >= 50);
    assert.equal(reputation.summary.successfulTasks, 1);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${createdPersona.id}/reputation/history`,
      headers,
    });
    assert.equal(historyRes.statusCode, 200);
    const history = JSON.parse(historyRes.body).data as Array<{ oldScore: number; newScore: number }>;
    assert.ok(history.length > 0);
    assert.ok(history[0]!.newScore >= history[0]!.oldScore);

    const topPersonasRes = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/top-personas?category=operations&limit=5',
      headers,
    });
    assert.equal(topPersonasRes.statusCode, 200);
    const rankings = JSON.parse(topPersonasRes.body).data as Array<{ personaId: string; score: number }>;
    assert.equal(rankings[0]?.personaId, createdPersona.id);
    assert.ok((rankings[0]?.score ?? 0) > 0);

    const personaAnalyticsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/personas/${createdPersona.id}`,
      headers,
    });
    assert.equal(personaAnalyticsRes.statusCode, 200);
    const personaAnalytics = JSON.parse(personaAnalyticsRes.body).data as {
      tasksCompleted: number;
      reputationScore: number;
      walletBalance: number;
    };
    assert.equal(personaAnalytics.tasksCompleted, 1);
    assert.ok(personaAnalytics.reputationScore >= 50);
    assert.ok(personaAnalytics.walletBalance > 0);

    const marketplaceAnalyticsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/marketplace/overview',
      headers,
    });
    assert.equal(marketplaceAnalyticsRes.statusCode, 200);
    const marketplaceAnalytics = JSON.parse(marketplaceAnalyticsRes.body).data as {
      completedTasks7d: number;
      grossVolume: number;
    };
    assert.equal(marketplaceAnalytics.completedTasks7d, 1);
    assert.ok(marketplaceAnalytics.grossVolume >= 80);

    const restrictedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/governance-events`,
      headers,
      payload: {
        eventType: 'restriction',
        severity: 2,
        summary: 'Temporary review hold',
      },
    });
    assert.equal(restrictedRes.statusCode, 201);
    assert.equal(JSON.parse(restrictedRes.body).data.status, 'restricted');

    const operatingStateRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${createdPersona.id}/operating-state`,
      headers,
    });
    assert.equal(operatingStateRes.statusCode, 200);
    const operatingState = JSON.parse(operatingStateRes.body).data as {
      persona: { id: string; status: string };
      cognitive: {
        totalMemories: number;
        totalEdges: number;
        workingMemory: Array<{ slot: { memoryId: string }; memory: { kind: string } | null }>;
        semanticKnowledge: Array<{ kind: string }>;
      };
    };
    assert.equal(operatingState.persona.id, createdPersona.id);
    assert.equal(operatingState.persona.status, 'restricted');
    assert.ok(operatingState.cognitive.totalMemories >= 4);
    assert.ok(operatingState.cognitive.totalEdges >= 3);
    assert.ok(operatingState.cognitive.workingMemory.length > 0);
    assert.equal(operatingState.cognitive.semanticKnowledge[0]?.kind, 'semantic');
  });

  it('生命周期评估接口会先将长期闲置 persona 置为 dormant，再允许手动激活', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-lifecycle@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string };

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers,
      payload: {
        displayName: 'Dormant Core',
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const createdPersona = JSON.parse(createPersonaRes.body).data as { id: string };

    const staleAt = Date.now() - 220 * DAY_MS;
    os.getDatabase().prepare<void>(
      'UPDATE persona_core SET created_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    ).run(staleAt, staleAt, auth.tenantId, createdPersona.id);
    os.getDatabase().prepare<void>(
      'UPDATE persona_wallets SET created_at = ?, updated_at = ?, last_settled_at = ? WHERE tenant_id = ? AND persona_id = ?',
    ).run(staleAt, staleAt, staleAt, auth.tenantId, createdPersona.id);

    const lifecycleRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/lifecycle/evaluate`,
      headers,
      payload: {
        inactivityDays: 180,
      },
    });
    assert.equal(lifecycleRes.statusCode, 200);
    const lifecycle = JSON.parse(lifecycleRes.body).data as {
      persona: { status: string };
      evaluation: { transition: string; inactivityDays: number; lastActiveAt: string | null };
    };
    assert.equal(lifecycle.evaluation.transition, 'dormant');
    assert.equal(lifecycle.evaluation.inactivityDays, 180);
    assert.ok(lifecycle.evaluation.lastActiveAt);
    assert.equal(lifecycle.persona.status, 'dormant');

    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/activate`,
      headers,
    });
    assert.equal(activateRes.statusCode, 200);
    assert.equal(JSON.parse(activateRes.body).data.status, 'active');
  });

  it('文档对齐的 runtime session + apply/assign/submit/accept + governance case/action/appeal 流程可用', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-runtime@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string };

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers,
      payload: {
        displayName: 'Runtime Core',
        visibility: 'marketplace',
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const persona = JSON.parse(createPersonaRes.body).data as { id: string; wallet: { id: string } };

    const publishTaskRes = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers,
      payload: {
        title: 'Implement runtime workflow',
        description: 'Create a formal runtime execution loop',
        category: 'coding',
        reward: 150,
      },
    });
    assert.equal(publishTaskRes.statusCode, 201);
    const task = JSON.parse(publishTaskRes.body).data as { id: string };

    const applyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/apply`,
      headers,
      payload: { personaId: persona.id },
    });
    assert.equal(applyRes.statusCode, 202);
    const application = JSON.parse(applyRes.body).data as { id: string; status: string };
    assert.equal(application.status, 'submitted');

    const duplicateApplyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/apply`,
      headers,
      payload: { personaId: persona.id },
    });
    assert.equal(duplicateApplyRes.statusCode, 409);

    const assignRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/assign`,
      headers,
      payload: { personaId: persona.id },
    });
    assert.equal(assignRes.statusCode, 200);
    const assignment = JSON.parse(assignRes.body).data as { id: string; status: string };
    assert.equal(assignment.status, 'assigned');

    const createSessionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/sessions',
      headers,
      payload: { personaId: persona.id, taskId: task.id },
    });
    assert.equal(createSessionRes.statusCode, 201);
    const session = JSON.parse(createSessionRes.body).data as { id: string; state: string };
    assert.equal(session.state, 'PLAN');

    const planRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runtime/sessions/${session.id}/plan`,
      headers,
    });
    assert.equal(planRes.statusCode, 200);
    const planned = JSON.parse(planRes.body).data as { state: string; plan: { steps: string[] } };
    assert.equal(planned.state, 'EXECUTE');
    assert.ok(planned.plan.steps.length >= 3);

    const executeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runtime/sessions/${session.id}/execute`,
      headers,
    });
    assert.equal(executeRes.statusCode, 200);
    const executed = JSON.parse(executeRes.body).data as { state: string; artifacts: Array<{ uri: string }> };
    assert.equal(executed.state, 'EVALUATE');
    assert.ok(executed.artifacts[0]?.uri.includes(session.id));

    const evaluateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runtime/sessions/${session.id}/evaluate`,
      headers,
    });
    assert.equal(evaluateRes.statusCode, 200);
    const evaluated = JSON.parse(evaluateRes.body).data as {
      state: string;
      evaluation: { ready_for_completion: boolean };
    };
    assert.equal(evaluated.state, 'MEMORY_UPDATE');
    assert.equal(evaluated.evaluation.ready_for_completion, true);

    const completeSessionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runtime/sessions/${session.id}/complete`,
      headers,
    });
    assert.equal(completeSessionRes.statusCode, 200);
    const completedSession = JSON.parse(completeSessionRes.body).data as {
      state: string;
      resultSummary: { success: boolean; memory_records_created: number };
    };
    assert.equal(completedSession.state, 'COMPLETED');
    assert.equal(completedSession.resultSummary.success, true);
    assert.equal(completedSession.resultSummary.memory_records_created, 1);

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/submit`,
      headers,
      payload: {
        assignmentId: assignment.id,
        resultUri: `runtime://${session.id}/final.json`,
        evaluation: { summary: 'Formal runtime completed' },
      },
    });
    assert.equal(submitRes.statusCode, 200);
    const submitted = JSON.parse(submitRes.body).data as {
      status: string;
      result: { id: string; status: string };
    };
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.result.status, 'submitted');

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/accept`,
      headers,
      payload: {
        clientRating: 5,
        qualityScore: 0.93,
      },
    });
    assert.equal(acceptRes.statusCode, 200);
    const accepted = JSON.parse(acceptRes.body).data as {
      status: string;
      settlementStatus: string;
      task: { status: string };
      assignment: { status: string };
      result: { status: string };
    };
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.settlementStatus, 'queued');
    assert.equal(accepted.task.status, 'completed');
    assert.equal(accepted.assignment.status, 'accepted');
    assert.equal(accepted.result.status, 'accepted');

    const walletRes = await app.inject({
      method: 'GET',
      url: `/api/v1/wallets/${persona.wallet.id}`,
      headers,
    });
    assert.equal(walletRes.statusCode, 200);
    const wallet = JSON.parse(walletRes.body).data as {
      walletId: string;
      personaId: string;
      balanceMinor: number;
      currency: string;
      status: string;
    };
    assert.equal(wallet.walletId, persona.wallet.id);
    assert.equal(wallet.personaId, persona.id);
    assert.equal(wallet.balanceMinor, 9000);
    assert.equal(wallet.currency, 'CRED');
    assert.equal(wallet.status, 'active');

    const walletTransactionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/wallets/${persona.wallet.id}/transactions`,
      headers,
    });
    assert.equal(walletTransactionsRes.statusCode, 200);
    const walletTransactions = JSON.parse(walletTransactionsRes.body).data as Array<{
      transactionType: string;
      amountMinor: number;
    }>;
    assert.equal(walletTransactions.length, 3);
    assert.equal(walletTransactions.some((item) => item.transactionType === 'task_payment' && item.amountMinor === 15000), true);
    assert.equal(walletTransactions.some((item) => item.transactionType === 'platform_fee' && item.amountMinor === -3000), true);
    assert.equal(walletTransactions.some((item) => item.transactionType === 'persona_reserve' && item.amountMinor === -3000), true);

    const settlementRes = await app.inject({
      method: 'POST',
      url: '/api/v1/wallets/settlements/task',
      headers,
      payload: {
        taskId: task.id,
        assignmentId: assignment.id,
        totalAmountMinor: 15000,
        currency: 'CRED',
        split: {
          ownerPct: 60,
          personaPct: 20,
          platformPct: 20,
        },
      },
    });
    assert.equal(settlementRes.statusCode, 200);
    const settlement = JSON.parse(settlementRes.body).data as { settlementId: string; status: string };
    assert.ok(settlement.settlementId);
    assert.equal(settlement.status, 'completed');

    const payoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/wallets/${persona.wallet.id}/payout`,
      headers,
      payload: {
        amountMinor: 4000,
      },
    });
    assert.equal(payoutRes.statusCode, 200);
    const payout = JSON.parse(payoutRes.body).data as { amountMinor: number; status: string };
    assert.equal(payout.amountMinor, 4000);
    assert.equal(payout.status, 'completed');

    const walletAfterPayoutRes = await app.inject({
      method: 'GET',
      url: `/api/v1/wallets/${persona.wallet.id}`,
      headers,
    });
    assert.equal(walletAfterPayoutRes.statusCode, 200);
    assert.equal(JSON.parse(walletAfterPayoutRes.body).data.balanceMinor, 5000);

    const recomputeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/rankings/recompute?category=coding&limit=5',
      headers,
    });
    assert.equal(recomputeRes.statusCode, 200);
    const recompute = JSON.parse(recomputeRes.body).data as {
      rankings: Array<{ personaId: string }>;
      materialization: { metricDate: string; personaRows: number; marketplaceRows: number };
    };
    assert.equal(recompute.rankings[0]?.personaId, persona.id);
    assert.ok(recompute.materialization.metricDate);
    assert.ok(recompute.materialization.personaRows >= 1);
    assert.equal(recompute.materialization.marketplaceRows, 1);

    const metricDate = recompute.materialization.metricDate;
    const db = os.getDatabase();
    /* 批量分组正确性（P2-b）：daily metric 行存在，且 tasks_completed 正确归属到本 persona */
    const dailyMetric = db.prepare<{ count: number; tasks_completed: number }>(
      'SELECT COUNT(*) as count, MAX(tasks_completed) AS tasks_completed FROM persona_daily_metrics WHERE tenant_id = ? AND persona_id = ? AND metric_date = ?',
    ).get(auth.tenantId, persona.id, metricDate);
    assert.equal(dailyMetric?.count ?? 0, 1);
    assert.ok((dailyMetric?.tasks_completed ?? 0) >= 1, '批量分组应把已完成任务正确计入本 persona');
    assert.equal(
      db.prepare<{ count: number }>(
        'SELECT COUNT(*) as count FROM marketplace_daily_metrics WHERE tenant_id = ? AND metric_date = ?',
      ).get(auth.tenantId, metricDate)?.count ?? 0,
      1,
    );

    const economyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/economy/overview',
      headers,
    });
    assert.equal(economyRes.statusCode, 200);
    const economy = JSON.parse(economyRes.body).data as {
      grossRevenueMinor: number;
      ownerPayoutsMinor: number;
      platformFeesMinor: number;
      personaReservesMinor: number;
      payoutRequests: number;
      settlementCount: number;
      transactionCount: number;
    };
    assert.equal(economy.grossRevenueMinor, 15000);
    assert.equal(economy.ownerPayoutsMinor, 4000);
    assert.equal(economy.platformFeesMinor, 3000);
    assert.equal(economy.personaReservesMinor, 3000);
    assert.equal(economy.payoutRequests, 1);
    assert.equal(economy.settlementCount, 1);
    assert.equal(economy.transactionCount, 4);

    const openCaseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/governance/cases',
      headers,
      payload: {
        personaId: persona.id,
        triggerType: 'fraud_suspected',
        severity: 'high',
        details: { taskId: task.id },
      },
    });
    assert.equal(openCaseRes.statusCode, 201);
    const governanceCase = JSON.parse(openCaseRes.body).data as { id: string; status: string };
    assert.equal(governanceCase.status, 'open');

    const applyActionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/governance/cases/${governanceCase.id}/actions`,
      headers,
      payload: {
        actionType: 'temporary_suspension',
        durationSeconds: 3600,
        details: { reason: 'policy violation' },
      },
    });
    assert.equal(applyActionRes.statusCode, 200);
    const actionResult = JSON.parse(applyActionRes.body).data as { personaStatus: string; actionId: string };
    assert.equal(actionResult.personaStatus, 'suspended');
    assert.ok(actionResult.actionId);

    const listCasesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/personas/${persona.id}/governance/cases`,
      headers,
    });
    assert.equal(listCasesRes.statusCode, 200);
    const cases = JSON.parse(listCasesRes.body).data as Array<{ id: string; status: string }>;
    assert.equal(cases[0]?.id, governanceCase.id);

    const appealRes = await app.inject({
      method: 'POST',
      url: `/api/v1/governance/cases/${governanceCase.id}/appeal`,
      headers,
      payload: {
        details: { reason: 'mitigation completed' },
      },
    });
    assert.equal(appealRes.statusCode, 200);
    assert.equal(JSON.parse(appealRes.body).data.status, 'appealed');

    const personaDetailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${persona.id}`,
      headers,
    });
    assert.equal(personaDetailRes.statusCode, 200);
    assert.equal(JSON.parse(personaDetailRes.body).data.status, 'suspended');
  });

  it('相同 Idempotency-Key 的重复 task create 只会创建一条 marketplace_tasks', async () => {
    const auth = await registerUser('persona-task-idempotency@example.com');
    const headers = authHeaders(auth, {
      'idempotency-key': 'persona-task-create-idem-1',
    });
    const payload = {
      title: 'Idempotent enterprise task',
      description: 'Verify duplicate task creation never creates extra rows',
      category: 'operations',
      reward: 95,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers,
      payload,
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.headers['x-idempotent-replayed'], 'true');

    const firstTask = JSON.parse(first.body).data as { id: string; title: string };
    const secondTask = JSON.parse(second.body).data as { id: string; title: string };
    const count = os.getDatabase().prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM marketplace_tasks WHERE tenant_id = ? AND title = ?',
    ).get(auth.tenantId, payload.title)?.count ?? 0;

    assert.equal(secondTask.id, firstTask.id);
    assert.equal(secondTask.title, payload.title);
    assert.equal(count, 1);
  });

  it('相同 Idempotency-Key 的重复 persona transfer 只会创建一条 transfer 记录', async () => {
    const ownerAuth = await registerUser('persona-transfer-idempotency-owner@example.com');
    const ownerHeaders = authHeaders(ownerAuth, {
      'idempotency-key': 'persona-transfer-idem-1',
    });

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: authHeaders(ownerAuth),
      payload: { displayName: 'Transfer Idempotency Core' },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const persona = JSON.parse(createPersonaRes.body).data as { id: string };

    const targetUserId = 'user_transfer_idem_target';
    const now = Date.now();
    os.getDatabase().prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      targetUserId,
      'persona-transfer-idempotency-target@example.com',
      'hash',
      'member',
      ownerAuth.tenantId,
      now,
      now,
    );

    const payload = {
      toOwnerId: targetUserId,
      reason: 'enterprise ownership handoff',
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${persona.id}/transfer`,
      headers: ownerHeaders,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${persona.id}/transfer`,
      headers: ownerHeaders,
      payload,
    });

    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.equal(second.headers['x-idempotent-replayed'], 'true');

    const firstTransfer = JSON.parse(first.body).data as { id: string; status: string };
    const secondTransfer = JSON.parse(second.body).data as { id: string; status: string };
    const count = os.getDatabase().prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM persona_transfers WHERE tenant_id = ? AND persona_id = ?',
    ).get(ownerAuth.tenantId, persona.id)?.count ?? 0;

    assert.equal(secondTransfer.id, firstTransfer.id);
    assert.equal(secondTransfer.status, 'pending_review');
    assert.equal(count, 1);
  });

  it('相同 Idempotency-Key 的重复 settlement 请求只会落一组账本分录', async () => {
    const auth = await registerUser('persona-settlement-idempotency@example.com');

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: authHeaders(auth),
      payload: {
        displayName: 'Settlement Idempotency Core',
        visibility: 'marketplace',
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const persona = JSON.parse(createPersonaRes.body).data as { id: string };

    const publishTaskRes = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers: authHeaders(auth),
      payload: {
        title: 'Settlement idempotency task',
        description: 'Ensure duplicate settlement requests do not duplicate ledger rows',
        category: 'operations',
        reward: 150,
      },
    });
    assert.equal(publishTaskRes.statusCode, 201);
    const task = JSON.parse(publishTaskRes.body).data as { id: string };

    const applyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/apply`,
      headers: authHeaders(auth),
      payload: { personaId: persona.id },
    });
    assert.equal(applyRes.statusCode, 202);

    const assignRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/assign`,
      headers: authHeaders(auth),
      payload: { personaId: persona.id },
    });
    assert.equal(assignRes.statusCode, 200);
    const assignment = JSON.parse(assignRes.body).data as { id: string };

    const settlementHeaders = authHeaders(auth, {
      'idempotency-key': 'wallet-settlement-idem-1',
    });
    const settlementPayload = {
      taskId: task.id,
      assignmentId: assignment.id,
      totalAmountMinor: 15000,
      currency: 'CRED',
      split: {
        ownerPct: 60,
        personaPct: 20,
        platformPct: 20,
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/wallets/settlements/task',
      headers: settlementHeaders,
      payload: settlementPayload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/wallets/settlements/task',
      headers: settlementHeaders,
      payload: settlementPayload,
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['x-idempotent-replayed'], 'true');

    const firstSettlement = JSON.parse(first.body).data as { settlementId: string; status: string };
    const secondSettlement = JSON.parse(second.body).data as { settlementId: string; status: string };
    const settlementCount = os.getDatabase().prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM wallet_settlements WHERE tenant_id = ? AND assignment_id = ?',
    ).get(auth.tenantId, assignment.id)?.count ?? 0;
    const ledgerEntryCount = os.getDatabase().prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM wallet_transactions
       WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?`,
    ).get(auth.tenantId, firstSettlement.settlementId)?.count ?? 0;

    assert.equal(secondSettlement.settlementId, firstSettlement.settlementId);
    assert.equal(secondSettlement.status, 'completed');
    assert.equal(settlementCount, 1);
    assert.equal(ledgerEntryCount, 3);
  });

  it('persona transfer 在同租户用户之间可请求、审批并完成所有权切换', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-transfer-owner@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const ownerAuth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string; userId: string };

    const ownerHeaders = {
      authorization: `Bearer ${ownerAuth.accessToken}`,
      'x-tenant-id': ownerAuth.tenantId,
    };

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: ownerHeaders,
      payload: { displayName: 'Transferable Core' },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const createdPersona = JSON.parse(createPersonaRes.body).data as { id: string };

    const targetPassword = 'password456';
    const targetHash = await hash(targetPassword);
    const now = Date.now();
    const targetUserId = 'user_transfer_target';
    os.getDatabase().prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(targetUserId, 'persona-transfer-target@example.com', targetHash, 'member', ownerAuth.tenantId, now, now);

    const targetLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'persona-transfer-target@example.com', password: targetPassword },
    });
    assert.equal(targetLoginRes.statusCode, 200);
    const targetAuth = JSON.parse(targetLoginRes.body).data as { accessToken: string };
    const targetHeaders = {
      authorization: `Bearer ${targetAuth.accessToken}`,
      'x-tenant-id': ownerAuth.tenantId,
    };

    const requestTransferRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/transfer`,
      headers: ownerHeaders,
      payload: {
        toOwnerId: targetUserId,
        reason: 'asset sale',
      },
    });
    assert.equal(requestTransferRes.statusCode, 202);
    const requestedTransfer = JSON.parse(requestTransferRes.body).data as { id: string; status: string };
    assert.equal(requestedTransfer.status, 'pending_review');

    const transfersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${createdPersona.id}/transfers`,
      headers: ownerHeaders,
    });
    assert.equal(transfersRes.statusCode, 200);
    const transfers = JSON.parse(transfersRes.body).data as Array<{ id: string; status: string }>;
    assert.equal(transfers[0]?.id, requestedTransfer.id);

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${createdPersona.id}/transfers/approve`,
      headers: targetHeaders,
      payload: { transferId: requestedTransfer.id },
    });
    assert.equal(approveRes.statusCode, 200);
    const approved = JSON.parse(approveRes.body).data as {
      transfer: { status: string };
      persona: { ownerUserId: string; status: string };
    };
    assert.equal(approved.transfer.status, 'completed');
    assert.equal(approved.persona.ownerUserId, targetUserId);
    assert.equal(approved.persona.status, 'active');
  });

  it('提供 v1 persona memory alias、search、graph 与 POST /api/v1/memories 契约', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-memory-v1@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string };

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/personas',
      headers,
      payload: {
        displayName: 'Memory Alias Persona',
        profile: { role: 'operator' },
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const persona = JSON.parse(createPersonaRes.body).data as { id: string };

    const profileRes = await app.inject({
      method: 'GET',
      url: `/api/v1/personas/${persona.id}/profile`,
      headers,
    });
    assert.equal(profileRes.statusCode, 200);
    assert.equal(JSON.parse(profileRes.body).data.profile.role, 'operator');

    const createMemoryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      headers,
      payload: {
        personaId: persona.id,
        memoryType: 'task_outcome',
        contentText: 'Built a stable Podman regression harness',
        sourceType: 'task_result',
        sourceId: 'tr_memory_contract',
        sensitivity: 'private',
      },
    });
    assert.equal(createMemoryRes.statusCode, 201);
    const createdMemory = JSON.parse(createMemoryRes.body).data as { memoryId: string; personaId: string; memoryType: string };
    assert.equal(createdMemory.personaId, persona.id);
    assert.equal(createdMemory.memoryType, 'task_outcome');

    const listMemoriesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/personas/${persona.id}/memories?limit=10`,
      headers,
    });
    assert.equal(listMemoriesRes.statusCode, 200);
    const memories = JSON.parse(listMemoriesRes.body).data as Array<{ id: string; summary: string }>;
    assert.equal(memories[0]?.id, createdMemory.memoryId);
    assert.equal(memories[0]?.summary, 'Built a stable Podman regression harness');

    const searchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/personas/${persona.id}/memories/search`,
      headers,
      payload: {
        query: 'Podman regression harness',
        limit: 5,
      },
    });
    assert.equal(searchRes.statusCode, 200);
    const searchResults = JSON.parse(searchRes.body).data as Array<{ memoryId: string; score: number }>;
    assert.equal(searchResults[0]?.memoryId, createdMemory.memoryId);
    assert.ok((searchResults[0]?.score ?? 0) > 0);

    const graphRes = await app.inject({
      method: 'GET',
      url: `/api/v1/personas/${persona.id}/graph`,
      headers,
    });
    assert.equal(graphRes.statusCode, 200);
    const graph = JSON.parse(graphRes.body).data as { totalNodes: number; totalEdges: number };
    assert.ok(graph.totalNodes >= 1);
    assert.ok(graph.totalEdges >= 0);

    const graphQueryRes = await app.inject({
      method: 'POST',
      url: `/api/v1/personas/${persona.id}/graph/query`,
      headers,
      payload: {
        kind: 'episodic',
        limit: 10,
      },
    });
    assert.equal(graphQueryRes.statusCode, 200);
    const graphQuery = JSON.parse(graphQueryRes.body).data as { nodes: Array<{ sourceMemoryId: string | null }> };
    assert.ok(graphQuery.nodes.length >= 1);
    assert.equal(graphQuery.nodes[0]?.sourceMemoryId, createdMemory.memoryId);
  });

  it('关键 Persona Core 敏感动作会写入业务审计日志并支持查询详情', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'persona-audit@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as { accessToken: string; tenantId: string };

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const now = Date.now();
    os.getDatabase().prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_transfer_target', 'transfer-target@example.com', 'hash', 'member', auth.tenantId, now, now);

    const createPersonaRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers,
      payload: {
        displayName: 'Audit Persona',
        visibility: 'marketplace',
      },
    });
    assert.equal(createPersonaRes.statusCode, 201);
    const persona = JSON.parse(createPersonaRes.body).data as { id: string };

    const transferRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${persona.id}/transfer`,
      headers,
      payload: {
        toOwnerId: 'user_transfer_target',
        reason: 'portfolio handoff',
      },
    });
    assert.equal(transferRes.statusCode, 202);

    const publishTaskRes = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/tasks',
      headers,
      payload: {
        title: 'Generate audit evidence',
        description: 'Exercise business audit paths',
        category: 'operations',
        reward: 120,
      },
    });
    assert.equal(publishTaskRes.statusCode, 201);
    const task = JSON.parse(publishTaskRes.body).data as { id: string };

    const applyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/apply`,
      headers,
      payload: { personaId: persona.id },
    });
    assert.equal(applyRes.statusCode, 202);

    const assignRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/assign`,
      headers,
      payload: { personaId: persona.id },
    });
    assert.equal(assignRes.statusCode, 200);
    const assignment = JSON.parse(assignRes.body).data as { id: string };

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/submit`,
      headers,
      payload: {
        assignmentId: assignment.id,
        resultUri: 'runtime://audit/final.json',
        evaluation: { summary: 'audit complete' },
      },
    });
    assert.equal(submitRes.statusCode, 200);

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/accept`,
      headers,
      payload: {
        clientRating: 5,
        qualityScore: 0.9,
      },
    });
    assert.equal(acceptRes.statusCode, 200);

    const caseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/governance/cases',
      headers,
      payload: {
        personaId: persona.id,
        triggerType: 'policy_review',
        severity: 'medium',
        details: { source: 'audit_test' },
      },
    });
    assert.equal(caseRes.statusCode, 201);
    const governanceCase = JSON.parse(caseRes.body).data as { id: string };

    const actionRes = await app.inject({
      method: 'POST',
      url: `/api/v1/governance/cases/${governanceCase.id}/actions`,
      headers,
      payload: {
        actionType: 'warning',
        details: { reason: 'audit validation' },
      },
    });
    assert.equal(actionRes.statusCode, 200);

    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/logs?eventKind=business&page=1&pageSize=100',
      headers,
    });
    assert.equal(auditRes.statusCode, 200);
    const auditBody = JSON.parse(auditRes.body) as {
      data: Array<{ id: string; actionType: string; targetType: string; payload: Record<string, unknown> | null }>;
    };
    const actionTypes = new Set(auditBody.data.map((item) => item.actionType));
    assert.equal(actionTypes.has('persona.create'), true);
    assert.equal(actionTypes.has('persona.transfer.requested'), true);
    assert.equal(actionTypes.has('task.assignment'), true);
    assert.equal(actionTypes.has('task.submission'), true);
    assert.equal(actionTypes.has('task.acceptance'), true);
    assert.equal(actionTypes.has('wallet.settlement'), true);
    assert.equal(actionTypes.has('governance.case.opened'), true);
    assert.equal(actionTypes.has('governance.action'), true);

    const governanceAudit = auditBody.data.find((item) => item.actionType === 'governance.action');
    assert.ok(governanceAudit);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/audit/logs/${governanceAudit!.id}`,
      headers,
    });
    assert.equal(detailRes.statusCode, 200);
    const detail = JSON.parse(detailRes.body).data as {
      actionType: string;
      targetType: string;
      payload: { actionType: string };
    };
    assert.equal(detail.actionType, 'governance.action');
    assert.equal(detail.targetType, 'governance_action');
    assert.equal(detail.payload.actionType, 'warning');
  });

  it('非所有者不得对他人 persona 开治理案（越权防御 P1）', async () => {
    /* 用户 A 创建一个 persona */
    const ownerAuth = await registerUser('gov-owner@example.com');
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: authHeaders(ownerAuth),
      payload: { displayName: 'Owned Core', visibility: 'marketplace' },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const persona = JSON.parse(createRes.body).data as { id: string };

    /* 攻击者 B（不同账户/租户）尝试对 A 的 persona 开治理案 → 必须被拦（404，不泄露存在性） */
    const attackerAuth = await registerUser('gov-attacker@example.com');
    const attackRes = await app.inject({
      method: 'POST',
      url: '/api/v1/governance/cases',
      headers: authHeaders(attackerAuth),
      payload: {
        personaId: persona.id,
        triggerType: 'fraud_suspected',
        severity: 'high',
        details: { reason: 'malicious open' },
      },
    });
    assert.equal(attackRes.statusCode, 404, '非所有者开案应被拒绝');

    /* owner 本人仍可正常开案 */
    const ownerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/governance/cases',
      headers: authHeaders(ownerAuth),
      payload: {
        personaId: persona.id,
        triggerType: 'fraud_suspected',
        severity: 'high',
        details: { reason: 'legit owner review' },
      },
    });
    assert.equal(ownerRes.statusCode, 201, ownerRes.body);
  });
});
