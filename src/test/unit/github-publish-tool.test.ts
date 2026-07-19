/**
 * 单元测试：github 写工具（GithubCommentTool / GithubReviewTool，Plan 4 发布段）
 *
 * 这两个工具是整个 GitHub 集成里 GitHubWritePort（Task 3，唯一能写 GitHub 的模块）
 *   的**唯一持有者**：经 ToolInvocationPipeline 调用时 metadata.highRisk=true 触发
 *   pipeline 的 confirmation gate（不可降级人工审批门）。Task 5 publish 端点靠这个恒
 *   高危做「真发前必人工确认」。
 *
 * 本测试 mock WritePort（不真连 GitHub），断言：
 *   - 两工具 metadata.highRisk === true 且 isHighRisk() 恒 true（恒高危，不因参数降级）；
 *   - github.comment invoke 从 ctx.arguments 取 repo/issueNumber/body → 调
 *     writePort.createIssueComment(repo, issueNumber, body)（参数透传）；
 *   - github.review invoke → 调 writePort.createReview(repo, prNumber, body, 'COMMENT')；
 *   - invoke 返回 wrapJson，content 里含底层 WritePort 返回的 {id, htmlUrl}；
 *   - 缺参数（args 缺 body / 缺 number）→ 校验抛错，且不调 WritePort。
 *
 * WritePort 是 per-tenant 装配（App 凭据 → installation token），故工具构造注入的是
 *   `writePortResolver: (tenantId) => GitHubWritePort`——invoke 时按 ctx.tenantId 解析。
 *   测试断言 resolver 收到的 tenantId 与 ctx 一致（多租户隔离）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GithubCommentTool } from '../../agent/tools/github-comment-tool.js';
import { GithubReviewTool } from '../../agent/tools/github-review-tool.js';
import type {
  GitHubWritePort,
  GitHubWriteResult,
} from '../../integrations/github/github-write-port.js';
import type { ToolInvocationContext } from '../../agent/tool-adapter.js';

/** 记录 WritePort 调用的 spy（不真连 GitHub）。 */
interface CommentCall {
  repo: string;
  issueNumber: number;
  body: string;
}
interface ReviewCall {
  repo: string;
  prNumber: number;
  body: string;
  event: string;
}
function makeWritePortSpy(result: GitHubWriteResult): {
  comments: CommentCall[];
  reviews: ReviewCall[];
  port: GitHubWritePort;
} {
  const comments: CommentCall[] = [];
  const reviews: ReviewCall[] = [];
  const port: GitHubWritePort = {
    async createIssueComment(repo, issueNumber, body) {
      comments.push({ repo, issueNumber, body });
      return result;
    },
    async createReview(repo, prNumber, body, event) {
      reviews.push({ repo, prNumber, body, event });
      return result;
    },
  };
  return { comments, reviews, port };
}

/** 记录 resolver 收到的 tenantId（校验多租户按 ctx.tenantId 解析）。 */
function makeResolver(port: GitHubWritePort): {
  seenTenants: string[];
  resolver: (tenantId: string) => GitHubWritePort;
} {
  const seenTenants: string[] = [];
  return {
    seenTenants,
    resolver: (tenantId: string) => {
      seenTenants.push(tenantId);
      return port;
    },
  };
}

/** 构造一个最小 ToolInvocationContext（pipeline 已完成前置检查）。 */
function makeCtx(args: Record<string, unknown>, tenantId = 'tenant-a'): ToolInvocationContext {
  return {
    tenantId,
    personaId: 'default',
    invokerType: 'internal',
    invokerId: 'user-1',
    arguments: args,
    deadline: Date.now() + 30_000,
  };
}

/** 从 ToolInvocationResult 取第一个 json content 的 json。 */
function jsonOf(result: { content: readonly { type: string; json?: unknown }[] }): unknown {
  const item = result.content.find((c) => c.type === 'json');
  return item?.json;
}

describe('github 写工具（highRisk，唯一持 WritePort）', () => {
  it('两工具 metadata.highRisk === true 且 isHighRisk() 恒 true', () => {
    const { port } = makeWritePortSpy({ id: 1, htmlUrl: 'https://x/1' });
    const { resolver } = makeResolver(port);
    const comment = new GithubCommentTool(resolver);
    const review = new GithubReviewTool(resolver);

    assert.equal(comment.metadata.id, 'github.comment');
    assert.equal(review.metadata.id, 'github.review');
    assert.equal(comment.metadata.highRisk, true);
    assert.equal(review.metadata.highRisk, true);
    /* 恒高危：不因参数降级（pipeline 据此强制 confirmation）。 */
    assert.equal(comment.isHighRisk?.(), true);
    assert.equal(review.isHighRisk?.(), true);
  });

  it('github.comment invoke 调 writePort.createIssueComment（repo/issueNumber/body 透传）', async () => {
    const spy = makeWritePortSpy({
      id: 12345,
      htmlUrl: 'https://github.com/owner/repo/issues/7#issuecomment-12345',
    });
    const { seenTenants, resolver } = makeResolver(spy.port);
    const tool = new GithubCommentTool(resolver);

    const out = await tool.invoke(
      makeCtx({ repo: 'owner/repo', issueNumber: 7, body: '这是一条自动回评' }, 'tenant-x'),
    );

    /* 参数透传给 WritePort。 */
    assert.equal(spy.comments.length, 1);
    assert.deepEqual(spy.comments[0], {
      repo: 'owner/repo',
      issueNumber: 7,
      body: '这是一条自动回评',
    });
    /* resolver 按 ctx.tenantId 解析（多租户隔离）。 */
    assert.deepEqual(seenTenants, ['tenant-x']);
    /* review 分支未被调。 */
    assert.equal(spy.reviews.length, 0);
    /* 返回 wrapJson 含 id/htmlUrl。 */
    assert.deepEqual(jsonOf(out), {
      id: 12345,
      htmlUrl: 'https://github.com/owner/repo/issues/7#issuecomment-12345',
    });
  });

  it("github.review invoke 调 writePort.createReview(..., 'COMMENT')", async () => {
    const spy = makeWritePortSpy({
      id: 98765,
      htmlUrl: 'https://github.com/owner/repo/pull/11#pullrequestreview-98765',
    });
    const { seenTenants, resolver } = makeResolver(spy.port);
    const tool = new GithubReviewTool(resolver);

    const out = await tool.invoke(
      makeCtx({ repo: 'owner/repo', prNumber: 11, body: '整体没问题，几处小建议' }, 'tenant-y'),
    );

    assert.equal(spy.reviews.length, 1);
    assert.deepEqual(spy.reviews[0], {
      repo: 'owner/repo',
      prNumber: 11,
      body: '整体没问题，几处小建议',
      /* event 首版锁死 COMMENT（不做 APPROVE/REQUEST_CHANGES）。 */
      event: 'COMMENT',
    });
    assert.deepEqual(seenTenants, ['tenant-y']);
    assert.equal(spy.comments.length, 0);
    assert.deepEqual(jsonOf(out), {
      id: 98765,
      htmlUrl: 'https://github.com/owner/repo/pull/11#pullrequestreview-98765',
    });
  });

  it('github.comment 缺 body → 校验抛错且不调 WritePort', async () => {
    const spy = makeWritePortSpy({ id: 1, htmlUrl: 'https://x/1' });
    const { resolver } = makeResolver(spy.port);
    const tool = new GithubCommentTool(resolver);

    await assert.rejects(
      () => tool.invoke(makeCtx({ repo: 'owner/repo', issueNumber: 7 })),
      /body/i,
    );
    assert.equal(spy.comments.length, 0, '校验失败时不应调 WritePort');
  });

  it('github.comment 缺 issueNumber → 校验抛错且不调 WritePort', async () => {
    const spy = makeWritePortSpy({ id: 1, htmlUrl: 'https://x/1' });
    const { resolver } = makeResolver(spy.port);
    const tool = new GithubCommentTool(resolver);

    await assert.rejects(
      () => tool.invoke(makeCtx({ repo: 'owner/repo', body: 'x' })),
      /issueNumber|number|整数|number/i,
    );
    assert.equal(spy.comments.length, 0);
  });

  it('github.review 缺 body → 校验抛错且不调 WritePort', async () => {
    const spy = makeWritePortSpy({ id: 1, htmlUrl: 'https://x/1' });
    const { resolver } = makeResolver(spy.port);
    const tool = new GithubReviewTool(resolver);

    await assert.rejects(
      () => tool.invoke(makeCtx({ repo: 'owner/repo', prNumber: 11 })),
      /body/i,
    );
    assert.equal(spy.reviews.length, 0);
  });
});
