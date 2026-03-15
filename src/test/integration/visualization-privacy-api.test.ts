import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { IdentityService } from '../../identity/identity-service.js';
import { FieldEncryption } from '../../storage/encryption.js';
import type { FastifyInstance } from 'fastify';

describe('可视化与隐私 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
  });

  describe('GET /api/v1/values/visualization', () => {
    it('无价值时返回空节点和边', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.nodes.length, 0);
      assert.equal(body.data.edges.length, 0);
      assert.equal(body.data.layout, 'radial');
    });

    it('有价值时返回节点', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addValue('勇气', 0.6);

      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.nodes.length, 2);
      assert.ok(body.data.nodes.some((n: { label: string }) => n.label === '诚信'));
    });

    it('共现记忆产生边', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addValue('勇气', 0.6);
      /* 添加一条同时提到两个价值的记忆 */
      os.core.addMemory('episodic', '展现诚信和勇气的时刻', 0.5, 0.5);

      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      const body = JSON.parse(res.body);
      assert.ok(body.data.edges.length > 0);
      assert.equal(body.data.edges[0].weight, 1); /* 唯一的共现，权重为1 */
    });
  });

  describe('GET /api/v1/decisions/:id/fingerprint', () => {
    it('返回决策指纹信息', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/decisions/dec_test/fingerprint' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.caseId, 'dec_test');
    });
  });

  describe('POST /api/v1/privacy/export', () => {
    it('导出所有数据', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addMemory('episodic', '测试记忆', 0.5, 0.5);
      const db = os.getDatabase();
      const now = Date.now();
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('user_privacy_export', 'privacy-export@example.com', 'hash', 'admin', 'default', now, now);
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('user_privacy_export_target', 'privacy-export-target@example.com', 'hash', 'member', 'default', now, now);
      const identityService = new IdentityService(db);
      const identity = identityService.ensureForUser('user_privacy_export', 'default', 'privacy-export');
      const defaultAvatar = db.prepare<{ id: string }>(
        'SELECT id FROM avatars WHERE identity_id = ? AND is_default = 1 LIMIT 1',
      ).get(identity.id);
      assert.ok(defaultAvatar);
      db.prepare<void>(
        `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('dev_privacy_export', 'default', 'user_privacy_export', 'privacy-export-device', 'web', 'push-export', '1.0.0', now, now);
      db.prepare<void>(
        `INSERT INTO device_avatars (id, device_id, avatar_id, is_active, installed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('dav_privacy_export', 'dev_privacy_export', defaultAvatar.id, 1, now);
      db.prepare<void>(
        `INSERT INTO organizations (id, tenant_id, name, slug, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('org_privacy_export', 'default', 'Privacy Export Org', 'privacy-export-org', 'user_privacy_export', now, now);
      db.prepare<void>(
        `INSERT INTO workspaces (id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('ws_privacy_export', 'default', 'org_privacy_export', 'Default Workspace', 'default-workspace', 1, now, now);
      db.prepare<void>(
        `INSERT INTO organization_memberships (id, tenant_id, organization_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('orgm_privacy_export', 'default', 'org_privacy_export', 'user_privacy_export', 'active', now, now);
      db.prepare<void>(
        `INSERT INTO organization_role_bindings (id, tenant_id, organization_id, workspace_id, membership_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('orgrole_privacy_export', 'default', 'org_privacy_export', null, 'orgm_privacy_export', 'org_admin', now);
      db.prepare<void>(
        `INSERT INTO subscriptions (
          id, tenant_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
          current_period_start, current_period_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('sub_privacy_export', 'default', null, null, 'pro', 'active', now, now + 30 * 24 * 60 * 60 * 1000, now, now);
      db.prepare<void>(
        `INSERT INTO billing_invoices (
          id, tenant_id, subscription_id, plan_id, status, amount_minor, currency, billing_interval,
          period_start, period_end, wallet_settlement_count, wallet_settlement_total_minor,
          reconciliation_status, created_at, updated_at, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('inv_privacy_export', 'default', 'sub_privacy_export', 'pro', 'open', 4900, 'USD', 'month', now, now + 30 * 24 * 60 * 60 * 1000, 1, 2500, 'balanced', now, now, null);
      db.prepare<void>(
        `INSERT INTO usage_meters (id, tenant_id, resource, period_start, period_end, total_quantity, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('meter_privacy_export', 'default', 'llm_tokens', now, now + 30 * 24 * 60 * 60 * 1000, 1200, now);
      db.prepare<void>(
        `INSERT INTO settlement_reconciliation_runs (
          id, tenant_id, checked_settlements, mismatched_settlements, repaired_settlements,
          deleted_transactions, inserted_transactions, orphan_transactions_removed,
          report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('recon_privacy_export', 'default', 1, 0, 0, 0, 0, 0, JSON.stringify({ mismatchedSettlementIds: [] }), now);
      const personaService = new PersonaCoreService(db);
      const persona = personaService.createPersona({
        tenantId: 'default',
        ownerUserId: 'user_privacy_export',
        displayName: 'Privacy Persona',
        initialKnowledge: [{ title: 'Seed', content: 'Export me' }],
      });
      personaService.createFork({
        tenantId: 'default',
        ownerUserId: 'user_privacy_export',
        personaId: persona.id,
        label: 'Privacy Fork',
      });
      const task = personaService.publishTask({
        tenantId: 'default',
        publisherUserId: 'user_privacy_export',
        title: 'Privacy Task',
        description: 'Make sure export contains marketplace rows',
        reward: 25,
      });
      const application = personaService.applyToTask({
        tenantId: 'default',
        ownerUserId: 'user_privacy_export',
        taskId: task.id,
        personaId: persona.id,
      });
      const assignment = personaService.assignTask({
        tenantId: 'default',
        actorUserId: 'user_privacy_export',
        taskId: task.id,
        personaId: persona.id,
      });
      assert.ok(application);
      assert.ok(assignment);
      personaService.submitTaskResult({
        tenantId: 'default',
        ownerUserId: 'user_privacy_export',
        taskId: task.id,
        assignmentId: assignment!.id,
        resultUri: 'memory://privacy-export/result.json',
        evaluation: { summary: 'privacy export flow' },
      });
      personaService.acceptSubmittedTask({
        tenantId: 'default',
        actorUserId: 'user_privacy_export',
        taskId: task.id,
        clientRating: 5,
        qualityScore: 0.9,
      });
      personaService.requestWalletPayout({
        tenantId: 'default',
        ownerUserId: 'user_privacy_export',
        walletId: persona.wallet.id,
        amountMinor: 500,
      });
      db.prepare<void>(
        `INSERT INTO persona_transfers (
          id, tenant_id, persona_id, from_owner_user_id, to_owner_user_id, status, reason, requested_at, approved_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('ptr_export', 'default', persona.id, 'user_privacy_export', 'user_privacy_export_target', 'completed', 'privacy export', now, now, now);
      db.prepare<void>(
        `INSERT INTO persona_daily_metrics (
          tenant_id, persona_id, metric_date, tasks_completed, revenue, reputation_score, growth_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('default', persona.id, '2026-03-13', 1, 25, 55, 1.2);
      db.prepare<void>(
        `INSERT INTO marketplace_daily_metrics (
          tenant_id, metric_date, open_tasks, completed_tasks, gross_volume, active_personas
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('default', '2026-03-13', 0, 1, 25, 1);

      const res = await app.inject({ method: 'POST', url: '/api/v1/privacy/export' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.exportId.startsWith('exp_'));
      assert.equal(body.data.format, 'json');
      assert.ok(body.data.content.persona);
      assert.ok(body.data.exportedAt);
      assert.ok(body.data.tenantId);
      assert.ok(Array.isArray(body.data.content.tables.persona_core));
      assert.ok(Array.isArray(body.data.content.tables.persona_wallets));
      assert.ok(Array.isArray(body.data.content.tables.persona_forks));
      assert.ok(Array.isArray(body.data.content.tables.persona_memory_nodes));
      assert.ok(Array.isArray(body.data.content.tables.persona_memory_edges));
      assert.ok(Array.isArray(body.data.content.tables.persona_working_memory));
      assert.ok(Array.isArray(body.data.content.tables.persona_memories));
      assert.ok(Array.isArray(body.data.content.tables.persona_knowledge_items));
      assert.ok(Array.isArray(body.data.content.tables.marketplace_tasks));
      assert.ok(Array.isArray(body.data.content.tables.task_applications));
      assert.ok(Array.isArray(body.data.content.tables.task_assignments));
      assert.ok(Array.isArray(body.data.content.tables.task_results));
      assert.ok(Array.isArray(body.data.content.tables.wallet_transactions));
      assert.ok(Array.isArray(body.data.content.tables.wallet_payout_requests));
      assert.ok(Array.isArray(body.data.content.tables.wallet_settlements));
      assert.ok(Array.isArray(body.data.content.tables.persona_growth_events));
      assert.ok(Array.isArray(body.data.content.tables.persona_governance_events));
      assert.ok(Array.isArray(body.data.content.tables.persona_transfers));
      assert.ok(Array.isArray(body.data.content.tables.reputation_history));
      assert.ok(Array.isArray(body.data.content.tables.persona_daily_metrics));
      assert.ok(Array.isArray(body.data.content.tables.marketplace_daily_metrics));
      assert.ok(Array.isArray(body.data.content.tables.organizations));
      assert.ok(Array.isArray(body.data.content.tables.workspaces));
      assert.ok(Array.isArray(body.data.content.tables.organization_memberships));
      assert.ok(Array.isArray(body.data.content.tables.organization_role_bindings));
      assert.ok(Array.isArray(body.data.content.tables.subscriptions));
      assert.ok(Array.isArray(body.data.content.tables.billing_invoices));
      assert.ok(Array.isArray(body.data.content.tables.usage_meters));
      assert.ok(Array.isArray(body.data.content.tables.settlement_reconciliation_runs));
      assert.ok(Array.isArray(body.data.content.tables.identities));
      assert.ok(Array.isArray(body.data.content.tables.avatars));
      assert.ok(Array.isArray(body.data.content.tables.devices));
      assert.ok(Array.isArray(body.data.content.tables.device_avatars));
    });

    it('开启加密时导出会解密 persona memory 与认知节点内容', async () => {
      const masterKey = randomBytes(32).toString('base64');
      const encryptedConfig = loadConfig({
        rateLimit: { max: 10000, timeWindowMs: 60_000 },
        websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
        intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
        encryption: { enabled: true, masterKey, keyRotationIntervalDays: 90 },
      });
      const encryptedOs = new ChronoSynthOS({
        clock: new TestClock(2000),
        logger: new SilentLogger(),
        encryptionConfig: encryptedConfig.encryption,
      });
      encryptedOs.start();
      const encryptedApp = await createApp({ os: encryptedOs, config: encryptedConfig });

      try {
        const db = encryptedOs.getDatabase();
        const encryption = new FieldEncryption(encryptedConfig.encryption);
        const personaService = new PersonaCoreService(db, encryption);
        const now = Date.now();
        db.prepare<void>(
          `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('user_privacy_encrypted', 'privacy-encrypted@example.com', 'hash', 'admin', 'default', now, now);

        const persona = personaService.createPersona({
          tenantId: 'default',
          ownerUserId: 'user_privacy_encrypted',
          displayName: 'Encrypted Privacy Persona',
        });

        const memory = personaService.addMemory({
          tenantId: 'default',
          ownerUserId: 'user_privacy_encrypted',
          personaId: persona.id,
          kind: 'interaction',
          sensitivity: 'encrypted',
          summary: 'Encrypted export summary',
          content: { note: 'decrypt me in privacy export' },
          importance: 0.88,
        });
        assert.ok(memory);

        const raw = db.prepare<{ summary: string; content_json: string }>(
          'SELECT summary, content_json FROM persona_memories WHERE tenant_id = ? AND id = ?',
        ).get('default', memory!.id);
        assert.ok(raw);
        assert.notEqual(raw?.summary, 'Encrypted export summary');
        assert.notEqual(raw?.content_json, JSON.stringify({ note: 'decrypt me in privacy export' }));

        const exportRes = await encryptedApp.inject({ method: 'POST', url: '/api/v1/privacy/export' });
        assert.equal(exportRes.statusCode, 200);
        const body = JSON.parse(exportRes.body);
        const exportedMemory = (body.data.content.tables.persona_memories as Array<Record<string, unknown>>)
          .find((item) => item.id === memory!.id);
        assert.ok(exportedMemory);
        assert.equal(exportedMemory?.summary, 'Encrypted export summary');
        assert.equal(exportedMemory?.content_json, JSON.stringify({ note: 'decrypt me in privacy export' }));

        const exportedCognitiveNode = (body.data.content.tables.persona_memory_nodes as Array<Record<string, unknown>>)
          .find((item) => item.source_memory_id === memory!.id);
        assert.ok(exportedCognitiveNode);
        assert.equal(typeof exportedCognitiveNode?.content, 'string');
        assert.match(String(exportedCognitiveNode?.content), /Encrypted export summary/);
      } finally {
        await encryptedApp.close();
        encryptedOs.close();
      }
    });
  });

  describe('DELETE /api/v1/privacy/data', () => {
    it('删除所有数据', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addMemory('episodic', '测试记忆', 0.5, 0.5);
      assert.equal(os.core.values.getAll().size, 1);
      const db = os.getDatabase();
      const now = Date.now();
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('user_privacy_delete', 'privacy-delete@example.com', 'hash', 'admin', 'default', now, now);
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('user_privacy_delete_target', 'privacy-delete-target@example.com', 'hash', 'member', 'default', now, now);
      const identityService = new IdentityService(db);
      const identity = identityService.ensureForUser('user_privacy_delete', 'default', 'privacy-delete');
      const defaultAvatar = db.prepare<{ id: string }>(
        'SELECT id FROM avatars WHERE identity_id = ? AND is_default = 1 LIMIT 1',
      ).get(identity.id);
      assert.ok(defaultAvatar);
      db.prepare<void>(
        `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('dev_privacy_delete', 'default', 'user_privacy_delete', 'privacy-delete-device', 'ios', 'push-delete', '1.0.0', now, now);
      db.prepare<void>(
        `INSERT INTO device_avatars (id, device_id, avatar_id, is_active, installed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('dav_privacy_delete', 'dev_privacy_delete', defaultAvatar.id, 1, now);
      db.prepare<void>(
        `INSERT INTO organizations (id, tenant_id, name, slug, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('org_privacy_delete', 'default', 'Privacy Delete Org', 'privacy-delete-org', 'user_privacy_delete', now, now);
      db.prepare<void>(
        `INSERT INTO workspaces (id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('ws_privacy_delete', 'default', 'org_privacy_delete', 'Default Workspace', 'default-workspace', 1, now, now);
      db.prepare<void>(
        `INSERT INTO organization_memberships (id, tenant_id, organization_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('orgm_privacy_delete', 'default', 'org_privacy_delete', 'user_privacy_delete', 'active', now, now);
      db.prepare<void>(
        `INSERT INTO organization_role_bindings (id, tenant_id, organization_id, workspace_id, membership_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('orgrole_privacy_delete', 'default', 'org_privacy_delete', null, 'orgm_privacy_delete', 'org_admin', now);
      db.prepare<void>(
        `INSERT INTO subscriptions (
          id, tenant_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
          current_period_start, current_period_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('sub_privacy_delete', 'default', null, null, 'pro', 'active', now, now + 30 * 24 * 60 * 60 * 1000, now, now);
      db.prepare<void>(
        `INSERT INTO billing_invoices (
          id, tenant_id, subscription_id, plan_id, status, amount_minor, currency, billing_interval,
          period_start, period_end, wallet_settlement_count, wallet_settlement_total_minor,
          reconciliation_status, created_at, updated_at, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('inv_privacy_delete', 'default', 'sub_privacy_delete', 'pro', 'open', 4900, 'USD', 'month', now, now + 30 * 24 * 60 * 60 * 1000, 1, 1500, 'balanced', now, now, null);
      db.prepare<void>(
        `INSERT INTO usage_meters (id, tenant_id, resource, period_start, period_end, total_quantity, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('meter_privacy_delete', 'default', 'llm_tokens', now, now + 30 * 24 * 60 * 60 * 1000, 800, now);
      db.prepare<void>(
        `INSERT INTO settlement_reconciliation_runs (
          id, tenant_id, checked_settlements, mismatched_settlements, repaired_settlements,
          deleted_transactions, inserted_transactions, orphan_transactions_removed,
          report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('recon_privacy_delete', 'default', 1, 1, 1, 4, 3, 0, JSON.stringify({ mismatchedSettlementIds: ['ws_1'] }), now);
      const personaService = new PersonaCoreService(db);
      const persona = personaService.createPersona({
        tenantId: 'default',
        ownerUserId: 'user_privacy_delete',
        displayName: 'Delete Persona',
        initialKnowledge: [{ title: 'Seed', content: 'Delete me' }],
      });
      const task = personaService.publishTask({
        tenantId: 'default',
        publisherUserId: 'user_privacy_delete',
        title: 'Delete Task',
        description: 'Generate tenant-owned marketplace data',
        reward: 15,
      });
      const application = personaService.applyToTask({
        tenantId: 'default',
        ownerUserId: 'user_privacy_delete',
        taskId: task.id,
        personaId: persona.id,
      });
      const assignment = personaService.assignTask({
        tenantId: 'default',
        actorUserId: 'user_privacy_delete',
        taskId: task.id,
        personaId: persona.id,
      });
      assert.ok(application);
      assert.ok(assignment);
      personaService.submitTaskResult({
        tenantId: 'default',
        ownerUserId: 'user_privacy_delete',
        taskId: task.id,
        assignmentId: assignment!.id,
        resultUri: 'memory://privacy-delete/result.json',
        evaluation: { summary: 'privacy delete flow' },
      });
      personaService.acceptSubmittedTask({
        tenantId: 'default',
        actorUserId: 'user_privacy_delete',
        taskId: task.id,
        clientRating: 5,
        qualityScore: 0.95,
      });
      personaService.requestWalletPayout({
        tenantId: 'default',
        ownerUserId: 'user_privacy_delete',
        walletId: persona.wallet.id,
        amountMinor: 300,
      });
      db.prepare<void>(
        `INSERT INTO persona_transfers (
          id, tenant_id, persona_id, from_owner_user_id, to_owner_user_id, status, reason, requested_at, approved_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('ptr_delete', 'default', persona.id, 'user_privacy_delete', 'user_privacy_delete_target', 'completed', 'privacy delete', now, now, now);
      db.prepare<void>(
        `INSERT INTO persona_daily_metrics (
          tenant_id, persona_id, metric_date, tasks_completed, revenue, reputation_score, growth_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('default', persona.id, '2026-03-13', 1, 15, 56, 1.5);
      db.prepare<void>(
        `INSERT INTO marketplace_daily_metrics (
          tenant_id, metric_date, open_tasks, completed_tasks, gross_volume, active_personas
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('default', '2026-03-13', 0, 1, 15, 1);

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/privacy/data' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.deleted, true);
      assert.ok(body.data.timestamp);

      /* 验证数据已清空 */
      assert.equal(os.core.values.getAll().size, 0);
      assert.equal(os.core.memories.getAllMemories().size, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_core WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_wallets WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_forks WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_memory_nodes WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_memory_edges WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_working_memory WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_memories WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_knowledge_items WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM marketplace_tasks WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM task_applications WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM task_assignments WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM task_results WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM wallet_transactions WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM wallet_payout_requests WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM wallet_settlements WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_growth_events WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_governance_events WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_transfers WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM reputation_history WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM persona_daily_metrics WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM marketplace_daily_metrics WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM organizations WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM workspaces WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM organization_memberships WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM organization_role_bindings WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM subscriptions WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM billing_invoices WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM usage_meters WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM settlement_reconciliation_runs WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM identities WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM devices WHERE tenant_id = ?').get('default')?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM avatars').get()?.count ?? 0, 0);
      assert.equal(db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM device_avatars').get()?.count ?? 0, 0);
    });
  });

  describe('GET /api/v1/privacy/audit-trail', () => {
    it('返回审计日志', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/privacy/audit-trail' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
    });
  });
});
