import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, renderAllForTarget, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

describe('版本化迁移系统', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  it('首次运行创建 schema_migrations 表和所有业务表', () => {
    runDslSqliteMigrations(db);

    /* 通过查询各表验证存在性（不依赖 sqlite_master 系统表） */
    const migrations = db.prepare<{ version: string }>('SELECT version FROM schema_migrations').all();
    assert.ok(migrations.length > 0, 'schema_migrations 表应存在');

    const values = db.prepare<{ id: string }>('SELECT id FROM core_values LIMIT 0').all();
    assert.ok(Array.isArray(values), 'core_values 表应存在');

    const memories = db.prepare<{ id: string }>('SELECT id FROM memory_nodes LIMIT 0').all();
    assert.ok(Array.isArray(memories), 'memory_nodes 表应存在');

    const personas = db.prepare<{ id: string }>('SELECT id FROM persona_versions LIMIT 0').all();
    assert.ok(Array.isArray(personas), 'persona_versions 表应存在');

    const snapshots = db.prepare<{ id: string }>('SELECT id FROM snapshots LIMIT 0').all();
    assert.ok(Array.isArray(snapshots), 'snapshots 表应存在');

    const observabilityOutbox = db.prepare<{ id: string }>('SELECT id FROM observability_outbox LIMIT 0').all();
    assert.ok(Array.isArray(observabilityOutbox), 'observability_outbox 表应存在');

    const observabilityRollups = db.prepare<{ tenant_id: string }>('SELECT tenant_id FROM observability_rollups LIMIT 0').all();
    assert.ok(Array.isArray(observabilityRollups), 'observability_rollups 表应存在');

    const idempotencyKeys = db.prepare<{ id: string }>('SELECT id FROM idempotency_keys LIMIT 0').all();
    assert.ok(Array.isArray(idempotencyKeys), 'idempotency_keys 表应存在');

    const platformDlq = db.prepare<{ id: string }>('SELECT id FROM platform_dlq_events LIMIT 0').all();
    assert.ok(Array.isArray(platformDlq), 'platform_dlq_events 表应存在');

    const organizations = db.prepare<{ id: string }>('SELECT id FROM organizations LIMIT 0').all();
    assert.ok(Array.isArray(organizations), 'organizations 表应存在');

    const workspaces = db.prepare<{ id: string }>('SELECT id FROM workspaces LIMIT 0').all();
    assert.ok(Array.isArray(workspaces), 'workspaces 表应存在');

    const organizationMemberships = db.prepare<{ id: string }>('SELECT id FROM organization_memberships LIMIT 0').all();
    assert.ok(Array.isArray(organizationMemberships), 'organization_memberships 表应存在');

    const organizationRoleBindings = db.prepare<{ id: string }>('SELECT id FROM organization_role_bindings LIMIT 0').all();
    assert.ok(Array.isArray(organizationRoleBindings), 'organization_role_bindings 表应存在');

    const billingPlans = db.prepare<{ id: string }>('SELECT id FROM billing_plans LIMIT 0').all();
    assert.ok(Array.isArray(billingPlans), 'billing_plans 表应存在');

    const billingInvoices = db.prepare<{ id: string }>('SELECT id FROM billing_invoices LIMIT 0').all();
    assert.ok(Array.isArray(billingInvoices), 'billing_invoices 表应存在');

    const usageMeters = db.prepare<{ id: string }>('SELECT id FROM usage_meters LIMIT 0').all();
    assert.ok(Array.isArray(usageMeters), 'usage_meters 表应存在');

    const reconciliationRuns = db.prepare<{ id: string }>('SELECT id FROM settlement_reconciliation_runs LIMIT 0').all();
    assert.ok(Array.isArray(reconciliationRuns), 'settlement_reconciliation_runs 表应存在');

    const tenantEnterpriseProfiles = db.prepare<{ tenant_id: string }>('SELECT tenant_id FROM tenant_enterprise_profiles LIMIT 0').all();
    assert.ok(Array.isArray(tenantEnterpriseProfiles), 'tenant_enterprise_profiles 表应存在');
  });

  it('记录已应用的迁移版本', () => {
    runDslSqliteMigrations(db);
    const rows = db.prepare<{ version: string; description: string }>(
      'SELECT version, description FROM schema_migrations ORDER BY version',
    ).all();

    assert.equal(rows.length, renderAllForTarget('sqlite-sql').length);
    assert.equal(rows[0].version, 'v001');
    assert.equal(rows[0].description, '初始表结构');
  });

  it('重复执行幂等：不会重新应用已有迁移', () => {
    runDslSqliteMigrations(db);
    runDslSqliteMigrations(db);
    runDslSqliteMigrations(db);

    const rows = db.prepare<{ version: string }>(
      'SELECT version FROM schema_migrations',
    ).all();
    assert.equal(rows.length, renderAllForTarget('sqlite-sql').length);
  });

  it('已有数据的库再次迁移不丢失数据', () => {
    runDslSqliteMigrations(db);

    db.prepare<void>(
      'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
    ).run('v1', 'test-value', 0.5, 1000);

    runDslSqliteMigrations(db);

    const row = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('v1');
    assert.ok(row);
    assert.equal(row.id, 'v1');
  });

  it('迁移渲染结果按版本排序', () => {
    const migrations = renderAllForTarget('sqlite-sql');
    for (let i = 1; i < migrations.length; i++) {
      assert.ok(migrations[i].version > migrations[i - 1].version,
        `迁移 ${migrations[i].version} 应在 ${migrations[i - 1].version} 之后`);
    }
  });

  it('旧 identities 单租户唯一结构可迁移到多用户 tenant 结构', () => {
    db.exec(`CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);

    for (const migration of renderAllForTarget('sqlite-sql').filter((item) => item.version < 'v047')) {
      db.prepare<void>(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    }

    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      tenant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      bio TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE avatars (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES identities(id),
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'general',
      behavior_overrides TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_uid TEXT NOT NULL,
      platform TEXT NOT NULL,
      push_token TEXT,
      app_version TEXT,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE device_avatars (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      UNIQUE(device_id, avatar_id)
    )`);
    db.exec(`CREATE TABLE avatar_autorun_config (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',
      drift_check_interval_ms INTEGER NOT NULL DEFAULT 86400000,
      drift_threshold REAL NOT NULL DEFAULT 0.3,
      review_required INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_drift_check_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE avatar_autorun_runlog (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL,
      config_id TEXT NOT NULL REFERENCES avatar_autorun_config(id),
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      metrics_json TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    )`);

    db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('user_1', 'owner@example.com', 'hash', 'admin', 'tenant_legacy', 1, 1);
    db.prepare<void>(
      'INSERT INTO identities (id, user_id, tenant_id, display_name, bio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('ident_1', 'user_1', 'tenant_legacy', 'Owner', null, 1, 1);
    db.prepare<void>(
      'INSERT INTO avatars (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('avt_1', 'ident_1', '默认', 'general', null, 1, 1, 1, 1);

    runDslSqliteMigrations(db);

    db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('user_2', 'member@example.com', 'hash', 'member', 'tenant_legacy', 2, 2);
    assert.doesNotThrow(() => {
      db.prepare<void>(
        'INSERT INTO identities (id, user_id, tenant_id, display_name, bio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('ident_2', 'user_2', 'tenant_legacy', 'Member', null, 2, 2);
    });

    const rows = db.prepare<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM identities WHERE tenant_id = ? ORDER BY created_at ASC',
    ).all('tenant_legacy');
    assert.deepEqual(rows.map((row) => row.user_id), ['user_1', 'user_2']);
  });
});
