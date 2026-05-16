/**
 * AvatarAutorunStore 与 KnowledgeSourceStore 单元测试
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { AvatarAutorunStore } from '../../storage/avatar-autorun-store.js';
import { KnowledgeSourceStore } from '../../storage/knowledge-source-store.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';

describe('AvatarAutorunStore', () => {
  let db: IDatabase;
  let store: AvatarAutorunStore;
  let avatarId: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new AvatarAutorunStore(db);

    /* 创建 identity + avatar 满足外键约束 */
    const identityService = new IdentityService(db);
    const avatarService = new AvatarService(db);
    const identity = identityService.create('user_1', 'tenant_1', '测试用户');
    const avatar = avatarService.create(identity.id, { label: '测试分身', kind: 'work' });
    avatarId = avatar.id;
  });

  describe('配置管理', () => {
    it('upsertConfig 创建新配置', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 3600000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: ['ks_1', 'ks_2'],
      });

      assert.ok(config.id);
      assert.equal(config.tenantId, 'tenant_1');
      assert.equal(config.avatarId, avatarId);
      assert.equal(config.enabled, true);
      assert.equal(config.intervalMs, 3600000);
      assert.equal(config.driftThreshold, 0.3);
      assert.deepEqual(config.knowledgeSourceIds, ['ks_1', 'ks_2']);
    });

    it('upsertConfig 更新已有配置', () => {
      store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 3600000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      const updated = store.upsertConfig('tenant_1', avatarId, {
        enabled: false,
        intervalMs: 7200000,
        driftThreshold: 0.5,
        reviewRequired: true,
        knowledgeSourceIds: ['ks_3'],
      });

      assert.equal(updated.enabled, false);
      assert.equal(updated.intervalMs, 7200000);
      assert.equal(updated.driftThreshold, 0.5);
      assert.deepEqual(updated.knowledgeSourceIds, ['ks_3']);
    });

    it('getConfig 返回配置', () => {
      store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 3600000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      const config = store.getConfig('tenant_1', avatarId);
      assert.ok(config);
      assert.equal(config!.avatarId, avatarId);
    });

    it('getConfig 不存在时返回 null', () => {
      assert.equal(store.getConfig('tenant_1', 'nonexistent'), null);
    });

    it('getConfigById 返回配置', () => {
      const created = store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 3600000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      const config = store.getConfigById(created.id);
      assert.ok(config);
      assert.equal(config!.id, created.id);
    });
  });

  describe('到期扫描与 CAS 抢占', () => {
    it('listDueConfigs 返回到期且启用的配置', () => {
      const now = Date.now();
      store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 60000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      /* next_run_at = now + intervalMs，传入远大于此的时间 */
      const due = store.listDueConfigs(now + 120000, 10);
      assert.equal(due.length, 1);
      assert.equal(due[0].avatarId, avatarId);
    });

    it('listDueConfigs 跳过禁用的配置', () => {
      store.upsertConfig('tenant_1', avatarId, {
        enabled: false,
        intervalMs: 60000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      const due = store.listDueConfigs(Date.now() + 120000, 10);
      assert.equal(due.length, 0);
    });

    it('claimConfig CAS 成功', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true,
        intervalMs: 60000,
        driftThreshold: 0.3,
        reviewRequired: false,
        knowledgeSourceIds: [],
      });

      const future = Date.now() + 120000;
      const nextRunAt = future + 60000;
      assert.equal(store.claimConfig(config.id, future, nextRunAt), true);

      /* 再次抢占应失败（next_run_at 已推进到 nextRunAt） */
      assert.equal(store.claimConfig(config.id, future, nextRunAt + 60000), false);
    });
  });

  describe('配置辅助操作', () => {
    it('updateDriftCheckTime 和 updateLastError 持久化配置字段', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true, intervalMs: 60000, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
      });
      const driftCheckedAt = Date.now() + 1_000;

      store.updateDriftCheckTime(config.id, driftCheckedAt);
      store.updateLastError(config.id, 'ingest_failed');

      const updated = store.getConfigById(config.id)!;
      assert.equal(updated.lastDriftCheckAt, driftCheckedAt);
      assert.equal(updated.lastError, 'ingest_failed');

      store.updateLastError(config.id, null);
      const cleared = store.getConfigById(config.id)!;
      assert.equal(cleared.lastError, null);
    });
  });

  describe('运行日志', () => {
    it('创建和查询运行日志', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true, intervalMs: 60000, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
      });

      const run = store.createRunLog({
        tenantId: 'tenant_1',
        avatarId,
        configId: config.id,
        taskId: 'task_1',
        status: 'pending',
      });

      assert.ok(run.id);
      assert.equal(run.status, 'pending');
      assert.equal(run.taskId, 'task_1');

      const fetched = store.getRun(run.id);
      assert.ok(fetched);
      assert.equal(fetched!.id, run.id);
    });

    it('setRunStatus 更新状态和指标', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true, intervalMs: 60000, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
      });

      const run = store.createRunLog({
        tenantId: 'tenant_1',
        avatarId,
        configId: config.id,
        taskId: '',
        status: 'pending',
      });

      store.setRunStatus(run.id, 'running');
      const running = store.getRun(run.id)!;
      assert.equal(running.status, 'running');

      const metrics = {
        memoriesCreated: 5, patternsFound: 0, valuesProposed: 0,
        driftScore: 0.1, knowledgeItemsIngested: 5, knowledgeItemsSkipped: 2,
      };
      store.setRunStatus(run.id, 'completed', metrics);
      const completed = store.getRun(run.id)!;
      assert.equal(completed.status, 'completed');
      assert.ok(completed.metrics);
      assert.equal(completed.metrics!.memoriesCreated, 5);
    });

    it('updateRunTaskId 和非指标状态更新路径生效', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true, intervalMs: 60000, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
      });

      const run = store.createRunLog({
        tenantId: 'tenant_1',
        avatarId,
        configId: config.id,
        taskId: '',
        status: 'pending',
      });

      store.updateRunTaskId(run.id, 'task_42');
      store.setRunStatus(run.id, 'pending');
      const pending = store.getRun(run.id)!;
      assert.equal(pending.taskId, 'task_42');
      assert.equal(pending.status, 'pending');

      store.setRunStatus(run.id, 'skipped', undefined, 'quota_exceeded');
      const skipped = store.getRun(run.id)!;
      assert.equal(skipped.status, 'skipped');
      assert.equal(skipped.error, 'quota_exceeded');
      assert.ok(skipped.completedAt);
    });

    it('listRunsByAvatar 分页', () => {
      const config = store.upsertConfig('tenant_1', avatarId, {
        enabled: true, intervalMs: 60000, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [],
      });

      for (let i = 0; i < 5; i++) {
        store.createRunLog({
          tenantId: 'tenant_1',
          avatarId,
          configId: config.id,
          taskId: `task_${i}`,
          status: 'completed',
        });
      }

      const { runs, total } = store.listRunsByAvatar('tenant_1', avatarId, 2, 0);
      assert.equal(total, 5);
      assert.equal(runs.length, 2);

      const { runs: page2 } = store.listRunsByAvatar('tenant_1', avatarId, 2, 2);
      assert.equal(page2.length, 2);
    });
  });
});

describe('KnowledgeSourceStore', () => {
  let db: IDatabase;
  let store: KnowledgeSourceStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new KnowledgeSourceStore(db);
  });

  it('创建知识源', () => {
    const source = store.create('tenant_1', {
      type: 'rss',
      name: '技术博客',
      configJson: JSON.stringify({ url: 'https://example.com/feed' }),
    });

    assert.ok(source.id);
    assert.equal(source.type, 'rss');
    assert.equal(source.name, '技术博客');
    assert.equal(source.enabled, true);
  });

  it('listByTenant 分页', () => {
    for (let i = 0; i < 3; i++) {
      store.create('tenant_1', {
        type: 'manual',
        name: `源 ${i}`,
        configJson: JSON.stringify({ manualText: `内容 ${i}` }),
      });
    }

    const { sources, total } = store.listByTenant('tenant_1', 10, 0);
    assert.equal(total, 3);
    assert.equal(sources.length, 3);
  });

  it('update 更新名称和启用状态', () => {
    const source = store.create('tenant_1', {
      type: 'api',
      name: '旧名',
      configJson: JSON.stringify({ url: 'https://api.example.com' }),
    });

    const updated = store.update(source.id, 'tenant_1', { name: '新名', enabled: false });
    assert.ok(updated);
    assert.equal(updated!.name, '新名');
    assert.equal(updated!.enabled, false);
  });

  it('delete 删除知识源', () => {
    const source = store.create('tenant_1', {
      type: 'file',
      name: '文件源',
      configJson: JSON.stringify({ fileRef: '/tmp/test.txt' }),
    });

    assert.equal(store.delete(source.id, 'tenant_1'), true);
    assert.equal(store.getById(source.id, 'tenant_1'), null);
  });

  it('delete 不存在返回 false', () => {
    assert.equal(store.delete('nonexistent', 'tenant_1'), false);
  });

  it('listEnabledByIds 只返回启用的', () => {
    const s1 = store.create('tenant_1', { type: 'rss', name: 's1', configJson: '{}' });
    const s2 = store.create('tenant_1', { type: 'api', name: 's2', configJson: '{}' });
    store.update(s2.id, 'tenant_1', { enabled: false });

    const enabled = store.listEnabledByIds('tenant_1', [s1.id, s2.id]);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].id, s1.id);
  });

  it('updateState 更新状态和时间', () => {
    const source = store.create('tenant_1', { type: 'rss', name: 'test', configJson: '{}' });
    const now = Date.now();
    store.updateState(source.id, JSON.stringify({ cursor: 'abc' }), now);

    const updated = store.getById(source.id, 'tenant_1');
    assert.ok(updated);
    assert.equal(JSON.parse(updated!.stateJson!).cursor, 'abc');
  });
});
