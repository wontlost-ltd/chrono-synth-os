import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BSVC_QUERY_LIST_PLANS, BSVC_QUERY_LATEST_SUB, BSVC_QUERY_RECONCILIATION,
  BSVC_QUERY_INVOICE_BY_PERIOD, BSVC_QUERY_INVOICE_BY_ID, BSVC_QUERY_INVOICES_BY_TENANT,
  BSVC_QUERY_USAGE_METERS, BSVC_QUERY_USAGE_RECORDS_SUMMARY,
  BSVC_CMD_SEED_PLAN, BSVC_CMD_UPDATE_SUB, BSVC_CMD_INSERT_SUB,
  BSVC_CMD_UPDATE_INVOICE, BSVC_CMD_INSERT_INVOICE,
  BSVC_CMD_DELETE_USAGE_METERS, BSVC_CMD_INSERT_USAGE_METER,
  AUDIT_QUERY_BY_ID, AUDIT_QUERY_LIST, AUDIT_QUERY_COUNT,
  AUDIT_CMD_RECORD_REQUEST, AUDIT_CMD_RECORD_BUSINESS,
} from '@chrono/kernel';
import { BillingService } from '../../billing/billing-service.js';
import {
  recordRequestAuditLog, recordBusinessAuditLog, queryAuditLog, countAuditLogs, getAuditLogById,
} from '../../audit/audit-log-store.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveCommandExecutor, resolveQueryExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';

describe('BillingService 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 BillingService query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(BSVC_QUERY_LIST_PLANS));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_LATEST_SUB));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_RECONCILIATION));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_INVOICE_BY_PERIOD));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_INVOICE_BY_ID));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_INVOICES_BY_TENANT));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_USAGE_METERS));
    assert.ok(resolveQueryExecutor(BSVC_QUERY_USAGE_RECORDS_SUMMARY));
    assert.ok(resolveCommandExecutor(BSVC_CMD_SEED_PLAN));
    assert.ok(resolveCommandExecutor(BSVC_CMD_UPDATE_SUB));
    assert.ok(resolveCommandExecutor(BSVC_CMD_INSERT_SUB));
    assert.ok(resolveCommandExecutor(BSVC_CMD_UPDATE_INVOICE));
    assert.ok(resolveCommandExecutor(BSVC_CMD_INSERT_INVOICE));
    assert.ok(resolveCommandExecutor(BSVC_CMD_DELETE_USAGE_METERS));
    assert.ok(resolveCommandExecutor(BSVC_CMD_INSERT_USAGE_METER));
  });

  it('seedBillingPlans 和 listPlans 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const service = new BillingService(db);

    const plans = service.listPlans();
    assert.ok(plans.length >= 3);
    assert.ok(plans.some(p => p.id === 'free'));
    assert.ok(plans.some(p => p.id === 'starter'));
    assert.ok(plans.some(p => p.id === 'growth'));
  });

  it('subscribeTenant 创建订阅并生成发票', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const service = new BillingService(db);

    const result = service.subscribeTenant('tenant-a', 'free');
    assert.equal(result.subscription.tenantId, 'tenant-a');
    assert.equal(result.subscription.planId, 'free');
    assert.equal(result.invoice.planId, 'free');
    assert.equal(result.invoice.status, 'paid');
  });
});

describe('AuditLogStore 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部审计日志 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(AUDIT_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(AUDIT_QUERY_LIST));
    assert.ok(resolveQueryExecutor(AUDIT_QUERY_COUNT));
    assert.ok(resolveCommandExecutor(AUDIT_CMD_RECORD_REQUEST));
    assert.ok(resolveCommandExecutor(AUDIT_CMD_RECORD_BUSINESS));
  });

  it('recordRequestAuditLog 和 queryAuditLog 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);

    recordRequestAuditLog(db, {
      tenantId: 'tenant-a',
      requestId: 'req-1',
      method: 'GET',
      path: '/api/v1/test',
      statusCode: 200,
      latencyMs: 42.5,
      actionType: 'read',
    });

    const logs = queryAuditLog(db, { tenantId: 'tenant-a' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].method, 'GET');
    assert.equal(logs[0].statusCode, 200);

    const count = countAuditLogs(db, { tenantId: 'tenant-a' });
    assert.equal(count, 1);
  });

  it('recordBusinessAuditLog 和 getAuditLogById 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);

    const id = recordBusinessAuditLog(db, {
      tenantId: 'tenant-a',
      actorType: 'user',
      actorId: 'user-1',
      actionType: 'create',
      targetType: 'avatar',
      targetId: 'avatar-1',
    });

    const record = getAuditLogById(db, 'tenant-a', id);
    assert.ok(record);
    assert.equal(record.eventKind, 'business');
    assert.equal(record.actorId, 'user-1');
    assert.equal(record.targetType, 'avatar');
  });
});
