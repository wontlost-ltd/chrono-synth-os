import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LSIM_QUERY_BY_ID, LSIM_QUERY_BY_ID_TENANT, LSIM_QUERY_BY_TENANT,
  LSIM_QUERY_COUNT_BY_TENANT, LSIM_QUERY_PAGINATED,
  LSIM_QUERY_PATH_DETAIL, LSIM_QUERY_PATH_DETAIL_TENANT,
  LSIM_QUERY_VARIANTS, LSIM_QUERY_VARIANTS_TENANT, LSIM_QUERY_PATHS_BY_SIM,
  LSIM_CMD_CREATE, LSIM_CMD_SET_STATUS, LSIM_CMD_SET_STATUS_COMPLETED,
  LSIM_CMD_UPDATE_PROGRESS, LSIM_CMD_SAVE_SUMMARY, LSIM_CMD_SAVE_PATH,
  CFG_QUERY_ALL, CFG_QUERY_BY_CATEGORY, CFG_QUERY_BY_KEY,
  CFG_QUERY_AUDIT, CFG_QUERY_AUDIT_BY_KEY,
  CFG_CMD_UPSERT, CFG_CMD_AUDIT_LOG,
} from '@chrono/kernel';
import { LifeSimulationStore } from '../../storage/life-simulation-store.js';
import { ConfigStore } from '../../config/config-store.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveCommandExecutor, resolveQueryExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';

describe('LifeSimulationStore 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部人生模拟 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(LSIM_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_BY_ID_TENANT));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_BY_TENANT));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_COUNT_BY_TENANT));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_PAGINATED));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_PATH_DETAIL));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_PATH_DETAIL_TENANT));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_VARIANTS));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_VARIANTS_TENANT));
    assert.ok(resolveQueryExecutor(LSIM_QUERY_PATHS_BY_SIM));
    assert.ok(resolveCommandExecutor(LSIM_CMD_CREATE));
    assert.ok(resolveCommandExecutor(LSIM_CMD_SET_STATUS));
    assert.ok(resolveCommandExecutor(LSIM_CMD_SET_STATUS_COMPLETED));
    assert.ok(resolveCommandExecutor(LSIM_CMD_UPDATE_PROGRESS));
    assert.ok(resolveCommandExecutor(LSIM_CMD_SAVE_SUMMARY));
    assert.ok(resolveCommandExecutor(LSIM_CMD_SAVE_PATH));
  });

  it('创建模拟并按 ID 查询', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new LifeSimulationStore(db);

    store.create('sim-1', 'tenant-a', 'task-1', { paths: 3, yearsPerPath: 10 } as never);
    const record = store.getById('sim-1');

    assert.ok(record);
    assert.equal(record.id, 'sim-1');
    assert.equal(record.tenantId, 'tenant-a');
    assert.equal(record.status, 'pending');
  });

  it('租户隔离查询与分页', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new LifeSimulationStore(db);

    store.create('sim-a1', 'tenant-a', 'task-1', {} as never);
    store.create('sim-a2', 'tenant-a', 'task-2', {} as never);
    store.create('sim-b1', 'tenant-b', 'task-3', {} as never);

    /* 租户隔离 */
    assert.equal(store.getById('sim-a1', 'tenant-a')?.id, 'sim-a1');
    assert.equal(store.getById('sim-a1', 'tenant-b'), undefined);

    /* 按租户列表 */
    const tenantAList = store.getByTenant('tenant-a');
    assert.equal(tenantAList.length, 2);

    /* 分页 */
    const page = store.getByTenantPaginated('tenant-a', 1, 0);
    assert.equal(page.total, 2);
    assert.equal(page.records.length, 1);
  });

  it('setStatus 和 completed 路径', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new LifeSimulationStore(db);

    store.create('sim-1', 'tenant-a', 'task-1', {} as never);
    store.setStatus('sim-1', 'running');
    assert.equal(store.getById('sim-1')?.status, 'running');

    store.setStatus('sim-1', 'completed');
    const completed = store.getById('sim-1');
    assert.equal(completed?.status, 'completed');
    assert.ok(completed?.completedAt);
  });
});

describe('ConfigStore 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部配置存储 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(CFG_QUERY_ALL));
    assert.ok(resolveQueryExecutor(CFG_QUERY_BY_CATEGORY));
    assert.ok(resolveQueryExecutor(CFG_QUERY_BY_KEY));
    assert.ok(resolveQueryExecutor(CFG_QUERY_AUDIT));
    assert.ok(resolveQueryExecutor(CFG_QUERY_AUDIT_BY_KEY));
    assert.ok(resolveCommandExecutor(CFG_CMD_UPSERT));
    assert.ok(resolveCommandExecutor(CFG_CMD_AUDIT_LOG));
  });

  it('applyPatch 写入配置并生成审计日志', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new ConfigStore(db);

    store.applyPatch({ 'app.name': 'test-app' }, 'admin');
    const item = store.get('app.name');

    assert.ok(item);
    assert.equal(item.value_json, '"test-app"');
    assert.equal(item.updated_by, 'admin');

    const audit = store.getAudit(10);
    assert.ok(audit.length >= 1);
    assert.equal(audit[0].config_key, 'app.name');
  });
});
