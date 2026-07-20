/**
 * github.review — 对 GitHub PR 发一条 COMMENT 型 review（highRisk 对外写工具，Plan 4 发布段）
 *
 * 安全约束（与 github-comment-tool 同款「highRisk 对外写工具」范式）：
 *  - metadata.highRisk=true 且 isHighRisk() 恒 true —— 经 ToolInvocationPipeline 调用时
 *    强制 confirmation gate（不可降级人工审批门）。Task 5 publish 端点靠这个恒高危做
 *    「真发前必人工确认」。
 *  - 本工具是 GitHubWritePort（唯一能写 GitHub 的模块）的**唯一持有者之一**（另一是
 *    github-comment-tool）。除这两个工具 + 组合根（app.ts）+ 其单测，别处不 import
 *    github-write-port（Task 6 架构测试锁死）。
 *  - 对外写全经注入的 WritePort（内部经 githubFetch SSRF 网关），本工具**不自己 fetch**。
 *  - event 首版锁死 `'COMMENT'`（不做 APPROVE / REQUEST_CHANGES 这种更高危动作，避免
 *    数字人误批准 PR）——WritePort.createReview 的 event 参数类型上就锁死该字面量。
 *
 * WritePort 是 per-tenant 装配（App 凭据 → installation token）。故构造注入的是
 *   `writePortResolver: (tenantId) => GitHubWritePort`——invoke 时按 ctx.tenantId 解析。
 */

import { Buffer } from 'node:buffer';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { GitHubWritePortResolver } from './github-comment-tool.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

/** github 写工具默认超时（对外 POST，给足网络余量）。 */
const WRITE_TIMEOUT_MS = 30_000;

export class GithubReviewTool implements ToolAdapter {
  readonly metadata = {
    id: 'github.review',
    displayName: 'GitHub PR 审阅（COMMENT）',
    description: '对指定 GitHub PR 发一条 COMMENT 型 review；对外不可逆写操作，强制人工确认',
    highRisk: true,
    defaultTimeoutMs: WRITE_TIMEOUT_MS,
    defaultMaxPerDay: 50,
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name', minLength: 1, maxLength: 200 },
        prNumber: { type: 'number', description: '目标 PR 编号', minimum: 1 },
        body: { type: 'string', description: 'review 正文', minLength: 1, maxLength: 65_536 },
      },
      required: ['repo', 'prNumber', 'body'],
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
    const prNumber = requirePositiveInt(ctx.arguments, 'prNumber');
    const body = requireBody(ctx.arguments);

    /* 按本租户解析 WritePort → 经 SSRF 网关真写；event 首版锁死 COMMENT。 */
    const writePort = this.resolveWritePort(ctx.tenantId);
    const result = await writePort.createReview(repo, prNumber, body, 'COMMENT');
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

/** body：review 正文，非空。 */
function requireBody(args: Record<string, unknown>): string {
  const value = args['body'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('参数 body 必须为非空字符串', ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

/** 正整数（PR 编号）。 */
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
