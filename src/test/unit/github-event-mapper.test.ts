/**
 * 单元测试：GitHub webhook 事件 → 学习意图映射（纯函数，无 IO）。
 *
 * 断言重点：
 *   1. 六类讨论事件正确映射到 issues/pulls/code 资源类型；
 *   2. push **不**映射为入队学习，而是 mark-commits（降频聚合——活跃组织每天几百次
 *      push，逐次调 LLM 老师会烧额度，且 fix typo/wip 稀释记忆）；
 *   3. discussion 明确忽略（ReadPort 无 GraphQL 支持，入队必败耗尽重试）；
 *   4. 畸形 payload（缺 repository/number）不抛错，退化为 ignore。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapWebhookEventToLearnIntent } from '../../integrations/github/github-event-mapper.js';
import type { GithubWebhookPayload } from '../../server/routes/github-webhook.js';

const REPO = { full_name: 'acme/widgets' };

describe('GitHub webhook 事件 → 学习意图映射', () => {
  it('issues 事件（opened/edited/closed）→ 学 issues', () => {
    for (const action of ['opened', 'edited', 'closed']) {
      const intent = mapWebhookEventToLearnIntent('issues', {
        action, repository: REPO, issue: { number: 42 },
      } as GithubWebhookPayload);
      assert.deepEqual(
        intent,
        { kind: 'learn', resourceType: 'issues', repo: 'acme/widgets', targetNumber: 42 },
        action,
      );
    }
  });

  it('pull_request 事件 → 学 pulls', () => {
    const intent = mapWebhookEventToLearnIntent('pull_request', {
      action: 'opened', repository: REPO, pull_request: { number: 7 },
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'pulls', repo: 'acme/widgets', targetNumber: 7 });
  });

  it('issue_comment 事件 → 学 issues（讨论演进的主要信号）', () => {
    const intent = mapWebhookEventToLearnIntent('issue_comment', {
      action: 'created', repository: REPO, issue: { number: 42 },
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'issues', repo: 'acme/widgets', targetNumber: 42 });
  });

  it('pull_request_review_comment 事件 → 学 pulls', () => {
    const intent = mapWebhookEventToLearnIntent('pull_request_review_comment', {
      action: 'created', repository: REPO, pull_request: { number: 7 },
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'pulls', repo: 'acme/widgets', targetNumber: 7 });
  });

  it('release 事件 → 学 code', () => {
    const intent = mapWebhookEventToLearnIntent('release', {
      action: 'published', repository: REPO,
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'code', repo: 'acme/widgets' });
  });

  it('push 事件 → mark-commits（不入队；降频交轮转批量聚合学）', () => {
    const intent = mapWebhookEventToLearnIntent('push', { repository: REPO } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'mark-commits', repo: 'acme/widgets' });
  });

  it('discussion 事件 → ignore（ReadPort 无 GraphQL 支持，入队必败）', () => {
    const intent = mapWebhookEventToLearnIntent('discussion', {
      action: 'created', repository: REPO,
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'ignore' });
  });

  it('未知事件 → ignore', () => {
    const intent = mapWebhookEventToLearnIntent('star', {
      action: 'created', repository: REPO,
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'ignore' });
  });

  it('缺 repository.full_name → ignore（畸形 payload 不抛错）', () => {
    const intent = mapWebhookEventToLearnIntent('issues', {
      action: 'opened', issue: { number: 1 },
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'ignore' });
  });

  it('缺 issue.number → ignore（无从定位学什么）', () => {
    const intent = mapWebhookEventToLearnIntent('issues', {
      action: 'opened', repository: REPO,
    } as GithubWebhookPayload);
    assert.deepEqual(intent, { kind: 'ignore' });
  });
});
