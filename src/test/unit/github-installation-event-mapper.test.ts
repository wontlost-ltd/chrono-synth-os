/**
 * 单元测试：installation 类 webhook 事件 → 动作映射（纯函数，无 IO）。
 *
 * 断言重点：
 *   1. deleted/suspend/unsuspend 正确映射；
 *   2. installation_repositories 的 added/removed 解析出仓库全名列表
 *      （该事件只带增量，不带完整列表——合并由 applyRepoDelta 结合现有 repos 列做）；
 *   3. created 映射为 ignore——映射由 setup 回调建立（唯一权威路径，有会话身份）；
 *      created 若特殊放行会与既有 fail-closed 反查形成循环依赖（见 spec §3.3）；
 *   4. 未知 action / 畸形 payload → ignore，不抛错。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapInstallationEvent, applyRepoDelta,
} from '../../integrations/github/github-installation-event-mapper.js';

describe('installation 类事件 → 动作映射', () => {
  it('installation.deleted → delete（卸载即停学）', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'deleted' }), { kind: 'delete' });
  });

  it('installation.suspend → suspend', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'suspend' }), { kind: 'suspend' });
  });

  it('installation.unsuspend → unsuspend', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'unsuspend' }), { kind: 'unsuspend' });
  });

  it('installation.created → ignore（映射由 setup 回调建立，避免循环依赖）', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'created' }), { kind: 'ignore' });
  });

  it('installation_repositories.added → repos-added 携带新增仓库全名', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'added',
      repositories_added: [{ full_name: 'acme/api' }, { full_name: 'acme/web' }],
    });
    assert.deepEqual(action, { kind: 'repos-added', repos: ['acme/api', 'acme/web'] });
  });

  it('installation_repositories.removed → repos-removed 携带移除仓库全名', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'removed',
      repositories_removed: [{ full_name: 'acme/legacy' }],
    });
    assert.deepEqual(action, { kind: 'repos-removed', repos: ['acme/legacy'] });
  });

  it('installation_repositories：丢弃缺 full_name 的畸形条目', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'added',
      repositories_added: [{ full_name: 'acme/api' }, {}, { full_name: '' }],
    });
    assert.deepEqual(action, { kind: 'repos-added', repos: ['acme/api'] });
  });

  it('installation_repositories：空增量 → ignore（无事可做）', () => {
    assert.deepEqual(
      mapInstallationEvent('installation_repositories', { action: 'added', repositories_added: [] }),
      { kind: 'ignore' },
    );
  });

  it('未知 action → ignore', () => {
    assert.deepEqual(
      mapInstallationEvent('installation', { action: 'new_permissions_accepted' }),
      { kind: 'ignore' },
    );
  });

  it('非 installation 类事件 → ignore', () => {
    assert.deepEqual(mapInstallationEvent('issues', { action: 'opened' }), { kind: 'ignore' });
  });

  it('缺 action → ignore（畸形 payload 不抛错）', () => {
    assert.deepEqual(mapInstallationEvent('installation', {}), { kind: 'ignore' });
  });
});

describe('applyRepoDelta（增删应用到现有 repos 列）', () => {
  it('added：合并进现有列表并去重', () => {
    const result = applyRepoDelta('acme/web', { kind: 'repos-added', repos: ['acme/api', 'acme/web'] });
    assert.equal(result, 'acme/web,acme/api', '既有在前、新增在后，重复不加');
  });

  it('added：现有为 null 时直接用新增列表', () => {
    assert.equal(applyRepoDelta(null, { kind: 'repos-added', repos: ['acme/api'] }), 'acme/api');
  });

  it('removed：从现有列表移除', () => {
    assert.equal(
      applyRepoDelta('acme/web,acme/api', { kind: 'repos-removed', repos: ['acme/web'] }),
      'acme/api',
    );
  });

  it('removed：移空后返回 null（列语义 null=未知）', () => {
    assert.equal(applyRepoDelta('acme/web', { kind: 'repos-removed', repos: ['acme/web'] }), null);
  });

  it('非 repos 类动作原样返回现有值', () => {
    assert.equal(applyRepoDelta('acme/web', { kind: 'delete' }), 'acme/web');
  });
});
