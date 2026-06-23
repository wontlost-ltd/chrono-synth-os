import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { AUDIT_ROUTING_RULES, categorizeAuditEvent, DbAuditRouter } from '../../data-plane/audit-router.js';
import type { IDatabase } from '../../storage/database.js';
import { TestClock } from '../../utils/clock.js';

describe('categorizeAuditEvent', () => {
  it("'persona.drift' → 'tenant_data'", () => {
    assert.equal(categorizeAuditEvent('persona.drift'), 'tenant_data');
  });

  it("'billing.charge' → 'platform_ops'", () => {
    assert.equal(categorizeAuditEvent('billing.charge'), 'platform_ops');
  });

  it("'unknown.event' → 'platform_ops' (default)", () => {
    assert.equal(categorizeAuditEvent('unknown.event'), 'platform_ops');
  });

  it("'identity.user_created' → 'tenant_data'", () => {
    assert.equal(categorizeAuditEvent('identity.user_created'), 'tenant_data');
  });

  it("'export.started' → 'tenant_data'", () => {
    assert.equal(categorizeAuditEvent('export.started'), 'tenant_data');
  });

  it('covers all AUDIT_ROUTING_RULES prefixes', () => {
    for (const rule of AUDIT_ROUTING_RULES) {
      assert.equal(categorizeAuditEvent(`${rule.eventTypePrefix}x`), rule.category);
    }
  });
});

describe('DbAuditRouter', () => {
  let db: IDatabase;
  let router: DbAuditRouter;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    router = new DbAuditRouter(db);
  });

  it('routeTenantAudit() writes to audit_log', () => {
    router.routeTenantAudit('tenant-1', 'persona.updated', { personaId: 'p1' });
    const rows = db.prepare<{ action_type: string; tenant_id: string }>(
      "SELECT action_type, tenant_id FROM audit_log WHERE action_type = 'persona.updated'",
    ).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant_id, 'tenant-1');
  });

  it('routeTenantAudit() persists payload_json correctly', () => {
    router.routeTenantAudit('tenant-1', 'persona.updated', { personaId: 'px', count: 5 });

    const row = db.prepare<{ payload_json: string }>(
      "SELECT payload_json FROM audit_log WHERE action_type = 'persona.updated'",
    ).get();

    assert.ok(row);
    assert.deepEqual(JSON.parse(row.payload_json), { personaId: 'px', count: 5 });
  });

  it('routeTenantAudit() does not write to platform_ops_log', () => {
    router.routeTenantAudit('tenant-1', 'persona.updated', { personaId: 'p1' });

    const row = db.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_ops_log',
    ).get();

    assert.equal(row?.count, 0);
  });

  it('routePlatformOps() writes to platform_ops_log', () => {
    router.routePlatformOps('metrics.flush', { count: 42 });
    const rows = db.prepare<{ event_type: string }>(
      "SELECT event_type FROM platform_ops_log WHERE event_type = 'metrics.flush'",
    ).all();
    assert.equal(rows.length, 1);
  });

  it('routePlatformOps() does not write to audit_log', () => {
    router.routePlatformOps('metrics.flush', { count: 42 });

    const row = db.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM audit_log',
    ).get();

    assert.equal(row?.count, 0);
  });

  it('multiple tenant events are isolated by tenantId', () => {
    router.routeTenantAudit('tenant-a', 'memory.added', {});
    router.routeTenantAudit('tenant-b', 'memory.added', {});
    const rows = db.prepare<{ tenant_id: string }>(
      "SELECT tenant_id FROM audit_log WHERE action_type = 'memory.added'",
    ).all();
    assert.equal(rows.length, 2);
    const tenants = rows.map(r => r.tenant_id).sort();
    assert.deepEqual(tenants, ['tenant-a', 'tenant-b']);
  });

  it('注入 Clock 时审计时间戳确定可复现（确定性 P1）', () => {
    const fixed = 1_700_000_000_000;
    const det = new DbAuditRouter(db, new TestClock(fixed));
    det.routeTenantAudit('tenant-det', 'persona.updated', { x: 1 });
    det.routePlatformOps('metrics.flush', { y: 2 });

    const auditTs = db.prepare<{ timestamp: number }>(
      "SELECT timestamp FROM audit_log WHERE action_type = 'persona.updated' AND tenant_id = 'tenant-det'",
    ).get();
    assert.equal(Number(auditTs?.timestamp), fixed, 'audit_log timestamp 须等于注入时钟');

    const opsTs = db.prepare<{ occurred_at: number }>(
      "SELECT occurred_at FROM platform_ops_log WHERE event_type = 'metrics.flush'",
    ).get();
    assert.equal(Number(opsTs?.occurred_at), fixed, 'platform_ops_log occurred_at 须等于注入时钟');
  });
});
