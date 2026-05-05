/**
 * 计费 API 集成测试
 * 覆盖 plans / usage / checkout 验证 / webhook 验证
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { FastifyInstance } from 'fastify';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('计费 API 集成测试', () => {
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

  describe('GET /api/v1/billing/plans', () => {
    it('返回所有可用计划', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/plans',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length >= 1);
      assert.ok(body.data[0].id);
      assert.ok(body.data[0].name);
      assert.ok(body.data[0].limits);
      assert.equal(typeof body.data[0].priceMinor, 'number');
      assert.equal(typeof body.data[0].currency, 'string');
      assert.equal(typeof body.data[0].billingInterval, 'string');
    });
  });

  describe('GET /api/v1/billing/usage', () => {
    it('注册用户获取用量信息', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'billing@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/usage',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-tenant-id': tenantId,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.planId, 'free');
      assert.equal(body.data.status, 'active');
      assert.ok(body.data.limits);
      assert.ok(body.data.usage !== undefined);
    });
  });

  describe('POST /api/v1/billing/subscribe', () => {
    it('本地模式可直接切换订阅并生成 invoice', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'subscribe@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data as {
        accessToken: string;
        tenantId: string;
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscribe',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-tenant-id': tenantId,
        },
        payload: { planId: 'starter' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.subscription.planId, 'starter');
      assert.equal(body.data.subscription.status, 'active');
      assert.equal(body.data.invoice.planId, 'starter');
      assert.equal(body.data.invoice.amountMinor, 9900);
      assert.equal(body.data.invoice.currency, 'USD');
      assert.equal(body.data.invoice.status, 'open');
    });
  });

  describe('GET /api/v1/billing/invoices', () => {
    it('发票返回 usage meter 与 wallet ledger 对账摘要', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'invoice@example.com', password: 'password123' },
      });
      const auth = JSON.parse(regRes.body).data as {
        userId: string;
        accessToken: string;
        tenantId: string;
      };

      const tx = directUnitOfWork(os.getDatabase());
      const usageTracker = new UsageTracker(tx);
      usageTracker.record(auth.tenantId, 'llm_tokens', 1200);
      usageTracker.record(auth.tenantId, 'simulation', 2);

      const personaService = new PersonaCoreService(tx);
      const persona = personaService.createPersona({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        displayName: 'Billing Persona',
      });
      const task = personaService.publishTask({
        tenantId: auth.tenantId,
        publisherUserId: auth.userId,
        title: 'Invoice Reconciliation Task',
        description: 'Generate settlement rows for invoice reconciliation',
        reward: 150,
      });
      const application = personaService.applyToTask({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        taskId: task.id,
        personaId: persona.id,
      });
      const assignment = personaService.assignTask({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        personaId: persona.id,
      });
      assert.ok(application);
      assert.ok(assignment);

      const result = personaService.submitTaskResult({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        taskId: task.id,
        assignmentId: assignment!.id,
        resultUri: 'memory://billing/result.json',
        evaluation: { summary: 'billing invoice reconciliation' },
      });
      assert.ok(result);

      const accepted = personaService.acceptSubmittedTask({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        clientRating: 5,
        qualityScore: 0.95,
      });
      assert.ok(accepted);

      const settlement = personaService.settleTaskPayment({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        assignmentId: assignment!.id,
        totalAmountMinor: 15000,
        currency: 'CRED',
        split: {
          ownerPct: 60,
          personaPct: 20,
          platformPct: 20,
        },
      });
      assert.ok(settlement);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/invoices',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          'x-tenant-id': auth.tenantId,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].planId, 'free');
      assert.equal(body.data[0].usageSummary.llm_tokens, 1200);
      assert.equal(body.data[0].usageSummary.simulation, 2);
      assert.equal(body.data[0].reconciliation.walletSettlementCount, 1);
      assert.equal(body.data[0].reconciliation.walletSettlementTotalMinor, 15000);
      assert.equal(body.data[0].reconciliation.status, 'balanced');
    });
  });

  describe('POST /api/v1/billing/reconciliation/run', () => {
    it('可修复重复 settlement ledger transaction 并记录运行结果', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'reconcile@example.com', password: 'password123' },
      });
      const auth = JSON.parse(regRes.body).data as {
        userId: string;
        accessToken: string;
        tenantId: string;
      };

      const db = os.getDatabase();
      const personaService = new PersonaCoreService(directUnitOfWork(db));
      const persona = personaService.createPersona({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        displayName: 'Reconciliation Persona',
      });
      const task = personaService.publishTask({
        tenantId: auth.tenantId,
        publisherUserId: auth.userId,
        title: 'Duplicate Ledger Task',
        description: 'Create a settlement and then duplicate ledger rows',
        reward: 100,
      });
      const application = personaService.applyToTask({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        taskId: task.id,
        personaId: persona.id,
      });
      const assignment = personaService.assignTask({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        personaId: persona.id,
      });
      assert.ok(application);
      assert.ok(assignment);

      personaService.submitTaskResult({
        tenantId: auth.tenantId,
        ownerUserId: auth.userId,
        taskId: task.id,
        assignmentId: assignment!.id,
        resultUri: 'memory://billing/reconcile.json',
        evaluation: { summary: 'reconciliation test' },
      });
      personaService.acceptSubmittedTask({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        clientRating: 5,
        qualityScore: 0.9,
      });
      const settlement = personaService.settleTaskPayment({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        taskId: task.id,
        assignmentId: assignment!.id,
        totalAmountMinor: 12000,
        currency: 'CRED',
        split: {
          ownerPct: 60,
          personaPct: 20,
          platformPct: 20,
        },
      });
      assert.ok(settlement);

      db.prepare<void>(
        `INSERT INTO wallet_transactions (
          id, tenant_id, wallet_id, transaction_type, amount_minor, currency, reference_type, reference_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'wtx_duplicate_settlement',
        auth.tenantId,
        persona.wallet.id,
        'task_payment',
        settlement!.totalAmountMinor,
        settlement!.currency,
        'wallet_settlement',
        settlement!.id,
        Date.now(),
      );

      const preCount = db.prepare<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM wallet_transactions
         WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?`,
      ).get(auth.tenantId, settlement!.id)?.count;
      assert.equal(preCount, 4);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/reconciliation/run',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          'x-tenant-id': auth.tenantId,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.checkedSettlements, 1);
      assert.equal(body.data.mismatchedSettlements, 1);
      assert.equal(body.data.repairedSettlements, 1);
      assert.equal(body.data.deletedTransactions, 4);
      assert.equal(body.data.insertedTransactions, 3);
      assert.deepEqual(body.data.mismatchedSettlementIds, [settlement!.id]);

      const postRows = db.prepare<{ transaction_type: string; amount_minor: number }>(
        `SELECT transaction_type, amount_minor
         FROM wallet_transactions
         WHERE tenant_id = ? AND reference_type = 'wallet_settlement' AND reference_id = ?
         ORDER BY transaction_type ASC`,
      ).all(auth.tenantId, settlement!.id).map((row) => ({
        transaction_type: row.transaction_type,
        amount_minor: row.amount_minor,
      }));
      assert.deepEqual(postRows, [
        { transaction_type: 'persona_reserve', amount_minor: -settlement!.personaAmountMinor },
        { transaction_type: 'platform_fee', amount_minor: -settlement!.platformAmountMinor },
        { transaction_type: 'task_payment', amount_minor: settlement!.totalAmountMinor },
      ]);

      const runsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/reconciliation/runs',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          'x-tenant-id': auth.tenantId,
        },
      });
      assert.equal(runsRes.statusCode, 200);
      const runsBody = JSON.parse(runsRes.body);
      assert.equal(runsBody.data.length, 1);
      assert.equal(runsBody.data[0].repairedSettlements, 1);
    });
  });

  describe('POST /api/v1/billing/checkout（Stripe 未启用时）', () => {
    it('Stripe 未启用时 checkout 返回错误响应', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'checkout@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId },
        payload: { priceId: 'price_xxx', successUrl: '/success', cancelUrl: '/cancel' },
      });
      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'StateError');
      assert.match(body.message, /Stripe 计费未启用/);
    });
  });

  describe('POST /api/v1/billing/portal（Stripe 未启用时）', () => {
    it('Stripe 未启用时 portal 返回错误响应', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'portal@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId },
        payload: { returnUrl: '/billing' },
      });
      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'StateError');
      assert.match(body.message, /Stripe 计费未启用/);
    });
  });

  describe('POST /api/v1/billing/webhook（Stripe 未启用时）', () => {
    it('Stripe 未启用时 webhook 返回 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        payload: {},
      });
      assert.equal(res.statusCode, 404);
    });
  });
});
