/**
 * 单元测试：github-learn 队列 handler。
 *
 * 断言重点：
 *   1. **跨租户隔离（首要安全不变量）**——handler 必须用 task.tenantId 装配 ReadPort，
 *      绝不可用默认租户，否则会拿 A 的凭据读、或把 B 的内容学进 A 的记忆；
 *   2. payload 解析与 learn 调用参数正确；
 *   3. 装配失败（未连 GitHub）→ 不抛错（否则任务无限重试耗尽），静默完成；
 *   4. 畸形 payload → 不抛错（重试多少次都不会变好）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGithubLearnTaskHandler, GITHUB_LEARN_TASK_TYPE,
} from '../../integrations/github/github-learn-task-handler.js';
import { SilentLogger } from '../../utils/logger.js';
import type { TaskRecord } from '../../queue/task-queue.js';

/** 造一条最小 TaskRecord（只填 handler 会读的字段）。 */
function task(tenantId: string, payload: unknown): TaskRecord {
  return {
    id: 'task_1', tenantId, type: GITHUB_LEARN_TASK_TYPE, payload: JSON.stringify(payload),
    status: 'running', result: null, error: null, retryCount: 0, maxRetries: 3,
    createdAt: 0, updatedAt: 0, availableAt: 0, claimedBy: null, claimedAt: null,
  } as TaskRecord;
}

const SIGNAL = new AbortController().signal;

describe('github-learn 队列 handler', () => {
  it('安全不变量：用 task.tenantId 装配 ReadPort（绝不用默认租户）', async () => {
    const seenTenants: string[] = [];
    const handler = createGithubLearnTaskHandler({
      assemble: (tenantId) => { seenTenants.push(tenantId); return { failure: 'no-credential' }; },
      learn: async () => { /* 装配失败不会走到这 */ },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_B', { repo: 'acme/widgets', resourceType: 'issues' }), SIGNAL);

    assert.deepEqual(seenTenants, ['tenant_B'], '必须用任务自带租户，不得用 default');
  });

  it('装配成功 → 以正确参数调 learn', async () => {
    const calls: Array<{ tenantId: string; repo: string; resourceTypes: string[] }> = [];
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ readPort: {} as never }),
      learn: async (tenantId, _readPort, repo, resourceTypes) => {
        calls.push({ tenantId, repo, resourceTypes: [...resourceTypes] });
      },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { repo: 'acme/widgets', resourceType: 'pulls' }), SIGNAL);

    assert.deepEqual(calls, [{ tenantId: 'tenant_A', repo: 'acme/widgets', resourceTypes: ['pulls'] }]);
  });

  it('未连 GitHub（装配失败）→ 不抛错（否则任务无限重试）', async () => {
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ failure: 'no-installation' }),
      learn: async () => { throw new Error('不该被调'); },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { repo: 'acme/widgets', resourceType: 'issues' }), SIGNAL);
    assert.ok(true, '装配失败静默完成');
  });

  it('畸形 payload → 不抛错，且不调 learn', async () => {
    let learnCalled = false;
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ readPort: {} as never }),
      learn: async () => { learnCalled = true; },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { nonsense: true }), SIGNAL);

    assert.equal(learnCalled, false, '畸形 payload 不该触发学习');
  });

  it('非法 resourceType → 不调 learn（防越权学未支持资源）', async () => {
    let learnCalled = false;
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ readPort: {} as never }),
      learn: async () => { learnCalled = true; },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { repo: 'acme/widgets', resourceType: 'commits' }), SIGNAL);

    assert.equal(learnCalled, false, 'commits 不由 webhook 即时学（走 push 降频路径）');
  });
});
