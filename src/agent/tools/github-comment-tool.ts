/**
 * github.comment — 对 GitHub issue 发一条评论（highRisk 对外写工具，Plan 4 发布段）
 *
 * 安全约束（与 email-tool 同款「highRisk 对外写工具」范式）：
 *  - metadata.highRisk=true 且 isHighRisk() 恒 true —— 经 ToolInvocationPipeline 调用时
 *    强制 confirmation gate（不可降级人工审批门；token 服务端签发 + input-hash 绑定 +
 *    一次性）。Task 5 publish 端点靠这个恒高危做「真发前必人工确认」。
 *  - 本工具是 GitHubWritePort（唯一能写 GitHub 的模块）的**唯一持有者之一**（另一是
 *    github-review-tool）。除这两个工具 + 组合根（app.ts）+ 其单测，别处不 import
 *    github-write-port（Task 6 架构测试锁死）。
 *  - 对外写全经注入的 WritePort（内部经 githubFetch SSRF 网关），本工具**不自己 fetch**。
 *
 * WritePort 是 per-tenant 装配（App 凭据 → installation token，见 learn-github 的
 *   assembleReadPort 同款路径）。故构造注入的是 `writePortResolver: (tenantId) =>
 *   GitHubWritePort`——invoke 时按 ctx.tenantId 解析本租户的 WritePort，保证多租户隔离。
 */

import { Buffer } from 'node:buffer';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { GitHubWritePort } from '../../integrations/github/github-write-port.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

/** 按 ctx.tenantId 解析本租户 GitHubWritePort（per-tenant App 凭据装配）。 */
export type GitHubWritePortResolver = (tenantId: string) => GitHubWritePort;

/** github 写工具默认超时（对外 POST，给足网络余量）。 */
const WRITE_TIMEOUT_MS = 30_000;

export class GithubCommentTool implements ToolAdapter {
  readonly metadata = {
    id: 'github.comment',
    displayName: 'GitHub Issue 回评',
    description: '对指定 GitHub issue 发一条评论；对外不可逆写操作，强制人工确认',
    highRisk: true,
    defaultTimeoutMs: WRITE_TIMEOUT_MS,
    defaultMaxPerDay: 50,
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name', minLength: 1, maxLength: 200 },
        issueNumber: { type: 'number', description: '目标 issue 编号', minimum: 1 },
        body: { type: 'string', description: '评论正文', minLength: 1, maxLength: 65_536 },
      },
      required: ['repo', 'issueNumber', 'body'],
      additionalProperties: false,
    },
  };

  constructor(private readonly resolveWritePort: GitHubWritePortResolver) {}

  /** 恒高危：不因参数降级——pipeline 据此强制 confirmation（不可降级人工审批门）。 */
  isHighRisk(): boolean {
    return true;
  }

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const repo = requireRepo(ctx.arguments);
    const issueNumber = requirePositiveInt(ctx.arguments, 'issueNumber');
    const body = requireBody(ctx.arguments);

    /* 按本租户解析 WritePort（per-tenant App 凭据 → installation token）→ 经 SSRF 网关真写。 */
    const writePort = this.resolveWritePort(ctx.tenantId);
    const result = await writePort.createIssueComment(repo, issueNumber, body);
    return wrapJson({ id: result.id, htmlUrl: result.htmlUrl });
  }
}

/** repo：owner/name，非空。 */
function requireRepo(args: Record<string, unknown>): string {
  const value = args['repo'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('参数 repo 必须为非空字符串（owner/name）', ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

/** body：评论正文，非空。 */
function requireBody(args: Record<string, unknown>): string {
  const value = args['body'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('参数 body 必须为非空字符串', ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

/** 正整数（issue / PR 编号）。 */
function requirePositiveInt(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`参数 ${key} 必须为正整数`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}

/** 标准化 JSON 结果（照 email-tool wrapJson）。 */
function wrapJson(json: unknown): ToolInvocationResult {
  const text = JSON.stringify(json);
  return {
    content: [{ type: 'json', json }],
    costCents: 0,
    outputSizeBytes: Buffer.byteLength(text, 'utf8'),
  };
}
